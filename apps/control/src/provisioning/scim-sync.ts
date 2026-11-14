import { Inject, Injectable, Logger } from '@nestjs/common';
import type { GroupsMode } from '@landbright/contracts';
import { type Config, unseal } from '@landbright/platform';
import { appendAudit, CONFIG, type Prisma } from '@landbright/persistence';
import { TenantDb } from '../common/tenant-db';
import { ScimClient, ScimError, type ScimResource } from './scim-client';
import {
  desiredUser,
  groupOps,
  groupResource,
  type GroupState,
  readActive,
  readMembers,
  userOps,
  userResource,
  type UserState,
} from './scim-ops';

type Tx = Prisma.TransactionClient;
type Target = Prisma.ScimTargetGetPayload<object>;
type Kind = 'user' | 'group';

export const RECONCILE_MS = 15 * 60_000;
const ROUNDS = 3;
const BATCH = 50;
const LABEL = 'Landbright provisioning';

/** 5 s, 10 s, 20 s … an hour at most; a server's `Retry-After` when it asks for longer. */
export const retryInMs = (attempts: number, retryAfterMs?: number) =>
  Math.min(Math.max(5_000 * 2 ** Math.max(0, attempts - 1), retryAfterMs ?? 0), 3600_000);

/**
 * user_attribute mode: the groups a push added to and removed from the person's `groups` (the grant's timeline reads
 * them, as it reads a group's `added` and `removed` in groups mode). Nothing when the mode has no `groups`.
 */
export function groupChanges(prev: string[] | undefined, next: string[] | undefined) {
  if (!next) return {};
  const was = new Set(prev ?? []);
  const now = new Set(next);
  const groupsAdded = next.filter((g) => !was.has(g));
  const groupsRemoved = (prev ?? []).filter((g) => !now.has(g));
  return {
    ...(groupsAdded.length ? { groupsAdded } : {}),
    ...(groupsRemoved.length ? { groupsRemoved } : {}),
  };
}

/**
 * Provisioning out (spec 006): keeps each target's SCIM server holding the people (and, in groups mode, the groups)
 * Landbright says. The audit log is the outbox: each target reads it from its cursor and queues the people and groups
 * that changed (one job per object, however many changes); jobs are pushed people first, then groups, retried with
 * back-off until they land. Every 15 minutes, or when the target changes, everything is queued again to be compared
 * with what the application holds. Run from the event worker's loop, under its lock (one replica at a time).
 */
@Injectable()
export class ScimSync {
  private readonly logger = new Logger(ScimSync.name);

  constructor(
    private readonly db: TenantDb,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  async tick(): Promise<void> {
    const targets = await this.db.tx((tx) => tx.scimTarget.findMany({ where: { disabled: false } }));
    for (const t of targets) {
      await this.match(t);
      await this.reconcileIfDue(t);
    }
    await Promise.all(targets.map((t) => this.pushTarget(t)));
  }

  /** The target's new audit events become jobs; the cursor moves with them. */
  private async match(t: Target): Promise<void> {
    await this.db.tx(async (tx) => {
      const events = await tx.auditEvent.findMany({
        where: { id: { gt: t.cursor } },
        orderBy: { id: 'asc' },
        take: 500,
        select: { id: true, action: true, targetType: true, targetId: true, data: true },
      });
      if (events.length === 0) return;
      const assigned = new Set(t.groupIds);
      const jobs = new Map<string, { kind: Kind; localId: string }>();
      const add = (kind: Kind, localId: string | null | undefined) => {
        if (localId) jobs.set(`${kind}:${localId}`, { kind, localId });
      };
      const linkedUsers = async () =>
        (await tx.scimLink.findMany({ where: { targetId: t.id, kind: 'user' }, select: { localId: true } })).map(
          (l) => l.localId,
        );
      for (const e of events) {
        const data = (e.data ?? {}) as { identityId?: string };
        if (e.action.startsWith('provisioning.')) continue;
        if (e.targetType === 'identity' && e.action.startsWith('identity.')) add('user', e.targetId);
        else if (e.action === 'group.member_added' || e.action === 'group.member_removed') {
          if (!e.targetId || !assigned.has(e.targetId)) continue;
          add('user', data.identityId);
          if (t.groupsMode === 'groups') add('group', e.targetId);
        } else if (e.action === 'group.updated' && e.targetId && assigned.has(e.targetId)) {
          if (t.groupsMode === 'groups') add('group', e.targetId);
          else
            for (const m of await tx.membership.findMany({
              where: { groupId: e.targetId },
              select: { identityId: true },
            }))
              add('user', m.identityId);
        } else if (e.action === 'group.deleted' && e.targetId && assigned.has(e.targetId)) {
          // Its memberships went with it, unrecorded: anyone linked may have left scope.
          if (t.groupsMode === 'groups') add('group', e.targetId);
          for (const id of await linkedUsers()) add('user', id);
        }
      }
      for (const job of jobs.values()) await this.enqueue(tx, t, job.kind, job.localId, false);
      await tx.scimTarget.update({ where: { id: t.id }, data: { cursor: events.at(-1)!.id } });
    });
  }

  /** Queues everything in scope or linked, to be compared with the application's copy. */
  private async reconcileIfDue(t: Target): Promise<void> {
    if (t.lastReconciledAt && Date.now() - t.lastReconciledAt.getTime() < RECONCILE_MS) return;
    await this.db.tx(async (tx) => {
      const users = new Set<string>();
      const groups = new Set<string>(t.groupsMode === 'groups' ? t.groupIds : []);
      for (const m of await tx.membership.findMany({
        where: { groupId: { in: t.groupIds }, identity: { kind: 'person' } },
        select: { identityId: true },
      }))
        users.add(m.identityId);
      for (const l of await tx.scimLink.findMany({ where: { targetId: t.id }, select: { kind: true, localId: true } }))
        (l.kind === 'user' ? users : groups).add(l.localId);
      for (const id of users) await this.enqueue(tx, t, 'user', id, true);
      for (const id of groups) await this.enqueue(tx, t, 'group', id, true);
      await tx.scimTarget.update({ where: { id: t.id }, data: { lastReconciledAt: new Date() } });
    });
  }

  /** One job per object: a new change makes a waiting job due now. */
  private async enqueue(tx: Tx, t: Target, kind: Kind, localId: string, verify: boolean): Promise<void> {
    await tx.scimJob.upsert({
      where: { targetId_kind_localId: { targetId: t.id, kind, localId } },
      create: { tenantId: t.tenantId, targetId: t.id, kind, localId, verify },
      update: { nextAttemptAt: new Date(), ...(verify ? { verify: true } : {}) },
    });
  }

  /** The target's due jobs, people before groups; a few rounds so groups follow the people they need. */
  private async pushTarget(t: Target): Promise<void> {
    let client: ScimClient;
    try {
      client = new ScimClient(t.baseUrl, unseal(this.config.LANDBRIGHT_SECRET_KEY, t.tokenSealed));
    } catch (error) {
      this.logger.warn(`provisioning ${t.name}: the token can't be read (${String(error)})`);
      return;
    }
    for (let round = 0; round < ROUNDS; round++) {
      const due = await this.db.tx((tx) =>
        tx.scimJob.findMany({
          where: { targetId: t.id, nextAttemptAt: { lte: new Date() } },
          orderBy: [{ kind: 'desc' }, { queuedAt: 'asc' }],
          take: BATCH,
        }),
      );
      if (due.length === 0) return;
      for (const job of due) await this.run(t, client, job);
    }
  }

  private async run(t: Target, client: ScimClient, job: Prisma.ScimJobGetPayload<object>): Promise<void> {
    const startedAt = new Date();
    try {
      if (job.kind === 'user') await this.syncUser(t, client, job.localId, job.verify);
      else if (t.groupsMode === 'groups') await this.syncGroup(t, client, job.localId, job.verify);
      await this.db.tx(async (tx) => {
        // Done, unless it was queued again while it ran.
        await tx.scimJob.deleteMany({
          where: { targetId: t.id, kind: job.kind, localId: job.localId, nextAttemptAt: { lte: startedAt } },
        });
        await tx.scimTarget.update({ where: { id: t.id }, data: { lastSuccessAt: new Date() } });
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      const attempts = job.attempts + 1;
      const wait = retryInMs(attempts, error instanceof ScimError ? error.retryAfterMs : undefined);
      await this.db.tx(async (tx) => {
        await tx.scimJob.updateMany({
          where: { targetId: t.id, kind: job.kind, localId: job.localId },
          data: { attempts, lastError: message, nextAttemptAt: new Date(Date.now() + wait) },
        });
        if (attempts === 1)
          await appendAudit(tx, t.tenantId, {
            actorId: null,
            actorLabel: LABEL,
            action: 'provisioning.push_failed',
            targetType: job.kind === 'user' ? 'identity' : 'group',
            targetId: job.localId,
            data: { target: t.name, targetId: t.id, kind: job.kind, error: message, retryInSeconds: wait / 1000 },
          });
      });
      this.logger.debug(`provisioning ${t.name}: ${job.kind} ${job.localId}, attempt ${attempts}: ${message}`);
    }
  }

  // ── People ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private async syncUser(t: Target, client: ScimClient, personId: string, verify: boolean): Promise<void> {
    const { identity, groupNames, link } = await this.db.tx(async (tx) => ({
      identity: await tx.identity.findUnique({ where: { id: personId }, include: { person: true } }),
      groupNames: (
        await tx.membership.findMany({
          where: { identityId: personId, groupId: { in: t.groupIds } },
          select: { group: { select: { name: true } } },
        })
      ).map((m) => m.group.name),
      link: await tx.scimLink.findUnique({
        where: { targetId_kind_localId: { targetId: t.id, kind: 'user', localId: personId } },
      }),
    }));
    if (!identity || identity.kind !== 'person' || !identity.email) {
      // Gone from Landbright (or never a person): whatever was pushed is switched off.
      if (link && (link.state as unknown as UserState).active !== false) {
        await client.patch('Users', link.remoteId, [{ op: 'replace', path: 'active', value: false }]);
        await this.saveUser(t, personId, link.remoteId, { ...(link.state as unknown as UserState), active: false });
      }
      return;
    }
    const inScope = identity.status === 'active' && groupNames.length > 0;
    const next = desiredUser(
      {
        id: identity.id,
        email: identity.email,
        displayName: identity.displayName,
        givenName: identity.person?.givenName ?? null,
        familyName: identity.person?.familyName ?? null,
      },
      inScope,
      t.groupsMode as GroupsMode,
      groupNames,
    );
    const why = inScope ? null : identity.status !== 'active' ? identity.status : 'not in an assigned group';
    if (!link) {
      if (inScope) await this.createOrAdopt(t, client, personId, next, null);
      return;
    }
    let prev = link.state as unknown as UserState;
    if (verify) {
      const remote = await client.get('Users', link.remoteId);
      if (!remote) {
        await this.dropLink(t, 'user', personId);
        if (inScope) await this.createOrAdopt(t, client, personId, next, null);
        return;
      }
      prev = {
        ...prev,
        active: readActive(remote) ?? prev.active,
        userName: typeof remote.userName === 'string' ? remote.userName.toLowerCase() : prev.userName,
      };
    }
    if (next.active && prev.active === false) {
      // Back in scope: created again (Landfall re-links its sign-in only on create; Landflow answers 409 and is patched).
      await this.createOrAdopt(t, client, personId, next, link.remoteId);
      return;
    }
    const ops = userOps(personId, prev, next);
    if (ops.length === 0) {
      if (verify) await this.saveUser(t, personId, link.remoteId, next);
      return;
    }
    if (!(await client.patch('Users', link.remoteId, ops))) {
      await this.dropLink(t, 'user', personId);
      if (inScope) await this.createOrAdopt(t, client, personId, next, null);
      return;
    }
    await this.saveUser(t, personId, link.remoteId, next, {
      action: next.active ? 'provisioning.user_updated' : 'provisioning.user_deactivated',
      data: {
        remoteId: link.remoteId,
        email: next.userName,
        ...(next.active ? { changed: ops.map((o) => o.path ?? Object.keys(o.value as object).join(',')) } : { why }),
        ...(next.active ? groupChanges(prev.groups, next.groups) : {}),
        ...(verify ? { drift: true } : {}),
      },
    });
    if (prev.active !== next.active) await this.queueGroupsOf(t, personId, link.remoteId);
  }

  /** `POST /Users`; on 409, the account already there (by email, then by externalId) is adopted and patched. */
  private async createOrAdopt(
    t: Target,
    client: ScimClient,
    personId: string,
    next: UserState,
    previousRemoteId: string | null,
  ): Promise<void> {
    let remote: ScimResource;
    let action: string;
    try {
      remote = await client.create('Users', userResource(personId, next));
      action = previousRemoteId ? 'provisioning.user_updated' : 'provisioning.user_created';
    } catch (error) {
      if (!(error instanceof ScimError) || error.status !== 409) throw error;
      const found =
        (await client.findOne('Users', 'userName', next.userName)) ??
        (await client.findOne('Users', 'externalId', personId));
      if (!found) throw error;
      if (!(await client.patch('Users', found.id, userOps(personId, null, next))))
        throw new ScimError(409, `${next.userName} exists but can't be updated`);
      remote = found;
      action = found.id === previousRemoteId ? 'provisioning.user_updated' : 'provisioning.user_linked';
    }
    await this.saveUser(t, personId, remote.id, next, {
      action,
      data: {
        remoteId: remote.id,
        email: next.userName,
        ...(previousRemoteId ? { reactivated: true } : {}),
        ...groupChanges([], next.groups),
      },
    });
    await this.queueGroupsOf(t, personId, remote.id);
  }

  private async saveUser(
    t: Target,
    personId: string,
    remoteId: string,
    state: UserState,
    audit?: { action: string; data: Record<string, unknown> },
  ): Promise<void> {
    await this.db.tx(async (tx) => {
      await tx.scimLink.upsert({
        where: { targetId_kind_localId: { targetId: t.id, kind: 'user', localId: personId } },
        create: {
          tenantId: t.tenantId,
          targetId: t.id,
          kind: 'user',
          localId: personId,
          remoteId,
          state: { ...state },
        },
        update: { remoteId, state: { ...state }, syncedAt: new Date() },
      });
      if (audit)
        await appendAudit(tx, t.tenantId, {
          actorId: null,
          actorLabel: LABEL,
          action: audit.action,
          targetType: 'identity',
          targetId: personId,
          data: { target: t.name, targetId: t.id, ...audit.data },
        });
    });
  }

  /** Groups mode: the groups a person is in here or there are pushed again after them. */
  private async queueGroupsOf(t: Target, personId: string, remoteId: string): Promise<void> {
    if (t.groupsMode !== 'groups') return;
    await this.db.tx(async (tx) => {
      const here = await tx.membership.findMany({
        where: { identityId: personId, groupId: { in: t.groupIds } },
        select: { groupId: true },
      });
      const there = (await tx.scimLink.findMany({ where: { targetId: t.id, kind: 'group' } })).filter((l) =>
        (l.state as unknown as GroupState).members?.includes(remoteId),
      );
      for (const id of new Set([...here.map((m) => m.groupId), ...there.map((l) => l.localId)]))
        await this.enqueue(tx, t, 'group', id, false);
    });
  }

  // ── Groups ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private async syncGroup(t: Target, client: ScimClient, groupId: string, verify: boolean): Promise<void> {
    const { group, link, members, localOf } = await this.db.tx(async (tx) => {
      const group = await tx.group.findUnique({ where: { id: groupId } });
      const link = await tx.scimLink.findUnique({
        where: { targetId_kind_localId: { targetId: t.id, kind: 'group', localId: groupId } },
      });
      // Its members as the application knows them: people pushed there and active.
      const rows = group
        ? await tx.membership.findMany({
            where: { groupId, identity: { kind: 'person', status: 'active' } },
            select: { identityId: true, grantId: true },
          })
        : [];
      const links = await tx.scimLink.findMany({ where: { targetId: t.id, kind: 'user' } });
      const remoteOf = new Map(
        links.filter((l) => (l.state as unknown as UserState).active).map((l) => [l.localId, l.remoteId]),
      );
      return {
        group,
        link,
        localOf: new Map(links.map((l) => [l.remoteId, l.localId])),
        members: rows
          .filter((r) => remoteOf.has(r.identityId))
          .map((r) => ({ identityId: r.identityId, grantId: r.grantId, remoteId: remoteOf.get(r.identityId)! })),
      };
    });
    if (!group || !t.groupIds.includes(groupId)) {
      if (link) {
        await client.remove('Groups', link.remoteId);
        await this.saveGroup(t, groupId, null, null, {
          action: 'provisioning.group_deleted',
          data: { remoteId: link.remoteId, group: group?.name ?? (link.state as unknown as GroupState).displayName },
        });
      }
      return;
    }
    const next: GroupState = { displayName: group.name, members: members.map((m) => m.remoteId).sort() };
    if (!link) return this.createGroup(t, client, groupId, next, members, localOf);
    let current = link.state as unknown as GroupState;
    if (verify) {
      const remote = await client.get('Groups', link.remoteId);
      if (!remote) {
        await this.dropLink(t, 'group', groupId);
        return this.createGroup(t, client, groupId, next, members, localOf);
      }
      current = {
        displayName: typeof remote.displayName === 'string' ? remote.displayName : current.displayName,
        members: readMembers(remote) ?? current.members,
      };
    }
    const ops = groupOps(current, next);
    if (ops.length === 0) {
      if (verify) await this.saveGroup(t, groupId, link.remoteId, next);
      return;
    }
    if (!(await client.patch('Groups', link.remoteId, ops))) {
      await this.dropLink(t, 'group', groupId);
      return this.createGroup(t, client, groupId, next, members, localOf);
    }
    await this.saveGroup(t, groupId, link.remoteId, next, {
      action: 'provisioning.group_updated',
      data: {
        remoteId: link.remoteId,
        group: group.name,
        ...this.memberChanges(current, next, members, localOf),
        ...(verify ? { drift: true } : {}),
      },
    });
  }

  private async createGroup(
    t: Target,
    client: ScimClient,
    groupId: string,
    next: GroupState,
    members: Array<{ identityId: string; grantId: string | null; remoteId: string }>,
    localOf: Map<string, string>,
  ): Promise<void> {
    let remoteId: string;
    let current: GroupState = { displayName: next.displayName, members: [] };
    let action = 'provisioning.group_created';
    try {
      remoteId = (await client.create('Groups', groupResource(groupId, next))).id;
      current = next;
    } catch (error) {
      if (!(error instanceof ScimError) || error.status !== 409) throw error;
      // A group of that name is there already: adopt it.
      const found = await client.findOne('Groups', 'displayName', next.displayName);
      if (!found) throw error;
      remoteId = found.id;
      const listed = readMembers(found) ?? readMembers((await client.get('Groups', found.id)) ?? found) ?? [];
      current = { displayName: next.displayName, members: listed };
      await client.patch('Groups', remoteId, [
        { op: 'replace', path: 'externalId', value: groupId },
        ...groupOps(current, next),
      ]);
      action = 'provisioning.group_linked';
    }
    await this.saveGroup(t, groupId, remoteId, next, {
      action,
      data: { remoteId, group: next.displayName, ...this.memberChanges(current, next, members, localOf) },
    });
  }

  /**
   * Who was added and removed, as Landbright ids (the application's own ids when it isn't one Landbright pushed), with
   * the grants behind the additions (the grant's timeline reads them).
   */
  private memberChanges(
    current: GroupState,
    next: GroupState,
    members: Array<{ identityId: string; grantId: string | null; remoteId: string }>,
    localOf: Map<string, string>,
  ) {
    const was = new Set(current.members);
    const now = new Set(next.members);
    const added = members.filter((m) => !was.has(m.remoteId));
    return {
      added: added.map((m) => m.identityId),
      removed: current.members.filter((m) => !now.has(m)).map((m) => localOf.get(m) ?? m),
      grants: added.filter((m) => m.grantId).map((m) => ({ identityId: m.identityId, grantId: m.grantId })),
    };
  }

  private async saveGroup(
    t: Target,
    groupId: string,
    remoteId: string | null,
    state: GroupState | null,
    audit?: { action: string; data: Record<string, unknown> },
  ): Promise<void> {
    await this.db.tx(async (tx) => {
      if (remoteId && state)
        await tx.scimLink.upsert({
          where: { targetId_kind_localId: { targetId: t.id, kind: 'group', localId: groupId } },
          create: {
            tenantId: t.tenantId,
            targetId: t.id,
            kind: 'group',
            localId: groupId,
            remoteId,
            state: { ...state },
          },
          update: { remoteId, state: { ...state }, syncedAt: new Date() },
        });
      else await tx.scimLink.deleteMany({ where: { targetId: t.id, kind: 'group', localId: groupId } });
      if (audit)
        await appendAudit(tx, t.tenantId, {
          actorId: null,
          actorLabel: LABEL,
          action: audit.action,
          targetType: 'group',
          targetId: groupId,
          data: { target: t.name, targetId: t.id, ...audit.data },
        });
    });
  }

  private async dropLink(t: Target, kind: Kind, localId: string): Promise<void> {
    await this.db.tx((tx) => tx.scimLink.deleteMany({ where: { targetId: t.id, kind, localId } }));
  }
}
