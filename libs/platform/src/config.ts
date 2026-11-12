import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * Configuration for every Landbright process, from the environment. Every variable has a development default equal to
 * the value in `.env.example`, so a fresh checkout runs with no `.env` at all. docs/reference/configuration.md lists
 * them.
 */
export const ConfigSchema = z.object({
  LANDBRIGHT_ENV: z.string().default('local'),
  LANDBRIGHT_CONTROL_PORT: z.coerce.number().int().positive().default(4401),
  LANDBRIGHT_IDP_PORT: z.coerce.number().int().positive().default(4402),
  LANDBRIGHT_IDP_URL: z.url().default('http://127.0.0.1:4402'),
  LANDBRIGHT_DATABASE_URL: z.url().default('postgres://landbright:landbright-dev-only@127.0.0.1:57432/landbright'),
  LANDBRIGHT_VALKEY_URL: z.url().default('redis://127.0.0.1:57379'),
  LANDBRIGHT_OPENBAO_ADDR: z.url().default('http://127.0.0.1:57200'),
  LANDBRIGHT_OPENBAO_TOKEN: z.string().min(1).default('landbright-dev-only'),
  LANDBRIGHT_MAILPIT_URL: z.url().default('http://127.0.0.1:57825'),
});
export type Config = z.infer<typeof ConfigSchema>;

/** Parses the environment, failing fast with every invalid variable named. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid Landbright configuration:\n${problems}`);
  }
  return parsed.data;
}

/**
 * Loads the workspace's `.env` (next to `pnpm-workspace.yaml`) into `process.env` if there is one. Variables already
 * set win. Returns the file it loaded, if any.
 */
export function loadWorkspaceEnv(from: string = process.cwd()): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      const file = join(dir, '.env');
      if (!existsSync(file)) return undefined;
      process.loadEnvFile(file);
      return file;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** `host:port` of a URL, for display. Never includes credentials. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid URL';
  }
}

/** The running package's version, as pnpm sets it for the script. */
export function serviceVersion(): string {
  return process.env.npm_package_version ?? '0.0.0';
}
