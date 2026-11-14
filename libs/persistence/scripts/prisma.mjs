// Runs the Prisma CLI with the workspace .env loaded and the development defaults filled in, so `pnpm migrate` works on
// a fresh checkout.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.LANDBRIGHT_DATABASE_ADMIN_URL ??= 'postgres://landbright:landbright-dev-only@127.0.0.1:57432/landbright';

const result = spawnSync(
  resolve(here, '../node_modules/.bin/prisma'),
  [...process.argv.slice(2), '--schema', resolve(here, '../prisma/schema.prisma')],
  {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  },
);
process.exit(result.status ?? 1);
