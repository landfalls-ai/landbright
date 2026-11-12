import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { CreatePerson, InviteResult, Person, UpdatePerson } from '@landbright/contracts';
import { type Config, newToken } from '@landbright/platform';
import { ADMINS_GROUP, appendAudit, CONFIG, type Prisma } from '@landbright/persistence';
import { audited, type Principal } from '../common/principal';
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
  async deactivate(id: string, actor: Principal): Promise<Person> {
    if (id === actor.id) throw new BadRequestException('You can’t deactivate yourself.');
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
      const revoked = await tx.$executeRaw`DELETE FROM oidc_payload WHERE payload->>'accountId' = ${id}`;
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'identity.deactivated',
        targetType: 'identity',
        targetId: id,
        data: { agentsSuspended: agents.map((a) => a.identityId), sessionsAndTokensRevoked: revoked },
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
      const removed = await tx.credential.deleteMany({ where: { identityId: id, kind: { in: ['totp', 'passkey'] } } });
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
      await tx.inviteToken.deleteMany({ where: { identityId: id, usedAt: null } });
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
  async assertNotLastAdmin(tx: Prisma.TransactionClient, id: string): Promise<void> {
    const admins = await tx.membership.findMany({
      where: { group: { name: ADMINS_GROUP }, identity: { status: 'active', kind: 'person' } },
      select: { identityId: true },
    });
    if (admins.length === 1 && admins[0]!.identityId === id)
      throw new ConflictException('This is the last active administrator. Make someone else an administrator first.');
  }
}
