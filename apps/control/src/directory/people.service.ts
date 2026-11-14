import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  CreatePerson,
  InviteResult,
  Person,
  RequiredAction,
  SetRequiredActions,
  UpdatePerson,
} from '@landbright/contracts';
import { type Config, newToken } from '@landbright/platform';
import {
  ADMINS_GROUP,
  appendAudit,
  CONFIG,
  logoutsOfSessions,
  type Prisma,
  queueLogouts,
} from '@landbright/persistence';
import { audited, type Principal, type ServicePrincipal } from '../common/principal';
import { closeGrantsOf } from '../access/grants';
import { TenantDb, toDate, uniquely } from '../common/tenant-db';
import { Mailer } from '../mail/mailer';
import { displayNameOf, personInclude, type PersonRow, toPerson } from './mapping';

export const INVITE_TTL_HOURS = 72;

@Injectable()
export class PeopleService {
  private readonly logger = new Logger(PeopleService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly mailer: Mailer,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  list(): Promise<Person[]> {
    return this.db.tx(async (tx) => {
      const rows = await tx.identity.findMany({
        where: { kind: 'person' },
        include: personInclude,
        orderBy: { displayName: 'asc' },
      });
      return this.withManagers(tx, rows);
    });
  }

  get(id: string): Promise<Person> {
    return this.db.tx(async (tx) => (await this.withManagers(tx, [await this.find(tx, id)]))[0]!);
  }

  async create(
    input: CreatePerson & { groupIds: string[]; sendInvite: boolean; familyName: string },
    actor: Principal,
  ): Promise<Person> {
    const tenantId = this.db.tenantId;
    const person = await uniquely(
      this.db.tx(async (tx) => {
        if (input.managerId) await this.requireActivePerson(tx, input.managerId, 'manager');
        const groups = input.groupIds.length ? await tx.group.findMany({ where: { id: { in: input.groupIds } } }) : [];
        if (groups.length !== new Set(input.groupIds).size)
          throw new BadRequestException('One of the groups doesn’t exist.');
        const row = await tx.identity.create({
          data: {
            tenantId,
            kind: 'person',
            displayName: displayNameOf(input.givenName, input.familyName),
            email: input.email,
            person: {
              create: {
                tenantId,
                givenName: input.givenName,
                familyName: input.familyName,
                department: input.department,
                title: input.title,
                site: input.site,
                managerId: input.managerId,
                startDate: toDate(input.startDate),
              },
            },
            memberships: { create: groups.map((g) => ({ tenantId, groupId: g.id })) },
          },
        });
        await appendAudit(tx, tenantId, {
          ...audited(actor),
          action: 'identity.created',
          targetType: 'identity',
          targetId: row.id,
          data: { kind: 'person', email: input.email, groups: groups.map((g) => g.name) },
        });
        return row;
      }),
      'Someone with that email is already in the directory.',
    );
    if (input.sendInvite) {
      try {
        await this.invite(person.id, actor);
      } catch (error) {
        // The person exists either way; the console shows "no password yet" and offers to send the invite again.
        this.logger.warn(
          `invite to ${input.email} not sent: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return this.get(person.id);
  }

  async update(id: string, input: UpdatePerson, actor: Principal): Promise<Person> {
    await this.db.tx(async (tx) => {
      const row = await this.find(tx, id);
      if (input.managerId) {
        if (input.managerId === id) throw new BadRequestException('A person can’t be their own manager.');
        await this.requireActivePerson(tx, input.managerId, 'manager');
      }
      const givenName = input.givenName ?? row.person?.givenName ?? row.displayName;
      const familyName = input.familyName ?? row.person?.familyName ?? '';
      const profile = {
        givenName,
        familyName,
        department: input.department,
        title: input.title,
        site: input.site,
        managerId: input.managerId,
        startDate: toDate(input.startDate),
        endDate: toDate(input.endDate),
      };
      await tx.identity.update({
        where: { id },
        data: {
          displayName: displayNameOf(givenName, familyName),
          person: {
            upsert: {
              create: { tenantId: this.db.tenantId, ...profile, managerId: profile.managerId ?? undefined },
              update: profile,
            },
          },
        },
      });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'identity.updated',
        targetType: 'identity',
        targetId: id,
        data: { fields: Object.keys(input) },
      });
    });
    return this.get(id);
  }

  /**
   * Deactivated people can't sign in, and lose every session and token at once: their oidc-provider sessions,
   * grants and refresh tokens are deleted. Agents they sponsor are suspended, since nobody is accountable for them.
   */
  async deactivate(id: string, actor: Principal | ServicePrincipal, reason?: string): Promise<Person> {
    if (actor.kind === 'person' && id === actor.id) throw new BadRequestException('You can’t deactivate yourself.');
    await this.db.tx(async (tx) => {
      const row = await this.find(tx, id);
      if (row.status === 'deactivated') return;
      await this.assertNotLastAdmin(tx, id);
      await tx.identity.update({ where: { id }, data: { status: 'deactivated' } });
      await tx.inviteToken.deleteMany({ where: { identityId: id, usedAt: null } });
      const agents = await tx.agentProfile.findMany({
        where: { sponsorId: id, identity: { status: 'active' } },
        select: { identityId: true },
      });
      if (agents.length)
        await tx.identity.updateMany({
          where: { id: { in: agents.map((a) => a.identityId) } },
          data: { status: 'suspended' },
        });
      // Applications that take back-channel logout are told: one logout token per session they hold, and one for all
      // sessions where they hold a grant but no session here (their own session outlives Landbright's).
      const held = await tx.$queryRaw<Array<{ type: string; payload: Record<string, unknown> }>>`
        SELECT type, payload FROM oidc_payload WHERE payload->>'accountId' = ${id} AND type IN ('Session', 'Grant')`;
      const perSession = logoutsOfSessions(held.filter((r) => r.type === 'Session').map((r) => r.payload));
      const withSession = new Set(perSession.map((o) => o.clientId));
      const grantOnly = [
        ...new Set(held.filter((r) => r.type === 'Grant').map((r) => String(r.payload.clientId ?? ''))),
      ]
        .filter((c) => c && !withSession.has(c))
        .map((clientId) => ({ clientId, subject: id, sid: null }));
      const logoutsQueued = await queueLogouts(tx, this.db.tenantId, [...perSession, ...grantOnly], 'deactivated');
      const revoked = await tx.$executeRaw`DELETE FROM oidc_payload WHERE payload->>'accountId' = ${id}`;
      // Just-in-time access ends with them: their grants and their agents' grants, and their pending requests.
      const grantsRevoked = await closeGrantsOf(
        tx,
        this.db.tenantId,
        [id, ...agents.map((a) => a.identityId)],
        audited(actor),
      );
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'identity.deactivated',
        targetType: 'identity',
        targetId: id,
        data: {
          agentsSuspended: agents.map((a) => a.identityId),
          sessionsAndTokensRevoked: revoked,
          logoutsQueued,
          grantsRevoked,
          ...(reason && { reason }),
        },
      });
    });
    return this.get(id);
  }

  async reactivate(id: string, actor: Principal): Promise<Person> {
    await this.db.tx(async (tx) => {
      const row = await this.find(tx, id);
      if (row.status === 'active') return;
      await tx.identity.update({ where: { id }, data: { status: 'active' } });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'identity.reactivated',
        targetType: 'identity',
        targetId: id,
      });
    });
    return this.get(id);
  }

  /** For someone who lost their phone: removes their authenticator app; they set up a new one at the next sign-in. */
  async resetSecondStep(id: string, actor: Principal): Promise<Person> {
    await this.db.tx(async (tx) => {
      await this.find(tx, id);
      const removed = await tx.credential.deleteMany({
        where: { identityId: id, kind: { in: ['totp', 'passkey', 'recovery_code'] } },
      });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'credential.second_step_reset',
        targetType: 'identity',
        targetId: id,
        data: { removed: removed.count },
      });
    });
    return this.get(id);
  }

  /** A one-time link to set a password, by email. Sending a new one cancels the old. */
  async invite(id: string, actor: Principal): Promise<InviteResult> {
    const { token, hash } = newToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3_600_000);
    const row = await this.db.tx(async (tx) => {
      const person = await this.find(tx, id);
      if (person.status !== 'active') throw new ConflictException('Only active people can be invited.');
      if (!person.email) throw new ConflictException('This person has no email address.');
      await tx.inviteToken.deleteMany({ where: { identityId: id, usedAt: null, purpose: 'invite' } });
      await tx.inviteToken.create({ data: { tenantId: this.db.tenantId, identityId: id, tokenHash: hash, expiresAt } });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'identity.invited',
        targetType: 'identity',
        targetId: id,
        data: { email: person.email, expiresAt: expiresAt.toISOString() },
      });
      return person;
    });
    await this.mailer.sendInvite({
      to: row.email!,
      name: row.person?.givenName || row.displayName,
      link: new URL(`/invite/${token}`, this.config.LANDBRIGHT_IDP_URL).href,
      expiresAt,
      invitedBy: actor.displayName,
      tenantName: this.db.tenant.name,
    });
    return { sentTo: row.email!, expiresAt: expiresAt.toISOString() };
  }

  /**
   * What they must do at their next sign-in (Keycloak's required actions), replacing what was required before. With
   * `notify`, an email: a one-time link to set a new password when update_password is among them (so it works for
   * someone who forgot theirs; the other actions run at the sign-in after), otherwise a link to sign in.
   */
  async setRequiredActions(
    id: string,
    input: SetRequiredActions,
    actor: Principal | ServicePrincipal,
  ): Promise<Person & { notified: string | null }> {
    const actions = [...new Set(input.actions)] as RequiredAction[];
    let link: { token: string; expiresAt: Date } | undefined;
    const row = await this.db.tx(async (tx) => {
      const person = await this.find(tx, id);
      if (person.status !== 'active') throw new ConflictException('Only active people can be asked to do something.');
      if (input.notify && !person.email) throw new ConflictException('This person has no email address.');
      await tx.identity.update({ where: { id }, data: { requiredActions: actions } });
      if (input.notify && actions.includes('update_password')) {
        const { token, hash } = newToken();
        link = { token, expiresAt: new Date(Date.now() + INVITE_TTL_HOURS * 3_600_000) };
        await tx.inviteToken.deleteMany({ where: { identityId: id, usedAt: null, purpose: 'reset' } });
        await tx.inviteToken.create({
          data: {
            tenantId: this.db.tenantId,
            identityId: id,
            tokenHash: hash,
            expiresAt: link.expiresAt,
            purpose: 'reset',
          },
        });
      }
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'identity.required_actions_set',
        targetType: 'identity',
        targetId: id,
        data: { actions, notified: Boolean(input.notify) },
      });
      return person;
    });
    if (input.notify && actions.length) {
      await this.mailer.sendActions({
        to: row.email!,
        name: row.person?.givenName || row.displayName,
        actions,
        link: new URL(link ? `/reset/${link.token}` : '/account', this.config.LANDBRIGHT_IDP_URL).href,
        expiresAt: link?.expiresAt,
        requestedBy: actor.kind === 'person' ? actor.displayName : actor.name,
        tenantName: this.db.tenant.name,
      });
    }
    return { ...(await this.get(id)), notified: input.notify && actions.length ? row.email : null };
  }

  private async find(tx: Prisma.TransactionClient, id: string): Promise<PersonRow> {
    const row = await tx.identity.findFirst({ where: { id, kind: 'person' }, include: personInclude });
    if (!row) throw new NotFoundException('No such person.');
    return row;
  }

  private async withManagers(tx: Prisma.TransactionClient, rows: PersonRow[]): Promise<Person[]> {
    const ids = [...new Set(rows.map((r) => r.person?.managerId).filter((m): m is string => Boolean(m)))];
    const managers = ids.length ? await tx.identity.findMany({ where: { id: { in: ids } } }) : [];
    const byId = new Map(managers.map((m) => [m.id, m]));
    return rows.map((r) => toPerson(r, byId));
  }

  private async requireActivePerson(tx: Prisma.TransactionClient, id: string, role: string): Promise<void> {
    const found = await tx.identity.findFirst({
      where: { id, kind: 'person', status: 'active' },
      select: { id: true },
    });
    if (!found) throw new BadRequestException(`The ${role} must be an active person.`);
  }

  /** The console must always have someone who can open it. */
  /**
   * Active people who haven't signed in since `since` (or, never having signed in, were created before it), for a
   * scheduled lifecycle flow. Each with their manager, whom such a flow usually tells first.
   */
  async inactiveSince(since: Date) {
    return this.db.tx(async (tx) => {
      const rows = await tx.identity.findMany({
        where: {
          kind: 'person',
          status: 'active',
          OR: [{ lastSignInAt: { lt: since } }, { lastSignInAt: null, createdAt: { lt: since } }],
        },
        include: { person: true, memberships: { include: { group: { select: { name: true } } } } },
        orderBy: { lastSignInAt: { sort: 'asc', nulls: 'first' } },
        take: 500,
      });
      const managerIds = rows.map((r) => r.person?.managerId).filter((id): id is string => !!id);
      const managers = new Map(
        (await tx.identity.findMany({ where: { id: { in: managerIds } } })).map((m) => [m.id, m] as const),
      );
      return rows.map((r) => {
        const m = r.person?.managerId ? managers.get(r.person.managerId) : undefined;
        return {
          id: r.id,
          displayName: r.displayName,
          email: r.email,
          status: r.status,
          lastSignInAt: r.lastSignInAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
          manager: m ? { id: m.id, displayName: m.displayName, email: m.email } : null,
          admin: r.memberships.some((x) => x.group.name === ADMINS_GROUP),
        };
      });
    });
  }

  async assertNotLastAdmin(tx: Prisma.TransactionClient, id: string): Promise<void> {
    const admins = await tx.membership.findMany({
      where: { group: { name: ADMINS_GROUP }, identity: { status: 'active', kind: 'person' } },
      select: { identityId: true },
    });
    if (admins.length === 1 && admins[0]!.identityId === id)
      throw new ConflictException('This is the last active administrator. Make someone else an administrator first.');
  }
}
