import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Agent, CreateAgent, UpdateAgent } from '@landbright/contracts';
import { appendAudit, type Prisma } from '@landbright/persistence';
import { audited, type Principal } from '../common/principal';
import { TenantDb } from '../common/tenant-db';
import { agentInclude, type AgentRow, toAgent } from './mapping';

type CreateAgentInput = Required<Omit<CreateAgent, 'homeProject'>> & { homeProject?: string };

/**
 * Agent identities: who they are, who sponsors them, how far they may act. They get credentials and tokens in wave 5;
 * in wave 1 they are directory entries that groups and the audit log can refer to.
 */
@Injectable()
export class AgentsService {
  constructor(private readonly db: TenantDb) {}

  list(): Promise<Agent[]> {
    return this.db.tx(async (tx) =>
      (
        await tx.identity.findMany({ where: { kind: 'agent' }, include: agentInclude, orderBy: { displayName: 'asc' } })
      ).map(toAgent),
    );
  }

  get(id: string): Promise<Agent> {
    return this.db.tx(async (tx) => toAgent(await this.find(tx, id)));
  }

  async create(input: CreateAgentInput, actor: Principal): Promise<Agent> {
    const tenantId = this.db.tenantId;
    const id = await this.db.tx(async (tx) => {
      await this.requireSponsor(tx, input.sponsorId);
      const row = await tx.identity.create({
        data: {
          tenantId,
          kind: 'agent',
          displayName: input.displayName,
          agent: {
            create: {
              tenantId,
              sponsorId: input.sponsorId,
              purpose: input.purpose,
              riskTier: input.riskTier,
              runtime: input.runtime,
              homeProject: input.homeProject,
              maxTokenTtlSeconds: input.maxTokenTtlSeconds,
              actFor: input.actFor,
            },
          },
        },
      });
      await appendAudit(tx, tenantId, {
        ...audited(actor),
        action: 'identity.created',
        targetType: 'identity',
        targetId: row.id,
        data: { kind: 'agent', sponsorId: input.sponsorId, riskTier: input.riskTier, runtime: input.runtime },
      });
      return row.id;
    });
    return this.get(id);
  }

  async update(id: string, input: UpdateAgent, actor: Principal): Promise<Agent> {
    await this.db.tx(async (tx) => {
      await this.find(tx, id);
      if (input.sponsorId) await this.requireSponsor(tx, input.sponsorId);
      const { displayName, ...profile } = input;
      await tx.identity.update({ where: { id }, data: { displayName, agent: { update: profile } } });
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

  async setStatus(id: string, status: 'active' | 'suspended', actor: Principal): Promise<Agent> {
    await this.db.tx(async (tx) => {
      const row = await this.find(tx, id);
      if (row.status === status) return;
      if (status === 'active' && row.agent!.sponsor.status !== 'active')
        throw new BadRequestException('Its sponsor is not active. Give the agent an active sponsor first.');
      await tx.identity.update({ where: { id }, data: { status } });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: status === 'active' ? 'identity.resumed' : 'identity.suspended',
        targetType: 'identity',
        targetId: id,
      });
    });
    return this.get(id);
  }

  private async find(tx: Prisma.TransactionClient, id: string): Promise<AgentRow> {
    const row = await tx.identity.findFirst({ where: { id, kind: 'agent' }, include: agentInclude });
    if (!row?.agent) throw new NotFoundException('No such agent.');
    return row;
  }

  /** Every agent has an accountable person (constitution principle III). */
  private async requireSponsor(tx: Prisma.TransactionClient, sponsorId: string): Promise<void> {
    const sponsor = await tx.identity.findFirst({
      where: { id: sponsorId, kind: 'person', status: 'active' },
      select: { id: true },
    });
    if (!sponsor) throw new BadRequestException('The sponsor must be an active person.');
  }
}
