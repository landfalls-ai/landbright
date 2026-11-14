// The OpenID Foundation conformance suite against Landbright, on this machine: `pnpm conformance`.
//
// 1. Starts a dedicated, built identity plane on a free host port, against landbright_test with a tenant of its own,
//    issuing as https://idp.landbright.test:8443 (behind Caddy), trusting the proxy, and with PKCE optional for the two
//    conformance clients only (the OIDC Core plans send no code_challenge).
// 2. Registers those two clients and writes the suite's configuration (clients, and how its browser signs in).
// 3. Starts deploy/conformance/compose.yml (project landbright-conformance) and runs the suite's own runner script
//    (scripts/run-test-plan.py at CONFORMANCE_SUITE_VERSION) with the plan below.
// 4. Writes the log and the exported results to e2e/conformance/.run/<run>/, then stops everything it started.
//
// Needs the compose infrastructure (pnpm dev:up), the built identity plane (pnpm build), Docker (OrbStack) and git.
// `--keep` leaves the suite running afterwards; `--plan <name>` runs another plan.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { appendAudit, createPrisma, resolveTenant, withTenant } from '@landbright/persistence';
import { clientSecret } from '@landbright/platform';

const CONFORMANCE_SUITE_VERSION = 'release-v5.3.4';
const SUITE_REPO = 'https://gitlab.com/openid/conformance-suite.git';
const DEFAULT_PLAN =
  'oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=static_client]';
const IDP_URL = 'https://idp.landbright.test:8443';
const SUITE_URL = 'https://localhost.emobix.co.uk:8443';
const ALIAS = 'landbright';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const plan = args.includes('--plan') ? args[args.indexOf('--plan') + 1]! : DEFAULT_PLAN;

const root = resolve(import.meta.dirname, '../..');
const here = resolve(root, 'e2e/conformance');
const compose = ['compose', '-f', resolve(root, 'deploy/conformance/compose.yml')];
const dbHost = process.env.LANDBRIGHT_TEST_DB_HOST ?? '127.0.0.1:57432';
const secretKey = 'landbright-dev-only-secret-key-do-not-use-anywhere-real'; // .env.example

const runId = `conformance-${Date.now().toString(36)}`;
const runDir = resolve(here, '.run', runId);
mkdirSync(resolve(runDir, 'results'), { recursive: true });
const log = (line: string) => console.log(`[conformance] ${line}`);

// The suite's runner script, at the pinned release (only scripts/ is checked out).
const suiteDir = resolve(here, '.suite', CONFORMANCE_SUITE_VERSION);
if (!existsSync(resolve(suiteDir, 'scripts/run-test-plan.py'))) {
  log(`fetching the suite's scripts at ${CONFORMANCE_SUITE_VERSION}`);
  execFileSync('git', [
    '-c',
    'advice.detachedHead=false',
    'clone',
    '--quiet',
    '--depth',
    '1',
    '--branch',
    CONFORMANCE_SUITE_VERSION,
    '--filter=blob:none',
    '--sparse',
    SUITE_REPO,
    suiteDir,
  ]);
  execFileSync('git', ['-C', suiteDir, 'sparse-checkout', 'set', 'scripts']);
}

// 1. The identity plane.
const port = await freePort();
// client and client2 authenticate with client_secret_basic; the third with client_secret_post (its own test module).
const clients = [
  { clientId: `${runId}-1`, auth: 'client_secret_basic' },
  { clientId: `${runId}-2`, auth: 'client_secret_basic' },
  { clientId: `${runId}-post`, auth: 'client_secret_post' },
];
const clientIds = clients.map((c) => c.clientId);
const admin = { email: `admin@${runId}.test`, password: 'conformance-admin-password' };
const env: NodeJS.ProcessEnv = {
  ...process.env,
  LANDBRIGHT_ENV: 'e2e',
  LANDBRIGHT_DATABASE_URL: `postgres://landbright_app:landbright-app-dev-only@${dbHost}/landbright_test`,
  LANDBRIGHT_DATABASE_ADMIN_URL: `postgres://landbright:landbright-dev-only@${dbHost}/landbright_test`,
  LANDBRIGHT_SECRET_KEY: secretKey,
  LANDBRIGHT_TENANT_SLUG: runId,
  LANDBRIGHT_TENANT_NAME: `Conformance ${runId}`,
  LANDBRIGHT_IDP_PORT: String(port),
  LANDBRIGHT_IDP_URL: IDP_URL,
  LANDBRIGHT_TRUST_PROXY: 'true',
  LANDBRIGHT_PKCE_OPTIONAL_CLIENTS: clientIds.join(','),
  LANDBRIGHT_BOOTSTRAP_ADMIN_EMAIL: admin.email,
  LANDBRIGHT_BOOTSTRAP_ADMIN_PASSWORD: admin.password,
};
delete env.OTEL_TRACES_EXPORTER;
delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
const persistence = resolve(root, 'libs/persistence');
execFileSync('node', ['scripts/prisma.mjs', 'migrate', 'deploy'], { cwd: persistence, env, stdio: 'pipe' });
execFileSync('node', ['scripts/prisma.mjs', 'db', 'execute', '--file', 'prisma/dev-roles.sql'], {
  cwd: persistence,
  env,
  stdio: 'pipe',
});
execFileSync('node', ['dist/seed-cli.js'], { cwd: persistence, env, stdio: 'pipe' });

// 2. The clients the suite uses, registered as an administrator would (and audited).
const prisma = createPrisma(env.LANDBRIGHT_DATABASE_ADMIN_URL!);
const tenant = await resolveTenant(prisma, runId);
const redirectUri = `${SUITE_URL}/test/a/${ALIAS}/callback`;
await withTenant(prisma, tenant.id, async (tx) => {
  for (const { clientId, auth } of clients) {
    await tx.oidcClient.create({
      data: {
        tenantId: tenant.id,
        clientId,
        name: `OpenID conformance ${clientId.slice(runId.length + 1)}`,
        tokenEndpointAuthMethod: auth,
        redirectUris: [redirectUri],
        postLogoutRedirectUris: [],
        grantTypes: ['authorization_code', 'refresh_token'],
      },
    });
    await appendAudit(tx, tenant.id, {
      actorLabel: 'conformance run',
      action: 'client.created',
      targetType: 'client',
      targetId: clientId,
      data: {
        redirectUris: [redirectUri],
        grantTypes: ['authorization_code', 'refresh_token'],
        tokenEndpointAuth: auth,
      },
    });
  }
});
await prisma.$disconnect();

let idpOutput = '';
const idp = spawn('node', ['--enable-source-maps', 'dist/main.js'], {
  cwd: resolve(root, 'apps/idp'),
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
idp.stdout!.on('data', (c: Buffer) => (idpOutput += c.toString()));
idp.stderr!.on('data', (c: Buffer) => (idpOutput += c.toString()));
// Stopped early (Ctrl-C): stop the identity plane too.
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    idp.kill('SIGTERM');
    process.exit(130);
  });
await waitFor(`http://127.0.0.1:${port}/healthz`, idp);
log(`identity plane on 127.0.0.1:${port}, issuing as ${IDP_URL}/oidc (tenant ${runId})`);

// The suite's configuration: the clients, and how its browser (HtmlUnit) gets through Landbright's sign-in.
const signIn = (placeholder: boolean) => [
  {
    match: `${IDP_URL}/oidc/auth*`,
    tasks: [
      {
        task: 'Sign in',
        optional: true,
        match: `${IDP_URL}/interaction/*`,
        commands: [
          ...(placeholder ? [['wait', 'xpath', '//*', 10, 'Sign in', 'update-image-placeholder-optional']] : []),
          ['text', 'name', 'email', admin.email],
          ['text', 'name', 'password', admin.password],
          ['click', 'xpath', "//form[not(@data-passkey)]//button[@class='primary']"],
        ],
      },
      {
        // Landbright offers a second step after the password; the suite's user declines it.
        task: 'Not now',
        optional: true,
        match: `${IDP_URL}/interaction/*`,
        commands: [['click', 'xpath', "//button[normalize-space()='Not now']"]],
      },
      { task: 'Verify Complete', match: '*/test/*/callback*', commands: [['wait', 'id', 'submission_complete', 10]] },
    ],
  },
];
// Where Landbright must refuse and show its error page (it redirects nowhere): the suite captures it for review.
const errorPage = {
  browser: [
    {
      match: `${IDP_URL}/oidc/auth*`,
      tasks: [
        {
          task: 'Expect the error page',
          match: `${IDP_URL}/oidc/auth*`,
          commands: [['wait', 'xpath', '//*', 10, 'Something went wrong', 'update-image-placeholder']],
        },
      ],
    },
  ],
};
const config = {
  alias: ALIAS,
  description: `Landbright ${runId}`,
  server: { discoveryUrl: `${IDP_URL}/oidc/.well-known/openid-configuration` },
  client: { client_id: clientIds[0], client_secret: clientSecret(secretKey, clientIds[0]!, 1) },
  client2: { client_id: clientIds[1], client_secret: clientSecret(secretKey, clientIds[1]!, 1) },
  client_secret_post: { client_id: clientIds[2], client_secret: clientSecret(secretKey, clientIds[2]!, 1) },
  browser: signIn(false),
  override: {
    // A second sign-in: the suite captures Landbright's sign-in page for review.
    ...Object.fromEntries(['oidcc-prompt-login', 'oidcc-max-age-1'].map((m) => [m, { browser: signIn(true) }])),
    // An unregistered redirect_uri, in the URL or next to a request object (which Landbright doesn't support).
    ...Object.fromEntries(
      ['oidcc-ensure-registered-redirect-uri', 'oidcc-ensure-request-object-with-redirect-uri'].map((m) => [
        m,
        errorPage,
      ]),
    ),
  },
};
writeFileSync(resolve(runDir, 'landbright.json'), `${JSON.stringify(config, null, 2)}\n`);

// 3. The suite, and the plan.
const composeEnv = {
  ...process.env,
  LANDBRIGHT_IDP_UPSTREAM: `host.docker.internal:${port}`,
  CONFORMANCE_SCRIPTS: resolve(suiteDir, 'scripts'),
  CONFORMANCE_RUN: runDir,
};
let exitCode = 1;
try {
  log('starting the suite (docker compose project landbright-conformance)');
  execFileSync('docker', [...compose, 'up', '-d', '--force-recreate', 'mongodb', 'server', 'nginx', 'idp-tls'], {
    env: composeEnv,
    stdio: 'inherit',
  });
  log(`running ${plan}`);
  exitCode = await run(
    'docker',
    [
      ...compose,
      'run',
      '--rm',
      'runner',
      '--export-dir',
      '/run-dir/results',
      '--no-parallel',
      plan,
      '/run-dir/landbright.json',
    ],
    composeEnv,
    resolve(runDir, 'runner.log'),
  );
  log(`runner exited ${exitCode}; log and results in ${runDir}`);
} finally {
  writeFileSync(resolve(runDir, 'idp.log'), idpOutput);
  if (!keep) execFileSync('docker', [...compose, 'down', '--remove-orphans'], { env: composeEnv, stdio: 'inherit' });
  idp.kill('SIGTERM');
}
process.exitCode = exitCode;

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port: p } = server.address() as { port: number };
      server.close(() => done(p));
    });
    server.on('error', fail);
  });
}

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`the identity plane exited (${child.exitCode}):\n${idpOutput}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the identity plane didn't come up:\n${idpOutput}`);
}

function run(cmd: string, argv: string[], runEnv: NodeJS.ProcessEnv, logFile: string): Promise<number> {
  return new Promise((done) => {
    let out = '';
    const child = spawn(cmd, argv, { env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const tee = (c: Buffer) => {
      out += c.toString();
      process.stdout.write(c);
    };
    child.stdout!.on('data', tee);
    child.stderr!.on('data', tee);
    child.on('exit', (code) => {
      writeFileSync(logFile, out);
      done(code ?? 1);
    });
  });
}
