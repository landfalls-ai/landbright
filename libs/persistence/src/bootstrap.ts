import { type Config, issuerOf } from '@landbright/platform';
import type { PrismaClient } from '@prisma/client';
import { appendAudit } from './audit';
import { hashPassword } from './passwords';
import { withTenant } from './tenant';

export const ADMINS_GROUP = 'Landbright Admins';
/** The console's own OIDC client. Client ids are global (one issuer), so it carries the tenant's slug. */
export function consoleClientId(tenantSlug: string): string {
  return `landbright-console-${tenantSlug}`;
}

/**
 * Makes a fresh database usable, and changes nothing on one that already is: the tenant, the administrators' group,
 * the first administrator (with the bootstrap password) and the console's own OIDC client. Runs as the owner,
 * because only the owner may create a tenant.
 */
export async function ensureBootstrap(owner: PrismaClient, config: Config): Promise<{ created: string[] }> {
  const created: string[] = [];
  let tenant = await owner.tenant.findUnique({ where: { slug: config.LANDBRIGHT_TENANT_SLUG } });
  if (!tenant) {
    tenant = await owner.tenant.create({
      data: { slug: config.LANDBRIGHT_TENANT_SLUG, name: config.LANDBRIGHT_TENANT_NAME },
    });
    created.push(`tenant ${tenant.slug}`);
  }
  const tenantId = tenant.id;
  const system = { actorLabel: 'bootstrap' };

  const tenantSlug = tenant.slug;
  await withTenant(owner, tenantId, async (tx) => {
    let admins = await tx.group.findFirst({ where: { tenantId, name: ADMINS_GROUP } });
    if (!admins) {
      admins = await tx.group.create({
        data: {
          tenantId,
          name: ADMINS_GROUP,
          description: 'Administer Landbright: the directory, access and applications.',
        },
      });
      await appendAudit(tx, tenantId, {
        ...system,
        action: 'group.created',
        targetType: 'group',
        targetId: admins.id,
        data: { name: ADMINS_GROUP },
      });
      created.push(`group ${ADMINS_GROUP}`);
    }

    const email = config.LANDBRIGHT_BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
    let admin = await tx.identity.findFirst({ where: { tenantId, email } });
    if (!admin) {
      admin = await tx.identity.create({
        data: {
          tenantId,
          kind: 'person',
          displayName: 'Administrator',
          email,
          person: { create: { tenantId, givenName: 'Administrator', familyName: '' } },
          credentials: {
            create: {
              tenantId,
              kind: 'password',
              secret: await hashPassword(config.LANDBRIGHT_BOOTSTRAP_ADMIN_PASSWORD),
            },
          },
          memberships: { create: { tenantId, groupId: admins.id } },
        },
      });
      await appendAudit(tx, tenantId, {
        ...system,
        action: 'identity.created',
        targetType: 'identity',
        targetId: admin.id,
        data: { email, kind: 'person', bootstrap: true },
      });
      created.push(`administrator ${email}`);
    }

    const redirect = new URL('/api/auth/callback', config.LANDBRIGHT_CONSOLE_URL).href;
    const clientId = consoleClientId(tenantSlug);
    // Filter by tenant even here: the owner is a superuser and sees every tenant's rows.
    const consoleClient = await tx.oidcClient.findFirst({ where: { tenantId, clientId } });
    if (!consoleClient) {
      await tx.oidcClient.create({
        data: {
          tenantId,
          clientId,
          name: 'Landbright console',
          redirectUris: [redirect],
          postLogoutRedirectUris: [config.LANDBRIGHT_CONSOLE_URL.replace(/\/$/, '') + '/'],
          grantTypes: ['authorization_code', 'refresh_token'],
          system: true,
        },
      });
      await appendAudit(tx, tenantId, {
        ...system,
        action: 'client.created',
        targetType: 'client',
        targetId: clientId,
        data: { issuer: issuerOf(config), redirect },
      });
      created.push(`client ${clientId}`);
    }
  });
  return { created };
}
