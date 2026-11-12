import { randomUUID } from 'node:crypto';
import { loadConfig } from '@landbright/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAudit, verifyAuditChain } from '../src/audit';
import { ensureBootstrap } from '../src/bootstrap';
import { createPrisma } from '../src/prisma';
import { withTenant } from '../src/tenant';
import { dbEnabled, migrateTestDb, TEST_ADMIN_URL, TEST_APP_URL } from './test-db';

describe.skipIf(!dbEnabled)('row-level security and the audit chain (landbright_test)', () => {
  const owner = createPrisma(TEST_ADMIN_URL);
  const app = createPrisma(TEST_APP_URL);
  let a: string;
  let b: string;

  beforeAll(async () => {
    migrateTestDb();
    const suffix = randomUUID().slice(0, 8);
    a = (await owner.tenant.create({ data: { slug: `a-${suffix}`, name: 'A' } })).id;
    b = (await owner.tenant.create({ data: { slug: `b-${suffix}`, name: 'B' } })).id;
    await withTenant(app, a, (tx) =>
      tx.identity.create({ data: { tenantId: a, kind: 'person', displayName: 'Ana', email: `ana-${suffix}@a.test` } }),
    );
    await withTenant(app, b, (tx) =>
      tx.identity.create({ data: { tenantId: b, kind: 'person', displayName: 'Ben', email: `ben-${suffix}@b.test` } }),
    );
  });
  afterAll(async () => {
    await app.$disconnect();
    await owner.$disconnect();
  });

  it('shows a tenant only its own rows', async () => {
    const seenByA = await withTenant(app, a, (tx) => tx.identity.findMany());
    expect(seenByA.map((i) => i.displayName)).toEqual(['Ana']);
  });

  it('shows nothing outside withTenant', async () => {
    expect(await app.identity.count()).toBe(0);
  });

  it('refuses a row for another tenant', async () => {
    await expect(
      withTenant(app, a, (tx) => tx.identity.create({ data: { tenantId: b, kind: 'person', displayName: 'Mallory' } })),
    ).rejects.toThrow(/row-level security/);
  });

  it('lets the app read tenants but not create them', async () => {
    expect(await app.tenant.count()).toBeGreaterThanOrEqual(2);
    await expect(app.tenant.create({ data: { slug: `x-${randomUUID().slice(0, 8)}`, name: 'X' } })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('chains audit events and refuses to rewrite them', async () => {
    await withTenant(app, a, async (tx) => {
      await appendAudit(tx, a, { actorLabel: 'test', action: 'one', targetType: 'thing' });
      await appendAudit(tx, a, { actorLabel: 'test', action: 'two', targetType: 'thing', data: { n: 2 } });
    });
    const rows = await withTenant(app, a, (tx) => tx.auditEvent.findMany({ orderBy: { id: 'asc' } }));
    expect(rows).toHaveLength(2);
    expect(verifyAuditChain(rows)).toBeUndefined();
    expect(rows[1]!.prevHash).toBe(rows[0]!.hash);
    await expect(
      withTenant(app, a, (tx) => tx.auditEvent.updateMany({ data: { action: 'forged' } })),
    ).rejects.toThrow();
    await expect(withTenant(owner, a, (tx) => tx.auditEvent.deleteMany({}))).rejects.toThrow(/append-only/);
  });

  it('bootstraps once, then changes nothing', async () => {
    const config = {
      ...loadConfig({}),
      LANDBRIGHT_TENANT_SLUG: `boot-${randomUUID().slice(0, 8)}`,
      LANDBRIGHT_BOOTSTRAP_ADMIN_EMAIL: `admin-${randomUUID().slice(0, 8)}@boot.test`,
    };
    const first = await ensureBootstrap(owner, config);
    expect(first.created).toHaveLength(4);
    const second = await ensureBootstrap(owner, config);
    expect(second.created).toEqual([]);
  });
});
