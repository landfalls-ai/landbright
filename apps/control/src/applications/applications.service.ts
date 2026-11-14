import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  type Application,
  type ApplicationWithSecret,
  type CreateAgentApplication,
  type CreateApplication,
  type PublicJwks,
  type UpdateApplication,
} from '@landbright/contracts';
import { type Config, clientSecret, issuerOf } from '@landbright/platform';
import { appendAudit, CONFIG, type Prisma } from '@landbright/persistence';
import { audited, type Principal } from '../common/principal';
import { TenantDb, uniquely } from '../common/tenant-db';

type ClientRow = Prisma.OidcClientGetPayload<object>;

const toApplication = (c: ClientRow): Application => ({
  id: c.id,
  clientId: c.clientId,
  name: c.name,
  redirectUris: c.redirectUris,
  postLogoutRedirectUris: c.postLogoutRedirectUris,
  grantTypes: c.grantTypes,
  apiScopes: c.apiScopes,
  minimumAcr: (c.minimumAcr as Application['minimumAcr']) ?? null,
  system: c.system,
  agentId: c.agentId,
  tokenEndpointAuthMethod: c.tokenEndpointAuthMethod,
  keys: Array.isArray((c.jwks as { keys?: unknown[] } | null)?.keys) ? (c.jwks as { keys: unknown[] }).keys.length : 0,
  secretVersion: c.secretVersion,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

/** `Landflow (dev)` → `landflow-dev`. */
export function clientIdFrom(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return slug.length >= 2 ? slug : `app-${slug || 'client'}`;
}

/**
 * Applications that sign in with Landbright. Secrets are derived (never stored) and shown once; rotating bumps the
 * secret version, which retires the old secret immediately.
 */
@Injectable()
export class ApplicationsService {
  constructor(
    private readonly db: TenantDb,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  get issuer(): string {
    return issuerOf(this.config);
  }

  list(): Promise<Application[]> {
    return this.db.tx(async (tx) =>
      (await tx.oidcClient.findMany({ orderBy: [{ system: 'desc' }, { name: 'asc' }] })).map(toApplication),
    );
  }

  get(id: string): Promise<Application> {
    return this.db.tx(async (tx) => toApplication(await this.find(tx, id)));
  }

  async create(input: z_CreateApplication, actor: Principal): Promise<ApplicationWithSecret> {
    const clientId = input.clientId ?? clientIdFrom(input.name);
    const row = await uniquely(
      this.db.tx(async (tx) => {
        const created = await tx.oidcClient.create({
          data: {
            tenantId: this.db.tenantId,
            clientId,
            name: input.name,
            redirectUris: input.redirectUris,
            postLogoutRedirectUris: input.postLogoutRedirectUris,
            grantTypes: input.grantTypes,
            apiScopes: input.apiScopes,
            minimumAcr: input.minimumAcr ?? null,
            tokenEndpointAuthMethod: input.tokenEndpointAuthMethod ?? 'client_secret_basic',
          },
        });
        await appendAudit(tx, this.db.tenantId, {
          ...audited(actor),
          action: 'client.created',
          targetType: 'client',
          targetId: clientId,
          data: {
            name: input.name,
            redirectUris: input.redirectUris,
            grantTypes: input.grantTypes,
            apiScopes: input.apiScopes,
            minimumAcr: input.minimumAcr ?? null,
            tokenEndpointAuthMethod: input.tokenEndpointAuthMethod ?? 'client_secret_basic',
          },
        });
        return created;
      }),
      `The client id "${clientId}" is taken. Choose another.`,
    );
    return this.withSecret(row);
  }

  /**
   * An agent's own application: bound to the agent (it asks and acts as that agent only), no secret, private_key_jwt
   * with the agent's public keys. One per agent; the agent must be active and have an active sponsor.
   */
  async createForAgent(
    agentId: string,
    input: Required<CreateAgentApplication>,
    actor: Principal,
  ): Promise<Application> {
    return this.db.tx(async (tx) => {
      const agent = await tx.identity.findFirst({
        where: { id: agentId, kind: 'agent' },
        include: { agent: { include: { sponsor: true } }, application: true },
      });
      if (!agent?.agent) throw new NotFoundException('No such agent.');
      if (agent.status !== 'active' || agent.agent.sponsor.status !== 'active')
        throw new ConflictException('The agent and its sponsor must be active.');
      if (agent.application)
        throw new ConflictException('This agent has an application already. Replace its keys instead.');
      const clientId = `agent-${clientIdFrom(agent.displayName)}-${agentId.slice(0, 8)}`.slice(0, 63);
      const created = await tx.oidcClient.create({
        data: {
          tenantId: this.db.tenantId,
          clientId,
          name: agent.displayName,
          redirectUris: [],
          postLogoutRedirectUris: [],
          grantTypes: input.grantTypes,
          tokenEndpointAuthMethod: 'private_key_jwt',
          apiScopes: input.apiScopes,
          agentId,
          jwks: input.jwks as object,
        },
      });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'client.created',
        targetType: 'client',
        targetId: clientId,
        data: {
          name: agent.displayName,
          agentId,
          grantTypes: input.grantTypes,
          apiScopes: input.apiScopes,
          keys: input.jwks.keys.map((k) => k.kid ?? k.kty),
        },
      });
      return toApplication(created);
    });
  }

  /** New public keys for an agent's application: the old ones stop working at once (assertions signed with them fail). */
  async replaceAgentKeys(agentId: string, jwks: PublicJwks, actor: Principal): Promise<Application> {
    return this.db.tx(async (tx) => {
      const row = await tx.oidcClient.findFirst({ where: { agentId } });
      if (!row) throw new NotFoundException('This agent has no application.');
      const updated = await tx.oidcClient.update({ where: { id: row.id }, data: { jwks: jwks as object } });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'client.keys_replaced',
        targetType: 'client',
        targetId: row.clientId,
        data: { agentId, keys: jwks.keys.map((k) => k.kid ?? k.kty) },
      });
      return toApplication(updated);
    });
  }

  async update(id: string, input: UpdateApplication, actor: Principal): Promise<Application> {
    return this.db.tx(async (tx) => {
      const row = await this.editable(tx, id);
      if (
        row.agentId &&
        (input.grantTypes || input.redirectUris || input.postLogoutRedirectUris || input.tokenEndpointAuthMethod)
      )
        throw new ConflictException(
          'An agent’s application has no redirects or secret, and its grant types are set with it.',
        );
      const updated = await tx.oidcClient.update({
        where: { id },
        data: {
          name: input.name,
          redirectUris: input.redirectUris,
          postLogoutRedirectUris: input.postLogoutRedirectUris,
          grantTypes: input.grantTypes,
          apiScopes: input.apiScopes,
          minimumAcr: input.minimumAcr,
          tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
        },
      });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'client.updated',
        targetType: 'client',
        targetId: row.clientId,
        data: {
          fields: Object.keys(input),
          ...(input.apiScopes && { apiScopes: input.apiScopes }),
          ...(input.minimumAcr !== undefined && { minimumAcr: input.minimumAcr }),
        },
      });
      return toApplication(updated);
    });
  }

  async rotateSecret(id: string, actor: Principal): Promise<ApplicationWithSecret> {
    const row = await this.db.tx(async (tx) => {
      const current = await this.editable(tx, id);
      if (current.agentId)
        throw new ConflictException('An agent’s application has no secret: replace its keys instead.');
      const updated = await tx.oidcClient.update({ where: { id }, data: { secretVersion: { increment: 1 } } });
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'client.secret_rotated',
        targetType: 'client',
        targetId: current.clientId,
        data: { secretVersion: updated.secretVersion },
      });
      return updated;
    });
    return this.withSecret(row);
  }

  /** Deleting an application also ends its sessions: its grants and tokens go with it. */
  async remove(id: string, actor: Principal): Promise<void> {
    await this.db.tx(async (tx) => {
      const row = await this.editable(tx, id);
      await tx.oidcClient.delete({ where: { id } });
      const revoked = await tx.$executeRaw`DELETE FROM oidc_payload WHERE payload->>'clientId' = ${row.clientId}`;
      await appendAudit(tx, this.db.tenantId, {
        ...audited(actor),
        action: 'client.deleted',
        targetType: 'client',
        targetId: row.clientId,
        data: { name: row.name, tokensRevoked: revoked },
      });
    });
  }

  private withSecret(row: ClientRow): ApplicationWithSecret {
    return {
      application: toApplication(row),
      clientSecret: clientSecret(this.config.LANDBRIGHT_SECRET_KEY, row.clientId, row.secretVersion),
      issuer: this.issuer,
    };
  }

  private async find(tx: Prisma.TransactionClient, id: string): Promise<ClientRow> {
    const row = await tx.oidcClient.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('No such application.');
    return row;
  }

  /** The console's own client is managed by the bootstrap: changing it from the console could lock everyone out. */
  private async editable(tx: Prisma.TransactionClient, id: string): Promise<ClientRow> {
    const row = await this.find(tx, id);
    if (row.system) throw new ForbiddenException('Landbright’s own console client can’t be changed here.');
    return row;
  }
}

type z_CreateApplication = Required<Omit<CreateApplication, 'clientId'>> & { clientId?: string };
