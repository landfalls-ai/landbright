import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * The integration-test database (landbright_test, created by deploy/infra/postgres/init.sql), migrated on first use.
 * Tests that need it skip unless LANDBRIGHT_INTEGRATION names `db` (or `all`).
 */
const flags = (process.env.LANDBRIGHT_INTEGRATION ?? '').split(',');
export const dbEnabled = flags.includes('db') || flags.includes('all');

const host = process.env.LANDBRIGHT_TEST_DB_HOST ?? '127.0.0.1:57432';
export const TEST_ADMIN_URL = `postgres://landbright:landbright-dev-only@${host}/landbright_test`;
export const TEST_APP_URL = `postgres://landbright_app:landbright-app-dev-only@${host}/landbright_test`;

let migrated = false;
export function migrateTestDb(): void {
  if (migrated) return;
  const prisma = resolve(process.cwd(), 'scripts/prisma.mjs');
  const env = { ...process.env, LANDBRIGHT_DATABASE_ADMIN_URL: TEST_ADMIN_URL };
  execFileSync('node', [prisma, 'migrate', 'deploy'], { env, stdio: 'pipe' });
  execFileSync('node', [prisma, 'db', 'execute', '--file', resolve(process.cwd(), 'prisma/dev-roles.sql')], {
    env,
    stdio: 'pipe',
  });
  migrated = true;
}
