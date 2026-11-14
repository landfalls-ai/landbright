// Installs Landbright's Landflow flows into a local Landflow, and wires both sides (spec 004, docs/landflow-flows.md):
//
//   node landflow/install.ts            (from e2e/; the dev stack running: pnpm serve, and deploy/landflow up)
//
// Landbright (through the console API, as the bootstrap administrator): gives Landflow's application client
// credentials and machine API scopes, subscribes Landflow's two webhook paths to the events the flows need, and
// creates the "Landflow Editors (JIT)" bundle and the Onboard flow's birthright groups. Landflow (through its API, as its owner): an API key for the flows to
// call Landflow itself, a "Payments" project, three credentials (Landbright events: JWT Auth against Landbright's
// JWKS; Landbright API: OAuth2 client credentials; Landflow API: that key), then imports and publishes the flows in
// integrations/landflow/flows. Run it again to update: everything is found by name first.
//
// Development credentials only: Landbright's bootstrap administrator and Landflow's owner from their .env.example
// files, and the client secret Landflow already signs in with (LANDFLOW_OIDC_ENV_FILE).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, formAction } from '../test/browser.ts';

const env = process.env;
const CONSOLE = env.LANDBRIGHT_CONSOLE_URL ?? 'http://127.0.0.1:4400';
const CONTROL = env.LANDBRIGHT_CONTROL_URL ?? 'http://127.0.0.1:4401';
const ISSUER = env.LANDBRIGHT_ISSUER ?? 'http://localhost:4402/oidc';
const MAIL_API = `${env.LANDBRIGHT_MAILPIT_URL ?? 'http://127.0.0.1:57825'}/api/v1/send`;
const LANDFLOW = env.LANDFLOW_URL ?? 'http://localhost:57300';
const LANDFLOW_OWNER = {
  email: env.LANDFLOW_OWNER_EMAIL ?? 'owner@landflow.test',
  password: env.LANDFLOW_OWNER_PASSWORD ?? 'landflow-dev-only',
};
const ADMIN = {
  email: env.LANDBRIGHT_BOOTSTRAP_ADMIN_EMAIL ?? 'admin@landbright.test',
  password: env.LANDBRIGHT_BOOTSTRAP_ADMIN_PASSWORD ?? 'landbright-dev-only',
};
const SCOPES = [
  'requests:read',
  'grants:record',
  'annotations:write',
  'directory:read',
  'directory:write',
  'decisions:relay',
];
/**
 * The Slack flows are installed only with a bot token (`SLACK_BOT_TOKEN`). `SLACK_API_URL` points them at another Slack
 * Web API (a local stand-in, for a check without a Slack workspace).
 */
const SLACK_TOKEN = env.SLACK_BOT_TOKEN;
const SLACK_API = env.SLACK_API_URL ?? 'https://slack.com/api';
const here = dirname(fileURLToPath(import.meta.url));
const flowsDir = resolve(here, '../../integrations/landflow/flows');

const oidcEnv = env.LANDFLOW_OIDC_ENV_FILE;
if (!oidcEnv)
  throw new Error('Set LANDFLOW_OIDC_ENV_FILE to the env file deploy/landflow uses (it has the client secret).');
const oidc = Object.fromEntries(
  readFileSync(oidcEnv, 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
) as Record<string, string>;
const CLIENT_ID = oidc.LANDFLOW_OIDC_CLIENT_ID!;
const CLIENT_SECRET = oidc.LANDFLOW_OIDC_CLIENT_SECRET!;

async function check(res: Response, what: string) {
  if (!res.ok) throw new Error(`${what}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? undefined : res.json();
}

// ---------------------------------------------------------------- Landbright
const admin = new Browser();
{
  const page = await admin.navigate(`${CONSOLE}/api/auth/login?returnTo=/`);
  let after = await admin.submit(page.url, formAction(await page.response.text()), ADMIN);
  if (after.response.status === 200) {
    const skip = /action="([^"]+\/totp\/skip)"/.exec(await after.response.text())?.[1];
    if (skip) after = await admin.submit(after.url, skip, {});
  }
}
const lb = (path: string, init: RequestInit = {}) =>
  admin
    .fetch(`${CONSOLE}${path}`, {
      ...init,
      headers: { origin: CONSOLE, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    })
    .then((r) => check(r, `Landbright ${init.method ?? 'GET'} ${path}`));

const apps = (await lb('/api/applications')).items as Array<{ id: string; clientId: string; grantTypes: string[] }>;
const app = apps.find((a) => a.clientId === CLIENT_ID);
if (!app) throw new Error(`No application ${CLIENT_ID} in Landbright: run the Landflow sign-in setup first.`);
await lb(`/api/applications/${app.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ grantTypes: [...new Set([...app.grantTypes, 'client_credentials'])], apiScopes: SCOPES }),
});
console.log(`Landbright: ${CLIENT_ID} may now call the machine API (${SCOPES.join(', ')})`);

const groups = (await lb('/api/groups')).items as Array<{ id: string; name: string }>;
const group = async (name: string, kind = 'static') =>
  groups.find((g) => g.name === name) ??
  (await lb('/api/groups', { method: 'POST', body: JSON.stringify({ name, kind }) }));
const editors = await group('Landflow Editors');
const approvers = await group('Landflow Admins');
// The Onboard flow's birthright groups (its map names them; Landflow Editors is already there).
await group('Everyone', 'birthright');
await group('Engineers', 'birthright');
const me = await lb('/api/auth/me');

const subs = (await lb('/api/events/subscriptions')).items as Array<{ id: string; url: string }>;
const subscribe = async (path: string, events: string[], description: string) => {
  const url = `${LANDFLOW}/api/webhook/${path}`;
  const existing = subs.find((s) => s.url === url);
  if (existing)
    await lb(`/api/events/subscriptions/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ events, description, disabled: false }),
    });
  else
    await lb('/api/events/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ url, events, description, audience: LANDFLOW }),
    });
  console.log(`Landbright: ${events.join(', ')} → ${url}`);
};
await subscribe('landbright-requests', ['request.created'], 'Landflow: Approve a request (email)');
if (SLACK_TOKEN)
  await subscribe('landbright-requests-slack', ['request.created'], 'Landflow: Approve a request (Slack)');
await subscribe('landbright-people', ['identity.created'], 'Landflow: Onboard a new person');
await subscribe('landbright-ciba', ['ciba.requested'], 'Landflow: Ask a person for an agent (CIBA)');
await subscribe(
  'landbright-grants',
  ['grant.activated', 'grant.expired', 'grant.revoked', 'grant.revoke_overdue'],
  'Landflow: Provision and revoke a Landflow project role',
);

// ---------------------------------------------------------------- Landflow
let cookie = '';
{
  const res = await fetch(`${LANDFLOW}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(LANDFLOW_OWNER),
  });
  await check(res, 'Landflow sign-in');
  cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}
const lf = (path: string, init: RequestInit = {}) =>
  fetch(`${LANDFLOW}${path}`, {
    ...init,
    headers: { cookie, origin: LANDFLOW, ...(init.body ? { 'content-type': 'application/json' } : {}) },
  }).then((r) => check(r, `Landflow ${init.method ?? 'GET'} ${path}`));

const projects = (await lf('/api/projects')).projects as Array<{ id: string; name: string }>;
const payments =
  projects.find((p) => p.name === 'Payments') ??
  (
    await lf('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Payments', description: 'Given for a while through Landbright' }),
    })
  ).project;
console.log(`Landflow: project Payments is ${payments.id}`);

// The bundle (Landbright), now that the project id is known.
const bundles = (await lb('/api/bundles')).items as Array<{ id: string; name: string }>;
const bundleBody = {
  name: 'Landflow Editors (JIT)',
  description: 'Edit Landflow workflows, and the Payments project, for a while.',
  ownerId: me.id,
  groupIds: [editors.id],
  targets: [
    {
      key: 'landflow:payments-editor',
      type: 'landflow-project-role',
      label: 'Landflow project Payments, editor',
      config: { project: payments.id, role: 'editor' },
    },
  ],
  policy: {
    steps: [{ name: 'Landflow Admins', approvers: { groupIds: [approvers.id] }, approvalsRequired: 1 }],
    defaultDurationMinutes: 60,
    maxDurationMinutes: 240,
    decisionDeadlineMinutes: 30,
    expiringNoticeMinutes: 5,
  },
};
const bundle = bundles.find((b) => b.name === bundleBody.name);
await lb(bundle ? `/api/bundles/${bundle.id}` : '/api/bundles', {
  method: bundle ? 'PATCH' : 'POST',
  body: JSON.stringify(bundleBody),
});
console.log(`Landbright: bundle "${bundleBody.name}" (group Landflow Editors + Payments editor)`);

const credentials = (await lf('/api/credentials')).credentials as Array<{ id: string; name: string }>;
const credential = async (name: string, type: string, data: Record<string, unknown>) => {
  const existing = credentials.find((c) => c.name === name);
  if (existing)
    return (
      (await lf(`/api/credentials/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ name, data }) }))
        .credential?.id ?? existing.id
    );
  return (await lf('/api/credentials', { method: 'POST', body: JSON.stringify({ name, type, data }) })).credential
    .id as string;
};
const jwtCred = await credential('Landbright events', 'core.jwtAuth', {
  keyType: 'jwks',
  jwksUrl: `${ISSUER}/jwks`,
  algorithm: 'RS256',
  issuer: ISSUER,
  audience: LANDFLOW,
});
const lbCred = await credential('Landbright API', 'core.oAuth2Api', {
  grantType: 'clientCredentials',
  accessTokenUrl: `${ISSUER}/token`,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  scope: SCOPES.join(' '),
  authentication: 'header',
});
const keys = (await lf('/api/api-keys')).keys as Array<{ id: string; label: string }> | undefined;
for (const k of keys?.filter((k) => k.label === 'Landbright flows') ?? [])
  await lf(`/api/api-keys/${k.id}`, { method: 'DELETE' });
const { token } = await lf('/api/api-keys', {
  method: 'POST',
  body: JSON.stringify({ label: 'Landbright flows', scopes: ['admin'] }),
});
const lfCred = await credential('Landflow API', 'core.httpHeaderAuth', {
  name: 'Authorization',
  value: `Bearer ${token}`,
});
const slackCred = SLACK_TOKEN
  ? await credential('Slack bot token', 'core.httpHeaderAuth', {
      name: 'Authorization',
      value: `Bearer ${SLACK_TOKEN}`,
    })
  : '';
console.log(
  `Landflow: credentials Landbright events (JWT, JWKS), Landbright API (client credentials), Landflow API${SLACK_TOKEN ? ', Slack bot token' : ''}`,
);

const existing = ((await lf('/api/workflows')).workflows ?? []) as Array<{ id: string; name: string }>;
for (const file of readdirSync(flowsDir)
  .filter((f) => f.endsWith('.json'))
  .sort()) {
  const raw = readFileSync(resolve(flowsDir, file), 'utf8');
  if (raw.includes('__CRED_SLACK__') && !SLACK_TOKEN) {
    console.log(`Landflow: skipped ${file} (set SLACK_BOT_TOKEN to install the Slack flows)`);
    continue;
  }
  const text = raw
    .replaceAll('__LANDBRIGHT_API__', CONTROL)
    .replaceAll('__LANDFLOW_API__', LANDFLOW)
    .replaceAll('__MAIL_API__', MAIL_API)
    .replaceAll('__CRED_JWT__', jwtCred)
    .replaceAll('__CRED_LANDBRIGHT__', lbCred)
    .replaceAll('__CRED_LANDFLOW__', lfCred)
    .replaceAll('__CRED_SLACK__', slackCred)
    .replaceAll('__SLACK_API__', SLACK_API);
  const flow = JSON.parse(text) as { name: string };
  const old = existing.find((w) => w.name === flow.name);
  let id: string;
  if (old) {
    await lf(`/api/workflows/${old.id}`, { method: 'PUT', body: JSON.stringify(flow) });
    id = old.id;
  } else {
    const imported = await lf('/api/workflows/import', {
      method: 'POST',
      body: JSON.stringify({ data: flow, name: flow.name }),
    });
    id = imported.workflow.id;
    if (imported.report?.placeholders?.length) console.warn(`  ${file}: unknown nodes`, imported.report.placeholders);
  }
  await lf(`/api/workflows/${id}/publish`, {
    method: 'POST',
    body: JSON.stringify({ note: 'Installed by Landbright' }),
  });
  console.log(`Landflow: published "${flow.name}" (${id})`);
}
