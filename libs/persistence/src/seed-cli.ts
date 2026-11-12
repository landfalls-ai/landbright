// pnpm db:seed: the bootstrap, as the owner.
import { loadConfig, loadWorkspaceEnv } from '@landbright/platform';
import { ensureBootstrap } from './bootstrap';
import { createPrisma } from './prisma';

loadWorkspaceEnv();
const config = loadConfig();
const owner = createPrisma(config.LANDBRIGHT_DATABASE_ADMIN_URL);
ensureBootstrap(owner, config)
  .then(({ created }) => {
    console.log(created.length ? `Created: ${created.join(', ')}.` : 'Already bootstrapped; nothing to do.');
    console.log(`Sign in to the console as ${config.LANDBRIGHT_BOOTSTRAP_ADMIN_EMAIL}.`);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void owner.$disconnect());
