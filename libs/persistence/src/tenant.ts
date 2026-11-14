import type { Prisma, PrismaClient } from '@prisma/client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantRef {
  id: string;
  slug: string;
  name: string;
}

export function assertTenantId(tenantId: string): void {
  if (!UUID.test(tenantId)) throw new Error(`Invalid tenant id (expected a UUID): ${tenantId}`);
}

/**
 * Runs `fn` in a transaction where row-level security sees only `tenantId` (Landfall's pattern): the id is checked
 * as a UUID and bound as a parameter to `set_config('app.tenant_id', …, true)`, which reverts when the transaction
 * ends. Every read and write of a tenant-owned table goes through here; outside it, those tables look empty.
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  assertTenantId(tenantId);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

/** The tenant a deployment serves, by slug. A pre-tenant read: the tenant table has no row-level security. */
export async function resolveTenant(prisma: PrismaClient, slug: string): Promise<TenantRef> {
  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) throw new Error(`No tenant "${slug}". Run pnpm db:setup to create it.`);
  return { id: tenant.id, slug: tenant.slug, name: tenant.name };
}
