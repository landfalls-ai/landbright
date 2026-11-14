import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateScimTarget,
  ScimJobView,
  ScimLinkView,
  ScimTarget,
  ScimTargetDetail,
  ScimTestResult,
  UpdateScimTarget,
} from '@landbright/contracts';
import { type Config, seal, unseal } from '@landbright/platform';
import { appendAudit, CONFIG, type Prisma } from '@landbright/persistence';
import { audited, type Principal } from '../common/principal';
import { TenantDb } from '../common/tenant-db';
import { eqFilter, ScimClient, ScimError } from './scim-client';
import type { GroupState, UserState } from './scim-ops';

type Tx = Prisma.TransactionClient;
type Row = Prisma.ScimTargetGetPayload<{ include: { client: true } }>;

/**
 * Provisioning targets: an application's SCIM server, its token (sealed, write-only) and the groups assigned to it.
 * The pushing is ScimSync's; this is what an administrator sees and changes. Any change queues a full comparison.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    private readonly db: TenantDb,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  async list(): Promise<ScimTarget[]> {
    return this.db.tx(async (tx) => {
      const rows = await tx.scimTarget.findMany({ include: { client: true }, orderBy: { createdAt: 'asc' } });
      return Promise.all(rows.map((r) => this.view(tx, r)));
    });
  }

  async get(id: string): Promise<ScimTargetDetail> {
    return this.db.tx(async (tx) => {
      const row = await tx.scimTarget.findUnique({ where: { id }, include: { client: true } });
      if (!row) throw new NotFoundException('No such provisioning target.');
      const links = await tx.scimLink.findMany({
        where: { targetId: id },
        orderBy: [{ kind: 'desc' }, { syncedAt: 'desc' }],
      });
      const jobs = await tx.scimJob.findMany({ where: { targetId: id }, orderBy: { queuedAt: 'asc' }, take: 200 });
      const ids = [...new Set([...links, ...jobs].map((x) => x.localId))];
      const people = new Map(
        (
          await tx.identity.findMany({
            where: { id: { in: ids } },
            select: { id: true, displayName: true, email: true },
          })
        ).map((p) => [p.id, p]),
      );
      const groups = new Map(
        (await tx.group.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((g) => [
          g.id,
          g,
        ]),
      );
      const nameOf = (kind: string, id: string) =>
        kind === 'user' ? (people.get(id)?.displayName ?? null) : (groups.get(id)?.name ?? null);
      return {
        ...(await this.view(tx, row)),
        links: links.map((l): ScimLinkView => ({
          kind: l.kind as 'user' | 'group',
          localId: l.localId,
          name:
            nameOf(l.kind, l.localId) ?? (l.kind === 'group' ? (l.state as unknown as GroupState).displayName : null),
          email:
            l.kind === 'user' ? (people.get(l.localId)?.email ?? (l.state as unknown as UserState).userName) : null,
          remoteId: l.remoteId,
          active: l.kind === 'user' ? (l.state as unknown as UserState).active : null,
          members: l.kind === 'group' ? ((l.state as unknown as GroupState).members?.length ?? 0) : null,
          syncedAt: l.syncedAt.toISOString(),
        })),
        jobs: jobs.map((j): ScimJobView => ({
          kind: j.kind as 'user' | 'group',
          localId: j.localId,
          name: nameOf(j.kind, j.localId),
          verify: j.verify,
          attempts: j.attempts,
          nextAttemptAt: j.nextAttemptAt.toISOString(),
          lastError: j.lastError,
          queuedAt: j.queuedAt.toISOString(),
        })),
      };
    });
  }

  async create(body: CreateScimTarget, actor: Principal): Promise<ScimTargetDetail> {
    const id = await this.db.tx(async (tx) => {
      await this.checkRefs(tx, body.groupIds, body.applicationId);
      // From now on: what happened before is caught up by the first reconciliation, not replayed.
      const newest = await tx.auditEvent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
      const row = await tx.scimTarget.create({
        data: {
          tenantId: this.db.tenantId,
          name: body.name,
          baseUrl: body.baseUrl,
          tokenSealed: seal(this.config.LANDBRIGHT_SECRET_KEY, body.token),
          groupsMode: body.groupsMode,
          groupIds: body.groupIds,
          clientId: body.applicationId ?? null,
          disabled: body.disabled,
          cursor: newest?.id ?? 0n,
          createdBy: actor.displayName,
        },
      });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'provisioning.target_created',
        targetType: 'scim_target',
        targetId: row.id,
        data: { name: body.name, baseUrl: body.baseUrl, groupsMode: body.groupsMode, groupIds: body.groupIds },
      });
      return row.id;
    });
    return this.get(id);
  }

  async update(id: string, body: UpdateScimTarget, actor: Principal): Promise<ScimTargetDetail> {
    await this.db.tx(async (tx) => {
      const row = await tx.scimTarget.findUnique({ where: { id } });
      if (!row) throw new NotFoundException('No such provisioning target.');
      await this.checkRefs(tx, body.groupIds ?? [], body.applicationId);
      await tx.scimTarget.update({
        where: { id },
        data: {
          name: body.name,
          baseUrl: body.baseUrl,
          groupsMode: body.groupsMode,
          groupIds: body.groupIds,
          clientId: body.applicationId === undefined ? undefined : body.applicationId,
          disabled: body.disabled,
          // Compare everything again with what the application holds.
          lastReconciledAt: null,
        },
      });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'provisioning.target_updated',
        targetType: 'scim_target',
        targetId: id,
        data: {
          name: body.name ?? row.name,
          changed: Object.keys(body).filter((k) => body[k as keyof typeof body] !== undefined),
        },
      });
    });
    return this.get(id);
  }

  async replaceToken(id: string, token: string, actor: Principal): Promise<ScimTargetDetail> {
    await this.db.tx(async (tx) => {
      const row = await tx.scimTarget.findUnique({ where: { id } });
      if (!row) throw new NotFoundException('No such provisioning target.');
      await tx.scimTarget.update({
        where: { id },
        data: { tokenSealed: seal(this.config.LANDBRIGHT_SECRET_KEY, token) },
      });
      // Whatever was failing for want of a token is tried now.
      await tx.scimJob.updateMany({ where: { targetId: id }, data: { nextAttemptAt: new Date() } });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'provisioning.target_token_replaced',
        targetType: 'scim_target',
        targetId: id,
        data: { name: row.name },
      });
    });
    return this.get(id);
  }

  /** *Sync now*: compare everything again, and try what is failing at once. */
  async sync(id: string, actor: Principal): Promise<ScimTargetDetail> {
    await this.db.tx(async (tx) => {
      const row = await tx.scimTarget.findUnique({ where: { id } });
      if (!row) throw new NotFoundException('No such provisioning target.');
      await tx.scimTarget.update({ where: { id }, data: { lastReconciledAt: null } });
      await tx.scimJob.updateMany({ where: { targetId: id }, data: { nextAttemptAt: new Date() } });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'provisioning.target_sync_requested',
        targetType: 'scim_target',
        targetId: id,
        data: { name: row.name },
      });
    });
    return this.get(id);
  }

  /** Deleting a target leaves the application as it is: its people stay there, no longer kept in step. */
  async remove(id: string, actor: Principal): Promise<void> {
    await this.db.tx(async (tx) => {
      const row = await tx.scimTarget.findUnique({ where: { id } });
      if (!row) throw new NotFoundException('No such provisioning target.');
      await tx.scimTarget.delete({ where: { id } });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'provisioning.target_deleted',
        targetType: 'scim_target',
        targetId: id,
        data: { name: row.name, baseUrl: row.baseUrl },
      });
    });
  }

  /** *Test*: does the server answer, and does it take the token (a filtered `GET /Users` that finds nobody)? */
  async test(id: string): Promise<ScimTestResult> {
    const row = await this.db.tx((tx) => tx.scimTarget.findUnique({ where: { id } }));
    if (!row) throw new NotFoundException('No such provisioning target.');
    const client = new ScimClient(row.baseUrl, unseal(this.config.LANDBRIGHT_SECRET_KEY, row.tokenSealed));
    let patch: boolean | null = null;
    let filter: boolean | null = null;
    try {
      const { body } = await client.call<{ patch?: { supported?: boolean }; filter?: { supported?: boolean } }>(
        'GET',
        '/ServiceProviderConfig',
      );
      patch = body?.patch?.supported ?? null;
      filter = body?.filter?.supported ?? null;
    } catch {
      // Not every server has it, or lets it be read: the next call says what matters.
    }
    try {
      const query = new URLSearchParams({ filter: eqFilter('userName', 'landbright-test@invalid.test') });
      const { status } = await client.call('GET', `/Users?${query}`);
      return { ok: true, status, detail: 'The server answered and took the token.', patch, filter };
    } catch (error) {
      const status = error instanceof ScimError ? error.status : null;
      const detail =
        status === 401 || status === 403
          ? 'The server refused the token.'
          : status === null
            ? `No answer: ${error instanceof Error ? error.message : String(error)}`
            : (error as Error).message;
      return { ok: false, status, detail, patch, filter };
    }
  }

  private async checkRefs(tx: Tx, groupIds: string[], applicationId: string | null | undefined): Promise<void> {
    if (groupIds.length) {
      const found = await tx.group.count({ where: { id: { in: groupIds } } });
      if (found !== new Set(groupIds).size) throw new BadRequestException('Some of those groups don’t exist.');
    }
    if (applicationId && !(await tx.oidcClient.findUnique({ where: { id: applicationId } })))
      throw new BadRequestException('No such application.');
  }

  private async view(tx: Tx, r: Row): Promise<ScimTarget> {
    const [links, groups, queued, failing, lastFailure] = await Promise.all([
      tx.scimLink.findMany({ where: { targetId: r.id }, select: { kind: true, state: true } }),
      tx.group.findMany({ where: { id: { in: r.groupIds } }, select: { id: true, name: true } }),
      tx.scimJob.count({ where: { targetId: r.id } }),
      tx.scimJob.count({ where: { targetId: r.id, attempts: { gt: 0 } } }),
      tx.scimJob.findFirst({
        where: { targetId: r.id, attempts: { gt: 0 } },
        orderBy: { nextAttemptAt: 'desc' },
        select: { lastError: true },
      }),
    ]);
    const users = links.filter((l) => l.kind === 'user');
    const active = users.filter((l) => (l.state as unknown as UserState).active).length;
    const byId = new Map(groups.map((g) => [g.id, g.name]));
    return {
      id: r.id,
      name: r.name,
      baseUrl: r.baseUrl,
      groupsMode: r.groupsMode as ScimTarget['groupsMode'],
      groups: r.groupIds.filter((g) => byId.has(g)).map((g) => ({ id: g, name: byId.get(g)! })),
      application: r.client ? { id: r.client.id, clientId: r.client.clientId, name: r.client.name } : null,
      disabled: r.disabled,
      state: r.disabled ? 'disabled' : failing ? 'failing' : queued || !r.lastReconciledAt ? 'pushing' : 'in_sync',
      counts: { active, inactive: users.length - active, groups: links.length - users.length },
      queued,
      failing,
      lastError: lastFailure?.lastError ?? null,
      lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
      lastReconciledAt: r.lastReconciledAt?.toISOString() ?? null,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
