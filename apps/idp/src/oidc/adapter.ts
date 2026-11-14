import { clientSecret } from '@landbright/platform';
import { type PrismaClient, type TenantRef, withTenant } from '@landbright/persistence';
import type { Adapter, AdapterPayload, ClientMetadata } from 'oidc-provider';

/**
 * oidc-provider's storage in Postgres (oidc_payload), and its client lookup in the applications table. Sessions,
 * interactions, codes, tokens and grants survive restarts and are shared by every replica.
 */
export function postgresAdapter(
  prisma: PrismaClient,
  tenant: TenantRef,
  secretKey: string,
): new (name: string) => Adapter {
  return class PostgresAdapter implements Adapter {
    constructor(private readonly name: string) {}

    async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
      const data = {
        payload: payload as object,
        grantId: payload.grantId ?? null,
        userCode: payload.userCode ?? null,
        uid: payload.uid ?? null,
        expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
      };
      await prisma.oidcPayload.upsert({
        where: { id_type: { id, type: this.name } },
        create: { id, type: this.name, ...data },
        update: data,
      });
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
      if (this.name === 'Client') return findClient(prisma, tenant, secretKey, id);
      return this.load({ id_type: { id, type: this.name } });
    }

    async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
      const row = await prisma.oidcPayload.findFirst({ where: { type: this.name, userCode } });
      return row ? this.load({ id_type: { id: row.id, type: this.name } }) : undefined;
    }

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      const row = await prisma.oidcPayload.findFirst({ where: { type: this.name, uid } });
      return row ? this.load({ id_type: { id: row.id, type: this.name } }) : undefined;
    }

    async consume(id: string): Promise<void> {
      await prisma.oidcPayload.updateMany({ where: { id, type: this.name }, data: { consumedAt: new Date() } });
    }

    async destroy(id: string): Promise<void> {
      await prisma.oidcPayload.deleteMany({ where: { id, type: this.name } });
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      await prisma.oidcPayload.deleteMany({ where: { grantId } });
    }

    private async load(where: { id_type: { id: string; type: string } }): Promise<AdapterPayload | undefined> {
      const row = await prisma.oidcPayload.findUnique({ where });
      if (!row || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) return undefined;
      return {
        ...(row.payload as AdapterPayload),
        ...(row.consumedAt ? { consumed: Math.floor(row.consumedAt.getTime() / 1000) } : {}),
      };
    }
  };
}

/** An application as oidc-provider's client metadata, with its derived secret. */
export async function findClient(
  prisma: PrismaClient,
  tenant: TenantRef,
  secretKey: string,
  clientId: string,
): Promise<ClientMetadata | undefined> {
  const client = await withTenant(prisma, tenant.id, (tx) => tx.oidcClient.findUnique({ where: { clientId } }));
  if (!client) return undefined;
  return {
    client_id: client.clientId,
    client_secret: clientSecret(secretKey, client.clientId, client.secretVersion),
    client_name: client.name,
    redirect_uris: client.redirectUris,
    post_logout_redirect_uris: client.postLogoutRedirectUris,
    grant_types: client.grantTypes,
    response_types: client.grantTypes.includes('authorization_code') ? ['code'] : [],
    token_endpoint_auth_method: client.tokenEndpointAuthMethod as ClientMetadata['token_endpoint_auth_method'],
    api_scopes: client.apiScopes,
    ...(client.minimumAcr && { minimum_acr: client.minimumAcr }),
  };
}
