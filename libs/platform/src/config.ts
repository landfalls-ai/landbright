import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
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
  /** A domain, not an IP address: it is the passkeys' relying-party id, and WebAuthn refuses IP addresses. */
  LANDBRIGHT_IDP_URL: z.url().default('http://localhost:4402'),
  LANDBRIGHT_CONSOLE_URL: z.url().default('http://127.0.0.1:4400'),
  /** The services' connection: the landbright_app role, under row-level security. */
  LANDBRIGHT_DATABASE_URL: z
    .url()
    .default('postgres://landbright_app:landbright-app-dev-only@127.0.0.1:57432/landbright'),
  /** The owner's connection: migrations and the bootstrap only. */
  LANDBRIGHT_DATABASE_ADMIN_URL: z
    .url()
    .default('postgres://landbright:landbright-dev-only@127.0.0.1:57432/landbright'),
  /** The tenant this deployment serves (one per deployment for now; the boundary is in every table). */
  LANDBRIGHT_TENANT_SLUG: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default('local'),
  LANDBRIGHT_TENANT_NAME: z.string().default('Local'),
  /**
   * Seals signing keys and derives client secrets and cookie keys. At least 32 characters. Changing it invalidates
   * every client secret and session, and makes sealed keys unreadable (new ones are generated).
   */
  LANDBRIGHT_SECRET_KEY: z.string().min(32).default('landbright-dev-only-secret-key-do-not-use-anywhere-real'),
  /**
   * How long an ID token lives. A signing-key rotation keeps the replaced key published at least this long, so tokens
   * it signed still verify; the end-to-end tests shorten it to rotate twice in one run.
   */
  LANDBRIGHT_ID_TOKEN_TTL_SECONDS: z.coerce.number().int().min(5).max(86_400).default(3600),
  LANDBRIGHT_SMTP_URL: z.string().default('smtp://127.0.0.1:57025'),
  LANDBRIGHT_MAIL_FROM: z.string().default('Landbright <no-reply@landbright.test>'),
  /** The first administrator, created by the bootstrap (pnpm db:seed) if missing. */
  LANDBRIGHT_BOOTSTRAP_ADMIN_EMAIL: z.email().default('admin@landbright.test'),
  LANDBRIGHT_BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).default('landbright-dev-only'),
  LANDBRIGHT_VALKEY_URL: z.url().default('redis://127.0.0.1:57379'),
  LANDBRIGHT_OPENBAO_ADDR: z.url().default('http://127.0.0.1:57200'),
  LANDBRIGHT_OPENBAO_TOKEN: z.string().min(1).default('landbright-dev-only'),
  LANDBRIGHT_MAILPIT_URL: z.url().default('http://127.0.0.1:57825'),
});
export type Config = z.infer<typeof ConfigSchema>;

/** The issuer URL tokens carry: the identity plane's OIDC mount. */
export function issuerOf(config: Pick<Config, 'LANDBRIGHT_IDP_URL'>): string {
  return new URL('/oidc', config.LANDBRIGHT_IDP_URL).href;
}

/**
 * The passkeys' relying party: the identity plane's host and origin. Undefined when the host is an IP address, which
 * WebAuthn refuses; passkeys are then off and the pages don't offer them.
 */
export function passkeyRelyingParty(
  config: Pick<Config, 'LANDBRIGHT_IDP_URL'>,
): { id: string; origin: string } | undefined {
  const url = new URL(config.LANDBRIGHT_IDP_URL);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return isIP(host) ? undefined : { id: host, origin: url.origin };
}

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
