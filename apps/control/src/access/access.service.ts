import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AccessPolicy,
  type AccessRequestView,
  type Bundle,
  BundleTarget,
  type CreateBundle,
  type CreateRequest,
  type DecideRequest,
  type GrantView,
  type IdentityRef,
  type PreviewRequest,
  type ReportTarget,
  type RequestPreview,
  type UpdateBundle,
} from '@landbright/contracts';
import { type Config } from '@landbright/platform';
import { appendAudit, CONFIG, Prisma } from '@landbright/persistence';
import { audited, type Principal, type ServicePrincipal } from '../common/principal';
import { TenantDb, uniquely } from '../common/tenant-db';
import { toRef } from '../directory/mapping';
import { closeGrant, createGrant, type NamedApprover, resolveStep, stillNamed, type Tx, type Who } from './grants';

const MINUTE = 60_000;
const MAX_START_DELAY_MS = 7 * 24 * 60 * MINUTE;

type BundleRow = Prisma.AccessBundleGetPayload<object>;
type RequestRow = Prisma.AccessRequestGetPayload<{
  include: { bundle: true; decisions: true; grant: { include: { targets: true } } };
}>;
const requestInclude = {
  bundle: true,
  decisions: { orderBy: { at: 'asc' } },
  grant: { include: { targets: { orderBy: { key: 'asc' } } } },
} satisfies Prisma.AccessRequestInclude;

/** The approvers a request named, per step (escalation appends to a step). */
type StepSnapshot = { name: string; approvalsRequired: number; approvers: NamedApprover[] };

export const refOf = (n: number) => `REQ-${n}`;
const policyOf = (b: BundleRow) => AccessPolicy.parse(b.policy ?? {});
const targetsOf = (b: BundleRow) => BundleTarget.array().parse(b.targets ?? []);

/**
 * Just-in-time access: bundles and their policy, requests, the decision rules, grants. The decision is made here and
 * only here (constitution principle IV): a person the policy names, signed in to Landbright, who isn't the requester,
 * the subject, or the person an agent acts for. Flows read, annotate and report targets; they never decide.
 */
/** A `status` filter outside these is ignored (it would otherwise reach Postgres as an invalid enum). */
const GRANT_STATUSES = new Set(['scheduled', 'active', 'expired', 'revoked']);

@Injectable()
export class AccessService {
  constructor(
    private readonly db: TenantDb,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  get tenantId() {
    return this.db.tenantId;
  }

  // ---------------------------------------------------------------- bundles

  async listBundles(): Promise<Bundle[]> {
    return this.db.tx(async (tx) => {
      const rows = await tx.accessBundle.findMany({ orderBy: { name: 'asc' } });
      return Promise.all(rows.map((b) => this.toBundle(tx, b)));
    });
  }

  async getBundle(id: string): Promise<Bundle> {
    return this.db.tx(async (tx) => this.toBundle(tx, await this.findBundle(tx, id)));
  }

  async createBundle(input: CreateBundle, actor: Principal): Promise<Bundle> {
    const id = await uniquely(
      this.db.tx(async (tx) => {
        await this.checkBundleRefs(tx, input);
        const row = await tx.accessBundle.create({
          data: {
            tenantId: this.tenantId,
            name: input.name,
            description: input.description,
            ownerId: input.ownerId ?? null,
            groupIds: input.groupIds,
            targets: input.targets as Prisma.InputJsonValue,
            policy: input.policy as Prisma.InputJsonValue,
            disabled: input.disabled,
          },
        });
        await appendAudit(tx, this.tenantId, {
          ...audited(actor),
          action: 'bundle.created',
          targetType: 'bundle',
          targetId: row.id,
          data: { name: input.name, groupIds: input.groupIds, targets: input.targets.map((t) => t.key) },
        });
        return row.id;
      }),
      'A bundle with that name already exists.',
    );
    return this.getBundle(id);
  }

  async updateBundle(id: string, input: UpdateBundle, actor: Principal): Promise<Bundle> {
    await uniquely(
      this.db.tx(async (tx) => {
        await this.findBundle(tx, id);
        await this.checkBundleRefs(tx, input);
        await tx.accessBundle.update({
          where: { id },
          data: {
            name: input.name,
            description: input.description,
            ownerId: input.ownerId,
            groupIds: input.groupIds,
            targets: input.targets as Prisma.InputJsonValue | undefined,
            policy: input.policy as Prisma.InputJsonValue | undefined,
            disabled: input.disabled,
          },
        });
        await appendAudit(tx, this.tenantId, {
          ...audited(actor),
          action: 'bundle.updated',
          targetType: 'bundle',
          targetId: id,
          data: { fields: Object.keys(input) },
        });
      }),
      'A bundle with that name already exists.',
    );
    return this.getBundle(id);
  }

  private async checkBundleRefs(tx: Tx, input: UpdateBundle) {
    if (input.groupIds?.length) {
      const found = await tx.group.count({ where: { id: { in: input.groupIds } } });
      if (found !== new Set(input.groupIds).size) throw new BadRequestException('A group in the bundle doesn’t exist.');
    }
    if (input.ownerId) {
      const owner = await tx.identity.findFirst({ where: { id: input.ownerId, kind: 'person' } });
      if (!owner) throw new BadRequestException('The owner must be a person in the directory.');
    }
    if (input.targets) {
      const keys = input.targets.map((t) => t.key);
      if (new Set(keys).size !== keys.length) throw new BadRequestException('Two targets have the same key.');
      if (keys.some((k) => k.startsWith('group:')))
        throw new BadRequestException('Target keys can’t start with group:.');
    }
  }

  private async toBundle(tx: Tx, b: BundleRow): Promise<Bundle> {
    const groups = await tx.group.findMany({ where: { id: { in: b.groupIds } }, select: { id: true, name: true } });
    const owner = b.ownerId ? await tx.identity.findFirst({ where: { id: b.ownerId } }) : null;
    return {
      id: b.id,
      name: b.name,
      description: b.description,
      owner: owner ? toRef(owner) : null,
      groups,
      targets: targetsOf(b),
      policy: policyOf(b),
      disabled: b.disabled,
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
    };
  }

  private async findBundle(tx: Tx, id: string): Promise<BundleRow> {
    const bundle = await tx.accessBundle.findFirst({ where: { id } });
    if (!bundle) throw new NotFoundException('No such bundle.');
    return bundle;
  }

  /** Bundles a person may ask for (for themselves or an agent they sponsor). */
  async requestable(person: Principal): Promise<Bundle[]> {
    return this.db.tx(async (tx) => {
      const rows = await tx.accessBundle.findMany({ where: { disabled: false }, orderBy: { name: 'asc' } });
      const out: Bundle[] = [];
      for (const b of rows) if (await this.eligible(tx, policyOf(b), person.id)) out.push(await this.toBundle(tx, b));
      return out;
    });
  }

  /** A person is eligible when the policy names no groups, or they're in one by a standing membership. */
  private async eligible(tx: Tx, policy: AccessPolicy, personId: string): Promise<boolean> {
    if (policy.eligibleGroupIds.length === 0) return true;
    return (
      (await tx.membership.count({
        where: { identityId: personId, groupId: { in: policy.eligibleGroupIds }, source: { not: 'grant' } },
      })) > 0
    );
  }

  // ---------------------------------------------------------------- asking

  /**
   * Everything the form needs before asking, and why not when the answer is no. The same checks `create` makes, so
   * the preview never promises what the request then refuses.
   */
  async preview(person: Principal, input: PreviewRequest): Promise<RequestPreview> {
    return this.db.tx(async (tx) => {
      const plan = await this.plan(tx, person, { ...input, breakGlass: false }, { dryRun: true });
      return {
        eligible: plan.whyNot === null,
        whyNot: plan.whyNot,
        autoApproveRule: plan.autoRule,
        approvers: plan.approverRefs,
        durationMinutes: plan.durationMinutes,
        maxDurationMinutes: plan.maxMinutes,
        reason: plan.policy?.reason ?? AccessPolicy.parse({}).reason,
        ticket: plan.policy?.ticket ?? AccessPolicy.parse({}).ticket,
        breakGlassAllowed: plan.breakGlassAllowed,
        pendingRequest: plan.pending ? refOf(plan.pending.number) : null,
        activeGrantUntil: plan.activeGrantUntil?.toISOString() ?? null,
      };
    });
  }

  private async plan(
    tx: Tx,
    person: Principal,
    input: Pick<CreateRequest, 'bundleId' | 'subjectId' | 'durationMinutes' | 'breakGlass'> &
      Partial<Pick<CreateRequest, 'reason' | 'ticket' | 'startsAt'>>,
    { dryRun }: { dryRun: boolean },
  ) {
    const fail = (whyNot: string) => ({
      whyNot,
      policy: null as AccessPolicy | null,
      bundle: null as BundleRow | null,
      autoRule: null as string | null,
      approverRefs: [] as IdentityRef[],
      steps: [] as StepSnapshot[],
      durationMinutes: 0,
      maxMinutes: 0,
      breakGlassAllowed: false,
      pending: null as { id: string; number: number } | null,
      activeGrantUntil: null as Date | null,
      subjectId: '',
      actingForId: null as string | null,
      subjectKind: 'person' as 'person' | 'agent',
    });
    const bundle = await tx.accessBundle.findFirst({ where: { id: input.bundleId } });
    if (!bundle) return fail('No such bundle.');
    const policy = policyOf(bundle);
    if (bundle.disabled) return { ...fail('This bundle is turned off.'), policy, bundle };

    // The subject: yourself, or an agent you sponsor (which never gets more than you could).
    let subjectId = person.id;
    let actingForId: string | null = null;
    let subjectKind: 'person' | 'agent' = 'person';
    if (input.subjectId && input.subjectId !== person.id) {
      const agent = await tx.agentProfile.findFirst({
        where: { identityId: input.subjectId },
        include: { identity: true },
      });
      if (!agent || agent.sponsorId !== person.id)
        return { ...fail('You can ask for yourself, or for an agent you sponsor.'), policy, bundle };
      if (agent.identity.status !== 'active') return { ...fail('That agent isn’t active.'), policy, bundle };
      if (!policy.agentsAllowed) return { ...fail('This bundle isn’t for agents.'), policy, bundle };
      subjectId = agent.identityId;
      actingForId = person.id;
      subjectKind = 'agent';
    }
    if (!(await this.eligible(tx, policy, person.id)))
      return { ...fail('The policy doesn’t let you ask for this bundle.'), policy, bundle };

    const maxMinutes = Math.min(
      policy.maxDurationMinutes,
      subjectKind === 'agent' ? policy.agentMaxDurationMinutes : Number.POSITIVE_INFINITY,
    );
    const durationMinutes = Math.min(input.durationMinutes ?? policy.defaultDurationMinutes, maxMinutes);
    const base = { ...fail(''), whyNot: null as string | null, policy, bundle, subjectId, actingForId, subjectKind };
    base.durationMinutes = durationMinutes;
    base.maxMinutes = maxMinutes;
    if (input.durationMinutes && input.durationMinutes > maxMinutes)
      return { ...base, whyNot: `At most ${maxMinutes} minutes for this bundle.` };

    const pending = await tx.accessRequest.findFirst({
      where: { bundleId: bundle.id, subjectId, status: 'pending' },
      select: { id: true, number: true },
    });
    const live = await tx.accessGrant.findFirst({
      where: { bundleId: bundle.id, subjectId, status: { in: ['scheduled', 'active'] } },
      orderBy: { expiresAt: 'desc' },
    });
    base.pending = pending;
    base.activeGrantUntil = live?.expiresAt ?? null;
    if (live) return { ...base, whyNot: `Access is already granted until ${live.expiresAt.toISOString()}.` };

    // Break-glass: the policy, which a person wrote, approves it at once; a review follows.
    const breakGlassAllowed =
      policy.breakGlass.allowed &&
      (policy.breakGlass.eligibleGroupIds.length === 0 ||
        (await tx.membership.count({
          where: {
            identityId: person.id,
            groupId: { in: policy.breakGlass.eligibleGroupIds },
            source: { not: 'grant' },
          },
        })) > 0);
    base.breakGlassAllowed = breakGlassAllowed;

    // Auto-approve rules: facts Landbright holds (standing memberships), recorded as evidence.
    for (const rule of policy.autoApprove) {
      const inGroup =
        rule.subjectInGroupIds.length === 0 ||
        (await tx.membership.count({
          where: { identityId: subjectId, groupId: { in: rule.subjectInGroupIds }, source: { not: 'grant' } },
        })) > 0;
      const shortEnough = rule.maxDurationMinutes === undefined || durationMinutes <= rule.maxDurationMinutes;
      if (inGroup && shortEnough) {
        base.autoRule = rule.name;
        break;
      }
    }

    const ctx = { requesterId: person.id, subjectId, actingForId, bundleOwnerId: bundle.ownerId };
    const steps: StepSnapshot[] = [];
    for (const step of policy.steps) {
      const approvers = await resolveStep(tx, step, policy.approverFallback, ctx);
      steps.push({ name: step.name, approvalsRequired: step.approvalsRequired, approvers });
    }
    base.steps = steps;
    const first = steps[0]?.approvers ?? [];
    const people = await tx.identity.findMany({ where: { id: { in: first.map((a) => a.id) } } });
    base.approverRefs = people.map(toRef);
    if (!base.autoRule && !input.breakGlass) {
      const short = steps.find((s) => s.approvers.length < s.approvalsRequired);
      if (short)
        return {
          ...base,
          whyNot:
            short.approvers.length === 0
              ? 'Nobody but you could approve this, so it can’t be asked for. Tell the bundle’s owner.'
              : `The step “${short.name}” needs ${short.approvalsRequired} approvers and only ${short.approvers.length} can approve.`,
        };
    }
    if (input.breakGlass && !breakGlassAllowed) return { ...base, whyNot: 'Break-glass isn’t allowed for you here.' };
    if (dryRun) return base;

    // What only the real request carries: the reason, the ticket, a start time.
    const reason = input.reason?.trim() ?? '';
    const minReason = input.breakGlass ? Math.max(10, policy.reason.minLength) : policy.reason.minLength;
    if ((policy.reason.mode === 'required' || input.breakGlass) && reason.length < Math.max(1, minReason))
      return { ...base, whyNot: `Give a reason of at least ${Math.max(1, minReason)} characters.` };
    if (policy.ticket.mode === 'required' && !input.ticket)
      return { ...base, whyNot: `A ${policy.ticket.label} is required.` };
    if (input.ticket && policy.ticket.mode === 'off') return { ...base, whyNot: 'This bundle takes no ticket.' };
    if (input.ticket && policy.ticket.pattern && !new RegExp(policy.ticket.pattern).test(input.ticket.id))
      return { ...base, whyNot: `That ${policy.ticket.label} doesn’t look right (${policy.ticket.pattern}).` };
    if (input.ticket && policy.ticket.uniquePerRequest) {
      const used = await tx.accessRequest.findFirst({
        where: {
          bundleId: bundle.id,
          ticket: { path: ['id'], equals: input.ticket.id },
          status: { not: 'superseded' },
        },
      });
      if (used) return { ...base, whyNot: `${input.ticket.id} was already used for ${refOf(used.number)}.` };
    }
    if (input.startsAt) {
      const at = new Date(input.startsAt).getTime();
      if (at > Date.now() + MAX_START_DELAY_MS) return { ...base, whyNot: 'Start at most 7 days from now.' };
    }
    if (input.breakGlass && durationMinutes > policy.breakGlass.maxDurationMinutes)
      return { ...base, whyNot: `Break-glass lasts at most ${policy.breakGlass.maxDurationMinutes} minutes.` };
    return base;
  }

  /**
   * Files a request. A pending request for the same bundle and subject is superseded by the new one. Auto-approval and
   * break-glass approve at once (method `auto` / `break_glass`); otherwise the request waits for the policy's
   * approvers until its deadline.
   */
  async create(person: Principal, input: CreateRequest, source = 'portal'): Promise<AccessRequestView> {
    const id = await this.db.tx(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`access:${this.tenantId}`}, 0))`;
      const plan = await this.plan(tx, person, input, { dryRun: false });
      if (plan.whyNot !== null || !plan.bundle || !plan.policy) throw new BadRequestException(plan.whyNot);
      const policy = plan.policy;
      const now = new Date();
      const last = await tx.accessRequest.findFirst({ orderBy: { number: 'desc' }, select: { number: true } });
      const number = (last?.number ?? 0) + 1;
      const who = audited(person);
      const request = await tx.accessRequest.create({
        data: {
          tenantId: this.tenantId,
          number,
          bundleId: plan.bundle.id,
          requesterId: person.id,
          subjectId: plan.subjectId,
          actingForId: plan.actingForId,
          source,
          reason: input.reason?.trim() || null,
          ticket: (input.ticket ?? undefined) as Prisma.InputJsonValue | undefined,
          durationSeconds: plan.durationMinutes * 60,
          startsAt: input.startsAt ? new Date(input.startsAt) : null,
          deadline: new Date(now.getTime() + policy.decisionDeadlineMinutes * MINUTE),
          policySnapshot: policy as Prisma.InputJsonValue,
          approvers: plan.steps as unknown as Prisma.InputJsonValue,
        },
      });
      await appendAudit(tx, this.tenantId, {
        ...who,
        action: 'request.created',
        targetType: 'request',
        targetId: request.id,
        data: {
          ref: refOf(number),
          bundle: plan.bundle.name,
          subjectId: plan.subjectId,
          durationMinutes: plan.durationMinutes,
          source,
          breakGlass: input.breakGlass,
        },
      });
      if (plan.pending) {
        await tx.accessRequest.update({
          where: { id: plan.pending.id },
          data: { status: 'superseded', supersededById: request.id, decidedAt: now, closingReason: 'superseded' },
        });
        await appendAudit(tx, this.tenantId, {
          ...who,
          action: 'request.decided',
          targetType: 'request',
          targetId: plan.pending.id,
          data: { ref: refOf(plan.pending.number), outcome: 'superseded', by: refOf(number) },
        });
      }
      if (input.breakGlass) {
        const reviewDueAt = new Date(now.getTime() + policy.breakGlass.reviewWithinHours * 3600_000);
        await this.approve(tx, request.id, 'break_glass', who, {
          breakGlass: { reason: input.reason, reviewDueAt: reviewDueAt.toISOString() },
        });
        await appendAudit(tx, this.tenantId, {
          ...who,
          action: 'request.break_glass',
          targetType: 'request',
          targetId: request.id,
          data: { ref: refOf(number), reason: input.reason, reviewDueAt: reviewDueAt.toISOString() },
        });
      } else if (plan.autoRule) {
        await this.approve(
          tx,
          request.id,
          'auto',
          { actorId: null, actorLabel: 'policy' },
          {
            autoApproval: { rule: plan.autoRule, evaluatedAt: now.toISOString(), evidence: 'standing membership' },
          },
        );
      }
      return request.id;
    });
    return this.view(id, { person });
  }

  /** Marks a request approved (clamping its duration to the policy's current maximum) and creates its grant. */
  private async approve(
    tx: Tx,
    requestId: string,
    method: 'reviewed' | 'auto' | 'break_glass',
    who: Who,
    extra: { autoApproval?: object; breakGlass?: object } = {},
  ) {
    const request = await tx.accessRequest.findUniqueOrThrow({ where: { id: requestId }, include: { bundle: true } });
    const policy = policyOf(request.bundle);
    const maxSeconds =
      (method === 'break_glass' ? policy.breakGlass.maxDurationMinutes : policy.maxDurationMinutes) * 60;
    const durationSeconds = Math.min(request.durationSeconds, maxSeconds);
    await tx.accessRequest.update({
      where: { id: requestId },
      data: {
        status: 'approved',
        method,
        decidedAt: new Date(),
        durationSeconds,
        autoApproval: extra.autoApproval as Prisma.InputJsonValue | undefined,
        breakGlass: extra.breakGlass as Prisma.InputJsonValue | undefined,
      },
    });
    await appendAudit(tx, this.tenantId, {
      ...who,
      action: 'request.decided',
      targetType: 'request',
      targetId: requestId,
      data: {
        ref: refOf(request.number),
        outcome: 'approved',
        method,
        ...(durationSeconds < request.durationSeconds && { clampedToMinutes: durationSeconds / 60 }),
        ...extra,
      },
    });
    await createGrant(
      tx,
      this.tenantId,
      { ...request, durationSeconds },
      { groupIds: request.bundle.groupIds, targets: targetsOf(request.bundle) },
      who,
      { breakGlass: method === 'break_glass' },
    );
  }

  // ---------------------------------------------------------------- deciding

  /**
   * One person's vote. Every rule is checked here, under the request's lock; anything refused is audited
   * (`request.decision_refused`) with the reason, and the person gets a sentence saying why.
   */
  async decide(person: Principal, requestId: string, input: DecideRequest): Promise<AccessRequestView> {
    const refusal = await this.db.tx(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`request:${requestId}`}, 0))`;
      const request = await tx.accessRequest.findFirst({ where: { id: requestId }, include: requestInclude });
      if (!request) throw new NotFoundException('No such request.');
      const why = await this.whyNotDecide(tx, request, person.id);
      if (why) {
        await appendAudit(tx, this.tenantId, {
          ...audited(person),
          action: 'request.decision_refused',
          targetType: 'request',
          targetId: request.id,
          data: { ref: refOf(request.number), outcome: input.outcome, why },
        });
        return why;
      }
      const steps = request.approvers as unknown as StepSnapshot[];
      const step = steps[request.currentStep];
      await tx.accessDecision.create({
        data: {
          tenantId: this.tenantId,
          requestId: request.id,
          stepIndex: request.currentStep,
          deciderId: person.id,
          outcome: input.outcome,
          comment: input.comment ?? null,
          channel: 'landbright',
          assurance: 'signed-in',
        },
      });
      const approvals =
        request.decisions.filter((d) => d.stepIndex === request.currentStep && d.outcome === 'approve').length +
        (input.outcome === 'approve' ? 1 : 0);
      await appendAudit(tx, this.tenantId, {
        ...audited(person),
        action: 'request.vote_recorded',
        targetType: 'request',
        targetId: request.id,
        data: {
          ref: refOf(request.number),
          outcome: input.outcome,
          step: step?.name,
          approvals,
          approvalsRequired: step?.approvalsRequired,
          comment: input.comment,
        },
      });
      if (input.outcome === 'deny') {
        await tx.accessRequest.update({
          where: { id: request.id },
          data: { status: 'denied', decidedAt: new Date(), closingReason: 'denied' },
        });
        await appendAudit(tx, this.tenantId, {
          ...audited(person),
          action: 'request.decided',
          targetType: 'request',
          targetId: request.id,
          data: { ref: refOf(request.number), outcome: 'denied', comment: input.comment },
        });
      } else if (step && approvals >= step.approvalsRequired) {
        if (request.currentStep + 1 < steps.length)
          await tx.accessRequest.update({ where: { id: request.id }, data: { currentStep: request.currentStep + 1 } });
        else await this.approve(tx, request.id, 'reviewed', audited(person));
      }
      return null;
    });
    if (refusal) throw new ForbiddenException(refusal);
    return this.view(requestId, { person });
  }

  /** Why this person may not vote on this request now, or null when they may. */
  private async whyNotDecide(tx: Tx, request: RequestRow, personId: string): Promise<string | null> {
    if (request.status !== 'pending') return `${refOf(request.number)} is already ${request.status}.`;
    if (request.deadline <= new Date()) return `The deadline for ${refOf(request.number)} has passed.`;
    if (request.bundle.disabled) return 'The bundle is turned off.';
    if (personId === request.requesterId) return 'You can’t decide your own request.';
    if (personId === request.subjectId) return 'You can’t decide a request for your own access.';
    if (personId === request.actingForId) return 'You can’t decide a request your own agent made for you.';
    const decider = await tx.identity.findFirst({ where: { id: personId } });
    if (decider?.kind !== 'person' || decider.status !== 'active') return 'Only active people decide requests.';
    if (request.decisions.some((d) => d.deciderId === personId)) return 'You have already voted on this request.';
    const steps = request.approvers as unknown as StepSnapshot[];
    const named = steps[request.currentStep]?.approvers.find((a) => a.id === personId);
    if (!named) return 'The policy doesn’t name you as an approver for this step.';
    if (!(await stillNamed(tx, named))) return 'You’re no longer in the group that made you an approver.';
    return null;
  }

  async cancel(person: Principal, requestId: string): Promise<AccessRequestView> {
    await this.db.tx(async (tx) => {
      const request = await tx.accessRequest.findFirst({ where: { id: requestId } });
      if (!request) throw new NotFoundException('No such request.');
      if (request.requesterId !== person.id && !person.admin)
        throw new ForbiddenException('Only the requester can cancel a request.');
      if (request.status !== 'pending') throw new ConflictException(`It is already ${request.status}.`);
      await tx.accessRequest.update({
        where: { id: requestId },
        data: { status: 'cancelled', decidedAt: new Date(), closingReason: 'cancelled' },
      });
      await appendAudit(tx, this.tenantId, {
        ...audited(person),
        action: 'request.decided',
        targetType: 'request',
        targetId: requestId,
        data: { ref: refOf(request.number), outcome: 'cancelled' },
      });
    });
    return this.view(requestId, { person });
  }

  /** Ends a grant early: an administrator, or the person who holds it (giving it back). */
  async revoke(person: Principal, grantId: string, comment?: string): Promise<AccessRequestView> {
    const requestId = await this.db.tx(async (tx) => {
      const grant = await tx.accessGrant.findFirst({ where: { id: grantId } });
      if (!grant) throw new NotFoundException('No such grant.');
      const request = await tx.accessRequest.findUniqueOrThrow({ where: { id: grant.requestId } });
      const own = person.id === grant.subjectId || person.id === request.actingForId;
      if (!own && !person.admin) throw new ForbiddenException('Only an administrator or the holder can end it.');
      if (grant.status !== 'active' && grant.status !== 'scheduled')
        throw new ConflictException(`It has already ${grant.status === 'expired' ? 'expired' : 'been revoked'}.`);
      await closeGrant(tx, this.tenantId, grantId, 'revoked', own ? 'revoked_by_holder' : 'revoked_by_admin', {
        ...audited(person),
      });
      if (comment)
        await appendAudit(tx, this.tenantId, {
          ...audited(person),
          action: 'grant.commented',
          targetType: 'grant',
          targetId: grantId,
          data: { comment },
        });
      return grant.requestId;
    });
    return this.view(requestId, { person });
  }

  // ---------------------------------------------------------------- flows report back

  /**
   * A flow reports one target: provisioned, failed, revoked, revoke_failed, verified, drift. Only targets a flow
   * manages, and only in a state that allows it: `provisioned` for a grant that has ended is refused, so a late or
   * forged report can't bring access back.
   */
  async reportTarget(service: ServicePrincipal, grantId: string, key: string, input: ReportTarget) {
    return this.db.tx(async (tx) => {
      const grant = await tx.accessGrant.findFirst({ where: { id: grantId }, include: { targets: true } });
      if (!grant) throw new NotFoundException('No such grant.');
      const target = grant.targets.find((t) => t.key === key);
      if (!target) throw new NotFoundException(`The grant has no target ${key}.`);
      if (target.managedBy !== 'flow') throw new ForbiddenException('Landbright manages that target itself.');
      const live = grant.status === 'active';
      const allowed: Record<ReportTarget['status'], boolean> = {
        provisioned: live,
        failed: live,
        verified: live,
        drift: true,
        revoked: true,
        revoke_failed: !live,
      };
      if (!allowed[input.status])
        throw new ConflictException(`A ${grant.status} grant can’t have a target reported ${input.status}.`);
      await tx.grantTarget.update({
        where: { id: target.id },
        data: {
          status: input.status,
          attempts: { increment: input.status === 'failed' || input.status === 'revoke_failed' ? 1 : 0 },
          lastError: input.status.endsWith('failed') || input.status === 'drift' ? (input.detail ?? null) : null,
          externalRef: input.externalRef ?? target.externalRef,
          updatedBy: service.name,
        },
      });
      await appendAudit(tx, this.tenantId, {
        ...audited(service),
        action: input.status === 'failed' ? 'grant.target_failed' : `grant.target_${input.status}`,
        targetType: 'grant',
        targetId: grantId,
        data: { target: key, status: input.status, detail: input.detail, externalRef: input.externalRef },
      });
      return this.grantView(tx, grantId);
    });
  }

  /** A note a service keeps on a request or grant, with optional compare-and-swap on its version. */
  async annotate(
    service: ServicePrincipal,
    targetType: 'request' | 'grant',
    targetId: string,
    key: string,
    value: unknown,
    ifMatch?: number,
  ) {
    if (!/^[a-z0-9][a-z0-9_.-]{0,99}$/.test(key)) throw new BadRequestException('Keys are lowercase: landflow.run');
    return this.db.tx(async (tx) => {
      const exists =
        targetType === 'request'
          ? await tx.accessRequest.count({ where: { id: targetId } })
          : await tx.accessGrant.count({ where: { id: targetId } });
      if (!exists) throw new NotFoundException(`No such ${targetType}.`);
      const current = await tx.annotation.findUnique({ where: { targetId_key: { targetId, key } } });
      if (ifMatch !== undefined && (current?.version ?? 0) !== ifMatch)
        throw new ConflictException(`The note is at version ${current?.version ?? 0}, not ${ifMatch}.`);
      const row = await tx.annotation.upsert({
        where: { targetId_key: { targetId, key } },
        create: {
          tenantId: this.tenantId,
          targetType,
          targetId,
          key,
          value: value as Prisma.InputJsonValue,
          updatedBy: service.name,
        },
        update: { value: value as Prisma.InputJsonValue, version: { increment: 1 }, updatedBy: service.name },
      });
      return { key: row.key, value: row.value, version: row.version };
    });
  }

  /**
   * A flow waiting on a request: its resume URL is called (once) when the request gets a vote, a decision or new
   * approvers. Only at an origin an enabled subscription already delivers to, so this can't be used to make Landbright
   * call anywhere else.
   */
  async attachWait(service: ServicePrincipal, requestId: string, resumeUrl: string) {
    const origin = new URL(resumeUrl).origin;
    const allowed = await this.db.tx(async (tx) =>
      (await tx.eventSubscription.findMany({ where: { disabled: false }, select: { url: true } })).some(
        (s) => new URL(s.url).origin === origin,
      ),
    );
    if (!allowed) throw new BadRequestException(`No enabled subscription delivers to ${origin}.`);
    return this.annotate(service, 'request', requestId, `wait.${service.clientId}`, {
      resumeUrl,
      at: new Date().toISOString(),
    });
  }

  // ---------------------------------------------------------------- reading

  /** Who may see a request: its requester, subject, the person an agent acts for, its approvers, administrators. */
  private canSee(request: RequestRow, person: Principal): boolean {
    if (person.admin) return true;
    if ([request.requesterId, request.subjectId, request.actingForId].includes(person.id)) return true;
    return (request.approvers as unknown as StepSnapshot[]).some((s) => s.approvers.some((a) => a.id === person.id));
  }

  async findId(ref: string): Promise<string> {
    const n = /^REQ-(\d+)$/i.exec(ref)?.[1];
    if (!n) {
      // Not a number: it must be an id (anything else would reach Postgres as an invalid uuid).
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref))
        throw new NotFoundException('No such request.');
      return ref;
    }
    return this.db.tx(async (tx) => {
      const row = await tx.accessRequest.findFirst({ where: { number: Number(n) }, select: { id: true } });
      if (!row) throw new NotFoundException('No such request.');
      return row.id;
    });
  }

  async view(id: string, caller: { person?: Principal; service?: ServicePrincipal }): Promise<AccessRequestView> {
    return this.db.tx(async (tx) => {
      const request = await tx.accessRequest.findFirst({ where: { id }, include: requestInclude });
      if (!request) throw new NotFoundException('No such request.');
      if (caller.person && !this.canSee(request, caller.person)) throw new NotFoundException('No such request.');
      return this.toView(tx, request, caller);
    });
  }

  async list(person: Principal, scope: 'mine' | 'to-decide' | 'all', status?: string): Promise<AccessRequestView[]> {
    return this.db.tx(async (tx) => {
      if (scope === 'all' && !person.admin) throw new ForbiddenException('Only administrators see every request.');
      const where: Prisma.AccessRequestWhereInput =
        scope === 'mine'
          ? { OR: [{ requesterId: person.id }, { subjectId: person.id }, { actingForId: person.id }] }
          : scope === 'to-decide'
            ? { status: 'pending' }
            : {};
      if (status) where.status = status as Prisma.EnumAccessRequestStatusFilter['equals'];
      const rows = await tx.accessRequest.findMany({
        where,
        include: requestInclude,
        orderBy: { number: 'desc' },
        take: 200,
      });
      const visible =
        scope === 'to-decide'
          ? rows.filter((r) =>
              (r.approvers as unknown as StepSnapshot[])[r.currentStep]?.approvers.some((a) => a.id === person.id),
            )
          : rows;
      return Promise.all(visible.map((r) => this.toView(tx, r, { person })));
    });
  }

  private async toView(
    tx: Tx,
    r: RequestRow,
    caller: { person?: Principal; service?: ServicePrincipal },
  ): Promise<AccessRequestView> {
    const steps = r.approvers as unknown as StepSnapshot[];
    const ids = new Set<string>([r.requesterId, r.subjectId]);
    if (r.actingForId) ids.add(r.actingForId);
    for (const s of steps) for (const a of s.approvers) ids.add(a.id);
    for (const d of r.decisions) ids.add(d.deciderId);
    const people = new Map(
      (await tx.identity.findMany({ where: { id: { in: [...ids] } } })).map((i) => [i.id, toRef(i)] as const),
    );
    const ref = (id: string): IdentityRef =>
      people.get(id) ?? { id, kind: 'person', displayName: 'Unknown', email: null, status: 'deactivated' };
    const voted = new Set(r.decisions.map((d) => d.deciderId));
    const current = steps[r.currentStep];
    const annotations = await tx.annotation.findMany({ where: { targetId: r.id } });
    const person = caller.person;
    const decide = !!person && r.status === 'pending' && (await this.whyNotDecide(tx, r, person.id)) === null;
    return {
      id: r.id,
      number: r.number,
      ref: refOf(r.number),
      bundle: { id: r.bundle.id, name: r.bundle.name },
      requester: ref(r.requesterId),
      subject: ref(r.subjectId),
      actingFor: r.actingForId ? ref(r.actingForId) : null,
      source: r.source,
      reason: r.reason,
      ticket: (r.ticket as AccessRequestView['ticket']) ?? null,
      durationMinutes: Math.round(r.durationSeconds / 60),
      startsAt: r.startsAt?.toISOString() ?? null,
      deadline: r.deadline.toISOString(),
      status: r.status,
      method: r.method,
      closingReason: r.closingReason,
      currentStep: r.currentStep,
      steps: steps.map((s, i) => ({
        name: s.name,
        approvalsRequired: s.approvalsRequired,
        approvals: r.decisions.filter((d) => d.stepIndex === i && d.outcome === 'approve').length,
        approvers: s.approvers.map((a) => ref(a.id)),
      })),
      votes: r.decisions.map((d) => ({
        decider: ref(d.deciderId),
        step: d.stepIndex,
        outcome: d.outcome as 'approve' | 'deny',
        comment: d.comment,
        channel: d.channel,
        assurance: d.assurance,
        submittedBy: d.submittedBy,
        at: d.at.toISOString(),
      })),
      waitingOn:
        r.status === 'pending' && current
          ? current.approvers.filter((a) => !voted.has(a.id)).map((a) => ref(a.id))
          : [],
      autoApproval: r.autoApproval ?? null,
      breakGlass: r.breakGlass ?? null,
      grant: r.grant ? this.toGrantView(r.grant) : null,
      decisionUrl: new URL(`/access/requests/${refOf(r.number)}`, this.config.LANDBRIGHT_CONSOLE_URL).href,
      actions: {
        decide,
        cancel: !!person && r.status === 'pending' && (person.id === r.requesterId || person.admin),
        revoke:
          !!person &&
          !!r.grant &&
          (r.grant.status === 'active' || r.grant.status === 'scheduled') &&
          (person.admin || person.id === r.subjectId || person.id === r.actingForId),
      },
      annotations: Object.fromEntries(annotations.map((a) => [a.key, a.value])),
      createdAt: r.createdAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
    };
  }

  private toGrantView(g: NonNullable<RequestRow['grant']>): GrantView {
    return {
      id: g.id,
      status: g.status,
      startsAt: g.startsAt.toISOString(),
      activatedAt: g.activatedAt?.toISOString() ?? null,
      expiresAt: g.expiresAt.toISOString(),
      closedAt: g.closedAt?.toISOString() ?? null,
      closingReason: g.closingReason,
      isBreakGlass: g.isBreakGlass,
      targets: g.targets.map((t) => ({
        key: t.key,
        type: t.type,
        label: t.label,
        managedBy: t.managedBy as 'landbright' | 'flow',
        status: t.status as GrantView['targets'][number]['status'],
        attempts: t.attempts,
        lastError: t.lastError,
        externalRef: t.externalRef,
        config: {},
        updatedAt: t.updatedAt.toISOString(),
      })),
    };
  }

  /** A grant with its targets, each with the bundle's config for it (what a provisioning flow needs). */
  async grantView(tx: Tx, grantId: string) {
    const g = await tx.accessGrant.findFirst({
      where: { id: grantId },
      include: { targets: { orderBy: { key: 'asc' } }, request: { include: { bundle: true } } },
    });
    if (!g) throw new NotFoundException('No such grant.');
    const config = new Map(targetsOf(g.request.bundle).map((t) => [t.key, t.config] as const));
    const subject = await tx.identity.findUniqueOrThrow({ where: { id: g.subjectId } });
    const view = this.toGrantView(g);
    return {
      ...view,
      requestId: g.requestId,
      ref: refOf(g.request.number),
      bundle: { id: g.request.bundle.id, name: g.request.bundle.name },
      subject: toRef(subject),
      targets: view.targets.map((t) => ({ ...t, config: config.get(t.key) ?? {} })),
    };
  }

  async grant(grantId: string) {
    return this.db.tx((tx) => this.grantView(tx, grantId));
  }

  async grants(filter: { status?: string; type?: string }) {
    return this.db.tx(async (tx) => {
      const rows = await tx.accessGrant.findMany({
        where: {
          ...(filter.status &&
            GRANT_STATUSES.has(filter.status) && { status: filter.status as Prisma.EnumGrantStatusFilter['equals'] }),
          ...(filter.type && { targets: { some: { type: filter.type } } }),
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: { id: true },
      });
      return Promise.all(rows.map((r) => this.grantView(tx, r.id)));
    });
  }
}
