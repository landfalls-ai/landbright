import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

/**
 * The stack under test: the built idp and control as child processes, on free ports, against the landbright_test
 * database and the compose stack's Valkey and Mailpit. Each run gets its own tenant, so runs never see each other.
 */
const flags = (process.env.LANDBRIGHT_INTEGRATION ?? '').split(',');
export const e2eEnabled = flags.includes('e2e') || flags.includes('all');

const root = resolve(import.meta.dirname, '../..');
const dbHost = process.env.LANDBRIGHT_TEST_DB_HOST ?? '127.0.0.1:57432';
export const MAILPIT = process.env.LANDBRIGHT_MAILPIT_URL ?? 'http://127.0.0.1:57825';

export interface Stack {
  slug: string;
  idp: string;
  control: string;
  issuer: string;
  /** Where a browser opens the console: the built console under `vite preview` when asked for, else control. */
  console: string;
  admin: { email: string; password: string };
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
    server.on('error', fail);
  });
}

async function waitFor(url: string, child: ChildProcess, output: () => string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`${url} exited (${child.exitCode}):\n${output()}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} didn't come up:\n${output()}`);
}

/**
 * Starts the stack. With `console`, the built console runs too (`vite preview`, proxying `/api` to control), and
 * sign-in returns to it, as in development; without it, the browser talks to control directly.
 */
export async function startStack(options: { console?: boolean; idTokenTtlSeconds?: number } = {}): Promise<Stack> {
  const slug = `e2e-${Date.now().toString(36)}`;
  const [idpPort, controlPort, consolePort] = [await freePort(), await freePort(), await freePort()];
  // localhost, not 127.0.0.1: the issuer's host is the passkeys' relying-party id.
  const idp = `http://localhost:${idpPort}`;
  const control = `http://127.0.0.1:${controlPort}`;
  const consoleUrl = options.console ? `http://127.0.0.1:${consolePort}` : control;
  const admin = { email: `admin@${slug}.test`, password: 'e2e-admin-password' };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LANDBRIGHT_ENV: 'e2e',
    LANDBRIGHT_DATABASE_URL: `postgres://landbright_app:landbright-app-dev-only@${dbHost}/landbright_test`,
    LANDBRIGHT_DATABASE_ADMIN_URL: `postgres://landbright:landbright-dev-only@${dbHost}/landbright_test`,
    LANDBRIGHT_TENANT_SLUG: slug,
    LANDBRIGHT_TENANT_NAME: `E2E ${slug}`,
    LANDBRIGHT_IDP_PORT: String(idpPort),
    LANDBRIGHT_IDP_URL: idp,
    LANDBRIGHT_CONTROL_PORT: String(controlPort),
    // Without the console, the browser talks to control directly, so control is "the console".
    LANDBRIGHT_CONSOLE_URL: consoleUrl,
    LANDBRIGHT_CONSOLE_PORT: String(consolePort),
    // Short only when a test rotates the signing keys twice: a rotation waits for the replaced key's tokens to expire.
    LANDBRIGHT_ID_TOKEN_TTL_SECONDS: String(options.idTokenTtlSeconds ?? 3600),
    LANDBRIGHT_BOOTSTRAP_ADMIN_EMAIL: admin.email,
    LANDBRIGHT_BOOTSTRAP_ADMIN_PASSWORD: admin.password,
  };
  // Telemetry off: it starts only when an exporter is configured.
  delete env.OTEL_TRACES_EXPORTER;
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete env.OTEL_METRICS_EXPORTER;
  delete env.OTEL_LOGS_EXPORTER;
  const persistence = resolve(root, 'libs/persistence');
  execFileSync('node', ['scripts/prisma.mjs', 'migrate', 'deploy'], { cwd: persistence, env, stdio: 'pipe' });
  execFileSync('node', ['scripts/prisma.mjs', 'db', 'execute', '--file', 'prisma/dev-roles.sql'], {
    cwd: persistence,
    env,
    stdio: 'pipe',
  });
  execFileSync('node', ['dist/seed-cli.js'], { cwd: persistence, env, stdio: 'pipe' });

  const children: ChildProcess[] = [];
  const start = async (
    app: string,
    url: string,
    args = ['--enable-source-maps', 'dist/main.js'],
    probe = '/healthz',
  ) => {
    let output = '';
    const child = spawn('node', args, {
      cwd: resolve(root, 'apps', app),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()));
    children.push(child);
    await waitFor(`${url}${probe}`, child, () => output);
  };
  await Promise.all([
    start('idp', idp),
    start('control', control),
    ...(options.console ? [start('console', consoleUrl, ['node_modules/vite/bin/vite.js', 'preview'], '/')] : []),
  ]);

  return {
    slug,
    idp,
    control,
    issuer: `${idp}/oidc`,
    console: consoleUrl,
    admin,
    async stop() {
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((done) => {
              if (child.exitCode !== null) return done();
              child.once('exit', () => done());
              child.kill('SIGTERM');
            }),
        ),
      );
    },
  };
}
