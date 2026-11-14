import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CreateGroup, Group, GroupDetail } from '@landbright/contracts';
import { ADMINS_GROUP, appendAudit, type Prisma } from '@landbright/persistence';
import { audited, type Principal, type ServicePrincipal } from '../common/principal';
import { TenantDb, uniquely } from '../common/tenant-db';
import { toRef } from './mapping';
import { PeopleService } from './people.service';

type GroupRow = Prisma.GroupGetPayload<{ include: { _count: { select: { members: true } } } }>;

const toGroup = (g: GroupRow): Group => ({
  id: g.id,
  name: g.name,
  description: g.description,
  kind: g.kind,
  memberCount: g._count.members,
  system: g.name === ADMINS_GROUP,
  createdAt: g.createdAt.toISOString(),
});

/**
 * Groups, and who is in them. A group's name is what applications see (the `roles` and `groups` claims), so renaming
 * one changes what every application maps.
 */
@Injectable()
export class GroupsService {
  constructor(
    private readonly db: TenantDb,
    private readonly people: PeopleService,
  ) {}

  /** Every group, or the one with this exact name (a flow looking up a birthright group). */
  list(name?: string): Promise<Group[]> {
    return this.db.tx(async (tx) =>
      (
        await tx.group.findMany({
          where: name ? { name } : undefined,
          include: { _count: { select: { members: true } } },
          orderBy: { name: 'asc' },
        })
      ).map(toGroup),
    );
  }

  get(id: string): Promise<GroupDetail> {
    return this.db.tx(async (tx) => {
      const group = await tx.group.findFirst({
        where: { id },
        include: {
          _count: { select: { members: true } },
          members: { include: { identity: true }, orderBy: { createdAt: 'asc' } },
        },
      });
      if (!group) throw new NotFoundException('No such group.');
      return {
        ...toGroup(group),
        members: group.members.map((m) => ({
          ...toRef(m.identity),
          source: m.source,
          expiresAt: m.expiresAt?.toISOString() ?? null,
          addedAt: m.createdAt.toISOString(),
        })),
      };
    });
  }

  async create(
    input: Required<Omit<CreateGroup, 'description'>> & { description?: string },
    actor: Principal,
  ): Promise<GroupDetail> {
    const id = await uniquely(
      this.db.tx(async (tx) => {
        const group = await tx.group.create({
          data: { tenantId: this.db.tenantId, name: input.name, description: input.description, kind: input.kind },
        });
        await appendAudit(tx, this.db.tenantId, {
          ...audited(actor),
          action: 'group.created',
          targetType: 'group',
          targetId: group.id,
          data: { name: input.name, kind: input.kind },
        });
        return group.id;
      }),
      'A group with that name already exists.',
    );
    return this.get(id);
  }

  async update(id: string, input: Partial<CreateGroup>, actor: Principal): Promise<GroupDetail> {
    await uniquely(
      this.db.tx(async (tx) => {
        const group = await this.find(tx, id);
        if (group.name === ADMINS_GROUP && input.name !== undefined && input.name !== ADMINS_GROUP)
          throw new ForbiddenException('The administrators’ group can’t be renamed.');
        await tx.group.update({
          where: { id },
          data: { name: input.name, description: input.description, kind: input.kind },
        });
        await appendAudit(tx, this.db.tenantId, {
          ...audited(actor),
          action: 'group.updated',
          targetType: 'group',
          targetId: id,
          data: { from: group.name, ...input },
        });
      }),
      'A group with that name already exists.',
    );
    return this.get(id);
  }

  async remove(id: string, actor: Principal): Promise<void> {
    await this.db.tx(async (tx) => {
      const group = await this.find(tx, id);
      if (group.name === ADMINS_GROUP) throw new ForbiddenException('The administrators’ group can’t be deleted.');
      await tx.group.delete({ where: { id } });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'group.deleted',
        targetType: 'group',
        targetId: id,
        data: { name: group.name },
      });
    });
  }

  async addMember(id: string, identityId: string, actor: Principal): Promise<GroupDetail> {
    await this.db.tx(async (tx) => {
      const group = await this.find(tx, id);
      const identity = await tx.identity.findFirst({ where: { id: identityId } });
      if (!identity) throw new BadRequestException('No such person or agent.');
      if (group.name === ADMINS_GROUP && identity.kind !== 'person')
        throw new BadRequestException('Only people can administer Landbright.');
      const existing = await tx.membership.findUnique({ where: { groupId_identityId: { groupId: id, identityId } } });
      if (existing) throw new ConflictException(`${identity.displayName} is already in ${group.name}.`);
      await tx.membership.create({ data: { tenantId: this.db.tenantId, groupId: id, identityId } });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'group.member_added',
        targetType: 'group',
        targetId: id,
        data: { group: group.name, identityId, identity: identity.displayName },
      });
    });
    return this.get(id);
  }

  async removeMember(id: string, identityId: string, actor: Principal): Promise<GroupDetail> {
    await this.db.tx(async (tx) => {
      const group = await this.find(tx, id);
      const membership = await tx.membership.findUnique({
        where: { groupId_identityId: { groupId: id, identityId } },
        include: { identity: true },
      });
      if (!membership) throw new NotFoundException('Not a member.');
      if (group.name === ADMINS_GROUP) await this.people.assertNotLastAdmin(tx, identityId);
      await tx.membership.delete({ where: { groupId_identityId: { groupId: id, identityId } } });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'group.member_removed',
        targetType: 'group',
        targetId: id,
        data: { group: group.name, identityId, identity: membership.identity.displayName },
      });
    });
    return this.get(id);
  }

  /**
   * A lifecycle flow adds someone (birthright groups at onboarding): source `hr`, optionally until a time. Already a
   * member: nothing changes. Never the administrators' group: a token must not make anyone an administrator.
   */
  async addMemberAsService(
    id: string,
    identityId: string,
    expiresAt: string | undefined,
    service: ServicePrincipal,
  ): Promise<GroupDetail> {
    await this.db.tx(async (tx) => {
      const group = await this.find(tx, id);
      if (group.name === ADMINS_GROUP)
        throw new ForbiddenException('Only an administrator can add someone to the administrators’ group.');
      const identity = await tx.identity.findFirst({ where: { id: identityId } });
      if (!identity) throw new BadRequestException('No such person or agent.');
      if (identity.status === 'deactivated') throw new ConflictException(`${identity.displayName} is deactivated.`);
      const existing = await tx.membership.findUnique({ where: { groupId_identityId: { groupId: id, identityId } } });
      if (existing) return;
      await tx.membership.create({
        data: {
          tenantId: this.db.tenantId,
          groupId: id,
          identityId,
          source: 'hr',
          expiresAt: expiresAt ? new Date(expiresAt) : null,
        },
      });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(service),
        action: 'group.member_added',
        targetType: 'group',
        targetId: id,
        data: {
          group: group.name,
          identityId,
          identity: identity.displayName,
          source: 'hr',
          ...(expiresAt && { expiresAt }),
        },
      });
    });
    return this.get(id);
  }

  /**
   * A lifecycle flow removes someone (a mover leaving a department). Not a just-in-time membership (its grant owns
   * it) and not from the administrators' group. Not a member: nothing changes.
   */
  async removeMemberAsService(id: string, identityId: string, service: ServicePrincipal): Promise<GroupDetail> {
    await this.db.tx(async (tx) => {
      const group = await this.find(tx, id);
      if (group.name === ADMINS_GROUP)
        throw new ForbiddenException('Only an administrator can remove someone from the administrators’ group.');
      const membership = await tx.membership.findUnique({
        where: { groupId_identityId: { groupId: id, identityId } },
        include: { identity: true },
      });
      if (!membership) return;
      if (membership.source === 'grant')
        throw new ConflictException('This membership belongs to a just-in-time grant; revoke the grant instead.');
      await tx.membership.delete({ where: { groupId_identityId: { groupId: id, identityId } } });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(service),
        action: 'group.member_removed',
        targetType: 'group',
        targetId: id,
        data: { group: group.name, identityId, identity: membership.identity.displayName },
      });
    });
    return this.get(id);
  }

  private async find(tx: Prisma.TransactionClient, id: string) {
    const group = await tx.group.findFirst({ where: { id } });
    if (!group) throw new NotFoundException('No such group.');
    return group;
  }
}
