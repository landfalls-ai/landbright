import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { type BrowserContext, expect, type Locator, type Page, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Secret, TOTP } from 'otpauth';
import { FakeScim } from '../test/fake-scim';
import { LandflowLikeRp } from '../test/landflow-rp';
import { MAILPIT, type Stack, startStack } from '../test/stack';

/**
 * The console and the sign-in pages in real Chromium, as one story: an administrator signs in and builds the
 * directory through the console; Maya sets her password from the invite, adds a passkey (Chrome's virtual
 * authenticator, so the page's own script runs the ceremony) and signs in to a Landflow-shaped app with it; Noa sets
 * up an authenticator app; the console then shows what happened; Tom meets required actions, resets a forgotten
 * password, uses their account page and a recovery code, and is asked again by an app that needs a passkey; Lia
 * connects her release bot's key, and approves the bot on Landbright's CIBA page and with a device code; Landflow's
 * SCIM server (a Landflow-shaped fake) is connected, and Maya's deactivation reaches it. Each screen is captured on the
 * way.
 */
const flags = (process.env.LANDBRIGHT_INTEGRATION ?? '').split(',');
test.skip(!flags.includes('browser') && !flags.includes('all'), 'LANDBRIGHT_INTEGRATION=browser runs these');
test.describe.configure({ mode: 'serial' });

const SCREENSHOTS = resolve(import.meta.dirname, '../../docs/screenshots');

let stack: Stack;
let admin: BrowserContext;
let page: Page;
let rp: LandflowLikeRp;
let landflow: { url: string; close(): void };
const callback = () => `${landflow.url}/api/auth/oidc/callback`;
const people: Record<string, { email: string; password: string }> = {};

/** A screenshot in the test's output, and in docs/screenshots when LANDBRIGHT_SCREENSHOTS is set. */
async function shot(target: Page, name: string, options: { fullPage?: boolean; mask?: Locator[] } = {}) {
  const info = test.info();
  await target.evaluate('document.fonts.ready');
  const path = process.env.LANDBRIGHT_SCREENSHOTS
    ? resolve(SCREENSHOTS, `${name}.png`)
    : info.outputPath(`${name}.png`);
  mkdirSync(resolve(path, '..'), { recursive: true });
  await target.screenshot({
    path,
    fullPage: options.fullPage ?? false,
    animations: 'disabled',
    mask: options.mask,
    maskColor: '#c8c8c8',
  });
}

/** The console's API with the administrator's session (writes need the console's Origin). */
async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await admin.request.fetch(`${stack.console}${path}`, {
    method,
    headers: { origin: stack.console },
    ...(body === undefined ? {} : { data: body }),
  });
  expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

async function invite(email: string): Promise<{ id: string; link: string }> {
  const search = (await (
    await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)
  ).json()) as { messages: Array<{ ID: string }> };
  const message = (await (await fetch(`${MAILPIT}/api/v1/message/${search.messages[0]!.ID}`)).json()) as {
    Text: string;
  };
  return { id: search.messages[0]!.ID, link: /http:\/\/\S+\/invite\/[A-Za-z0-9_-]+/.exec(message.Text)![0] };
}

/**
 * A Landflow-shaped app: its callback finishes the sign-in as Landflow does (code exchange, ID token, role map) and
 * shows the result. A real server, since the identity plane reaches the callback by redirect.
 */
async function startLandflowLikeApp(): Promise<{ url: string; close(): void }> {
  const server = createServer((req, res) => {
    const callback = new URL(req.url ?? '/', `http://${req.headers.host}`).href;
    rp.complete(callback).then(
      ({ claims, role }) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><title>Landflow (test app)</title>
<body style="font:15px system-ui;margin:48px;color:#1c1917">
<p style="color:#78716c;margin:0 0 6px">A Landflow-shaped test app, after the OIDC callback</p>
<h1 style="font-size:22px;margin:0 0 16px">Signed in as ${String(claims.name)}</h1>
<table style="border-collapse:collapse" cellpadding="6">
<tr><td>email</td><td><code>${String(claims.email)}</code></td></tr>
<tr><td>roles claim</td><td><code>${JSON.stringify(claims.roles)}</code></td></tr>
<tr><td>Landflow role</td><td><code>${role}</code></td></tr>
<tr><td>amr</td><td><code data-amr>${JSON.stringify(claims.amr)}</code></td></tr>
<tr><td>issuer</td><td><code>${claims.iss}</code></td></tr>
</table></body>`);
      },
      (error: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`callback failed: ${String(error)}`);
      },
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** A person's own browser. With `passkeys`, Chrome's virtual authenticator stands in for Touch ID. */
async function personBrowser(context: BrowserContext, options: { passkeys?: boolean } = {}) {
  const tab = await context.newPage();
  if (options.passkeys) {
    const cdp = await context.newCDPSession(tab);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
  }
  return tab;
}

/** Starts a sign-in to the Landflow-shaped app; `prompt=login` asks again even with a session at the identity plane. */
async function startLandflowSignIn(tab: Page) {
  const url = new URL(await rp.authorizationUrl());
  url.searchParams.set('prompt', 'login');
  await tab.goto(url.href);
  await expect(tab.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

const landedWith = async (tab: Page, amr: string[]) => {
  await expect(tab.locator('[data-amr]')).toHaveText(JSON.stringify(amr));
};

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  stack = await startStack({ console: true });
  landflow = await startLandflowLikeApp();
  admin = await browser.newContext();
  page = await admin.newPage();
});
test.afterAll(async () => {
  landflow?.close();
  await admin?.close();
  await stack?.stop();
});

test('the administrator signs in to the console', async () => {
  await page.goto(stack.console);
  await expect(page).toHaveURL(new RegExp(`^${stack.idp}/`));
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  await shot(page, '01-sign-in');

  await page.getByLabel('Email').fill(stack.admin.email);
  await page.getByLabel('Password').fill(stack.admin.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Add a second step' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use a passkey instead' })).toBeVisible();
  await shot(page, '02-second-step-offer');

  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page).toHaveURL(`${stack.console}/`);
  await expect(page.getByRole('link', { name: 'People', exact: true })).toBeVisible();
});

test('builds the directory in the console', async () => {
  await page.getByRole('link', { name: 'Groups', exact: true }).click();
  await page.getByRole('button', { name: 'New group' }).first().click();
  await page.getByRole('textbox', { name: /^Name/ }).fill('Landflow Editors');
  await page.getByRole('textbox', { name: /^Description/ }).fill('Edit Landflow workflows');
  await shot(page, '04-new-group');
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Landflow Editors');
  await api('/api/groups', 'POST', { name: 'Data Team', description: 'Analysts and the data pipelines' });
  await api('/api/groups', 'POST', { name: 'On-call', description: 'Incident responders', kind: 'birthright' });

  // Maya through the dialog, Noa and Lior through the API.
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await page.getByRole('button', { name: 'Add person' }).first().click();
  await page.getByLabel('First name').fill('Maya');
  await page.getByLabel('Last name').fill('Cohen');
  await page.getByLabel('Work email').fill(`maya@${stack.slug}.test`);
  await page.getByRole('textbox', { name: /^Department/ }).fill('Engineering');
  await page.getByRole('textbox', { name: /^Title/ }).fill('Platform engineer');
  await page.getByText('Landflow Editors', { exact: true }).click();
  await shot(page, '05-add-person');
  await page.getByRole('button', { name: 'Add person' }).last().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Maya Cohen');
  people.maya = { email: `maya@${stack.slug}.test`, password: 'maya-correct-horse-battery' };

  const groups = (await api<{ items: Array<{ id: string; name: string }> }>('/api/groups')).items;
  const id = (name: string) => groups.find((g) => g.name === name)!.id;
  const noa = await api<{ id: string }>('/api/people', 'POST', {
    email: `noa@${stack.slug}.test`,
    givenName: 'Noa',
    familyName: 'Levi',
    department: 'Data',
    title: 'Analyst',
    groupIds: [id('Data Team'), id('Landflow Editors')],
  });
  people.noa = { email: `noa@${stack.slug}.test`, password: 'noa-staple-lantern-river' };
  await api('/api/people', 'POST', {
    email: `lior@${stack.slug}.test`,
    givenName: 'Lior',
    familyName: 'Ben-David',
    department: 'SRE',
    title: 'Site reliability',
    groupIds: [id('On-call')],
    sendInvite: false,
  });
  await api('/api/agents', 'POST', {
    displayName: 'Release notes bot',
    sponsorId: noa.id,
    purpose: 'Drafts release notes from merged pull requests',
    riskTier: 'low',
    homeProject: 'Data',
  });
  // Written through the API, so the console's cached list is reloaded.
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await page.reload();
  await expect(page.getByText(`noa@${stack.slug}.test`)).toBeVisible();
  await shot(page, '06-people');

  await page.getByRole('link', { name: 'Agents', exact: true }).click();
  await expect(page.getByText('Release notes bot')).toBeVisible();
  await shot(page, '07-agents');

  await page.getByRole('link', { name: 'Groups', exact: true }).click();
  await expect(page.getByRole('row', { name: /^Data Team/ })).toBeVisible();
  await shot(page, '08-groups');
  await page.getByRole('row', { name: /^Landflow Editors/ }).click();
  await expect(page.getByText(`maya@${stack.slug}.test`)).toBeVisible();
  await shot(page, '09-group');
});

test('registers Landflow as an application', async () => {
  await page.getByRole('link', { name: 'Applications', exact: true }).click();
  await page.getByRole('button', { name: 'Register' }).first().click();
  await page.getByRole('textbox', { name: /^Name/ }).fill('Landflow');
  // Client ids are unique across the test database's tenants.
  await page.getByRole('textbox', { name: /^Client id/ }).fill(`landflow-${stack.slug}`);
  await page.getByRole('textbox', { name: /^Redirect URIs/ }).fill(callback());
  await shot(page, '10-register-application');
  await page.getByRole('button', { name: 'Register', exact: true }).last().click();
  await expect(page.getByText('Copy it now.')).toBeVisible();
  // The secret is a test tenant's, but the screenshots are published: cover it, here and in the .env lines.
  const secret = (await page.getByTestId('client-secret').textContent())!;
  await page.locator('pre').evaluate((pre, value) => {
    const [before, after] = pre.textContent!.split(value) as [string, string];
    const covered = Object.assign(pre.ownerDocument.createElement('span'), { textContent: value });
    covered.dataset.screenshotMask = '';
    pre.replaceChildren(before, covered, after);
  }, secret);
  await shot(page, '11-application-secret', {
    mask: [page.getByTestId('client-secret'), page.locator('[data-screenshot-mask]')],
  });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Copy it now.')).toBeHidden();
  await shot(page, '12-applications');

  // Back-channel logout: where Landflow would hear that someone's session ended. Shown, then cleared (the stand-in
  // Landflow here has no endpoint).
  await page.getByTestId(`edit-logout-landflow-${stack.slug}`).click();
  await page
    .getByRole('textbox', { name: /^Back-channel logout URI/ })
    .fill(`${callback().replace(/\/api\/auth\/oidc\/callback$/, '')}/api/auth/oidc/backchannel-logout`);
  await shot(page, '12a-application-logout');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId(`logout-uri-landflow-${stack.slug}`)).toContainText('backchannel-logout');
  await page.getByTestId(`edit-logout-landflow-${stack.slug}`).click();
  await page.getByRole('textbox', { name: /^Back-channel logout URI/ }).fill('');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId(`logout-uri-landflow-${stack.slug}`)).toContainText('Not told');

  const apps = (await api<{ items: Array<{ clientId: string; name: string }> }>('/api/applications')).items;
  rp = new LandflowLikeRp({
    issuer: stack.issuer,
    clientId: apps.find((a) => a.name === 'Landflow')!.clientId,
    clientSecret: secret.trim(),
    redirectUri: callback(),
    scopes: 'openid email profile roles',
    roleMap: { 'Landflow Editors': 'member', 'Landbright Admins': 'admin' },
  });
});

test('Maya sets her password, adds a passkey and signs in with it', async ({ browser }) => {
  const context = await browser.newContext();
  const tab = await personBrowser(context, { passkeys: true });
  const mail = await invite(people.maya!.email);
  await tab.goto(`${MAILPIT}/view/${mail.id}`);
  await expect(tab.getByText('Set your Landbright password').first()).toBeVisible();
  await shot(tab, '13a-invite-email');
  await tab.goto(mail.link);
  await expect(tab.getByRole('heading', { name: 'Welcome, Maya' })).toBeVisible();
  await shot(tab, '13-invite');
  await tab.getByLabel('Password', { exact: true }).fill(people.maya!.password);
  await tab.getByLabel('Repeat it').fill(people.maya!.password);
  await tab.getByRole('button', { name: 'Set password' }).click();
  await expect(tab.getByRole('heading')).toBeVisible();
  await shot(tab, '14-password-set');

  // Password, then "Use a passkey instead" on the offer: the page's script asks the authenticator.
  await startLandflowSignIn(tab);
  await tab.getByLabel('Email').fill(people.maya!.email);
  await tab.getByLabel('Password').fill(people.maya!.password);
  await tab.getByRole('button', { name: 'Sign in', exact: true }).click();
  await tab.getByRole('button', { name: 'Use a passkey instead' }).click();
  await landedWith(tab, ['pwd', 'pop', 'mfa']);
  await shot(tab, '15-landflow-after-passkey-added');

  // The passkey alone.
  await startLandflowSignIn(tab);
  await tab.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await landedWith(tab, ['pop', 'mfa']);
  await shot(tab, '16-landflow-passkey-only');

  // The password, then the passkey as the second step.
  await startLandflowSignIn(tab);
  await tab.getByLabel('Email').fill(people.maya!.email);
  await tab.getByLabel('Password').fill(people.maya!.password);
  await tab.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(tab.getByRole('heading', { name: 'Use your passkey' })).toBeVisible();
  await shot(tab, '17-second-step-passkey');
  await tab.getByRole('button', { name: 'Use your passkey' }).click();
  await landedWith(tab, ['pwd', 'pop', 'mfa']);
  await context.close();
});

test('Noa sets up an authenticator app', async ({ browser }) => {
  const context = await browser.newContext();
  const tab = await personBrowser(context);
  await tab.goto((await invite(people.noa!.email)).link);
  await tab.getByLabel('Password', { exact: true }).fill(people.noa!.password);
  await tab.getByLabel('Repeat it').fill(people.noa!.password);
  await tab.getByRole('button', { name: 'Set password' }).click();

  await startLandflowSignIn(tab);
  await tab.getByLabel('Email').fill(people.noa!.email);
  await tab.getByLabel('Password').fill(people.noa!.password);
  await tab.getByRole('button', { name: 'Sign in', exact: true }).click();
  const secret = Secret.fromBase32((await tab.locator('[data-secret]').textContent())!.replace(/\s+/g, ''));
  const code = (offset = 0) => new TOTP({ secret }).generate({ timestamp: Date.now() + offset });
  await tab.getByLabel(/code/i).fill(code());
  await tab.getByRole('button', { name: 'Turn it on' }).click();
  await landedWith(tab, ['pwd', 'otp', 'mfa']);

  await startLandflowSignIn(tab);
  await tab.getByLabel('Email').fill(people.noa!.email);
  await tab.getByLabel('Password').fill(people.noa!.password);
  await tab.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(tab.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
  await shot(tab, '18-second-step-code');
  // The setup used this 30-second step's code; the next step's is accepted too.
  await tab.getByLabel(/code/i).fill(code(30_000));
  await tab.getByRole('button', { name: 'Continue' }).click();
  await landedWith(tab, ['pwd', 'otp', 'mfa']);
  await shot(tab, '19-landflow-after-code');
  await context.close();
});

test('the console shows what happened', async () => {
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await page.reload();
  await expect(page.getByText('All systems up').first()).toBeVisible();
  await shot(page, '03-console-home');

  await page.getByRole('link', { name: 'People', exact: true }).click();
  await page.getByRole('row', { name: /^Maya Cohen/ }).click();
  await expect(page.getByText('Passkey', { exact: true })).toBeVisible();
  await shot(page, '20-person');

  await page.getByRole('link', { name: 'Audit log', exact: true }).click();
  await expect(page.getByText('credential.passkey_added').first()).toBeVisible();
  await shot(page, '21-audit');

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('Passkey').first()).toBeVisible();
  await shot(page, '22-settings');

  await page.goto(`${stack.console}/health`);
  await expect(page.getByRole('heading').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  await shot(page, '23-health');

  await page.getByRole('link', { name: /^Sources/ }).click();
  await expect(page.getByText('Sources arrives in wave 3')).toBeVisible();
  await shot(page, '24-upcoming-sources');

  await page.getByRole('radio', { name: 'Dark' }).click();
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await expect(page.getByText(`noa@${stack.slug}.test`)).toBeVisible();
  // Reaching the theme switch scrolled the sidebar; back to the top for the picture.
  await page.evaluate('for (const el of document.querySelectorAll("*")) el.scrollTop = 0');
  await shot(page, '26-people-dark');
  await page.getByRole('radio', { name: 'System' }).click();
});

test('Ido asks for access in the console; the administrator approves it and revokes it', async ({ browser }) => {
  // A Landflow flow would deliver the events and provision the target; here a local endpoint stands in and answers
  // as Landflow's Webhook trigger does, so the Events page has deliveries to show.
  const hook = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ executionId: `ex_${Math.random().toString(36).slice(2, 10)}` }));
    });
  });
  await new Promise<void>((done) => hook.listen(0, '127.0.0.1', done));
  const hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/api/webhook/landbright-access`;

  const me = await api<{ id: string }>('/api/auth/me');
  const groups = (await api<{ items: Array<{ id: string; name: string; system: boolean }> }>('/api/groups')).items;
  const editors = groups.find((g) => g.name === 'Landflow Editors')!;
  const admins = groups.find((g) => g.system)!;
  await api('/api/events/subscriptions', 'POST', {
    url: hookUrl,
    events: ['request.*', 'grant.*'],
    description: 'Landflow: Approve a request, and provision its Landflow role',
  });
  const bundle = await api<{ id: string }>('/api/bundles', 'POST', {
    name: 'Landflow Editors (JIT)',
    description: 'Edit Landflow workflows, and the Payments project, for a while.',
    ownerId: me.id,
    groupIds: [editors.id],
    targets: [
      {
        key: 'landflow:payments-editor',
        type: 'landflow-project-role',
        label: 'Landflow project Payments, editor',
        config: { project: 'prj_payments', role: 'editor' },
      },
    ],
    policy: {
      steps: [{ name: admins.name, approvers: { groupIds: [admins.id] }, approvalsRequired: 1 }],
      defaultDurationMinutes: 60,
      maxDurationMinutes: 240,
      decisionDeadlineMinutes: 60,
    },
  });

  // Ido: a person, not an administrator. The console shows him his requests, and nothing else.
  const ido = { email: `ido@${stack.slug}.test`, password: 'ido-velvet-compass-harbor' };
  await api('/api/people', 'POST', {
    email: ido.email,
    givenName: 'Ido',
    familyName: 'Shapira',
    department: 'Payments',
    title: 'Engineer',
  });
  const context = await browser.newContext();
  const tab = await personBrowser(context);
  await tab.goto((await invite(ido.email)).link);
  await tab.getByLabel('Password', { exact: true }).fill(ido.password);
  await tab.getByLabel('Repeat it').fill(ido.password);
  await tab.getByRole('button', { name: 'Set password' }).click();
  await expect(tab.getByRole('heading')).toBeVisible();
  await tab.goto(stack.console);
  await tab.waitForURL((u) => u.href.startsWith(stack.idp) || u.href === `${stack.console}/requests`);
  if (tab.url().startsWith(stack.idp)) {
    await tab.getByLabel('Email').fill(ido.email);
    await tab.getByLabel('Password').fill(ido.password);
    await tab.getByRole('button', { name: 'Sign in', exact: true }).click();
    await tab.getByRole('button', { name: 'Not now' }).click();
  }
  await expect(tab).toHaveURL(`${stack.console}/requests`);
  await expect(tab.getByRole('link', { name: 'People', exact: true })).toHaveCount(0);

  await tab.getByTestId('ask-access').first().click();
  await tab
    .getByRole('textbox', { name: /^Why do you need it/ })
    .fill('Fix the Payments retry flow before the release');
  await expect(tab.getByTestId('preview')).toContainText('Decided by');
  await shot(tab, '40-request-access');
  await tab.getByTestId('submit-request').click();
  await expect(tab.getByText('Waiting', { exact: true })).toBeVisible();
  await expect(tab.getByRole('heading', { level: 1 })).toContainText('Landflow Editors (JIT)');
  await shot(tab, '41-request-waiting');
  const ref = /REQ-\d+/.exec(tab.url())![0];

  // A page for administrators says so.
  await tab.goto(`${stack.console}/people`);
  await expect(tab.getByTestId('admin-only')).toBeVisible();

  // The administrator: To decide, then the request (the page every Landflow flow links to).
  await page.goto(`${stack.console}/requests?tab=to-decide`);
  await expect(page.getByTestId(`request-${ref}`)).toBeVisible();
  await shot(page, '42-to-decide');
  await page.getByTestId(`request-${ref}`).click();
  await page.getByTestId('approve').click();
  await page.getByRole('textbox', { name: /^Comment/ }).fill('OK for the hour');
  await shot(page, '43-approve');
  await page.getByTestId('confirm-decision').click();
  await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible();
  // Landbright gave the group; the Landflow role waits for its flow.
  await expect(page.getByTestId(`target-group:${editors.id}`)).toContainText('Provisioned');
  await expect(page.getByTestId('target-landflow:payments-editor')).toContainText('Waiting for its flow');
  await shot(page, '44-request-approved', { fullPage: true });

  await page.getByRole('link', { name: 'Grants', exact: true }).click();
  await expect(page.getByTestId(`grant-${ref}`)).toBeVisible();
  await shot(page, '45-grants');

  await page.getByRole('link', { name: 'Catalog', exact: true }).click();
  await page.getByTestId('bundle-Landflow Editors (JIT)').click();
  await expect(page.getByRole('heading', { name: 'Landflow Editors (JIT)' })).toBeVisible();
  await shot(page, '46-bundle');
  await page.keyboard.press('Escape');
  await shot(page, '47-catalog');

  await page.getByRole('link', { name: 'Events', exact: true }).click();
  await page.getByTestId(`subscription-${hookUrl}`).click();
  await expect(page.getByText('request.decided').first()).toBeVisible();
  await expect(page.getByText('grant.activated').first()).toBeVisible();
  await shot(page, '48-events', { fullPage: true });

  // Revoked: the group goes at once, and the flow's target can't be provisioned any more.
  await page.goto(`${stack.console}/access/requests/${ref}`);
  await page.getByTestId('revoke').click();
  await page.getByTestId('confirm-revoke').click();
  await expect(page.getByText('Revoked', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId(`target-group:${editors.id}`)).toContainText('Removed');
  const detail = await api<{ members: Array<{ email: string | null }> }>(`/api/groups/${editors.id}`);
  expect(detail.members.map((m) => m.email)).not.toContain(ido.email);
  expect(bundle.id).toBeTruthy();
  await context.close();
  hook.close();
});

test('Tom: required actions, a forgotten password, their account page, recovery codes and step-up', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const tom = { email: `tom@${stack.slug}.test`, password: 'tom-correct-horse-battery' };
  const created = await api<{ id: string }>('/api/people', 'POST', {
    email: tom.email,
    givenName: 'Tom',
    familyName: 'Navon',
    department: 'Engineering',
  });
  const context = await browser.newContext();
  const tab = await personBrowser(context);
  await tab.goto((await invite(tom.email)).link);
  await tab.getByLabel('Password', { exact: true }).fill(tom.password);
  await tab.getByLabel('Repeat it').fill(tom.password);
  await tab.getByRole('button', { name: 'Set password' }).click();
  await expect(tab.getByRole('heading', { name: 'Your password is set' })).toBeVisible();

  // The administrator asks for a new password and the terms, without an email: Tom meets them at sign-in.
  await page.goto(`${stack.console}/people/${created.id}`);
  await page.getByRole('button', { name: 'Ask them to…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ask Tom to…' });
  await dialog.getByRole('button', { name: 'Choose a new password' }).click();
  await dialog.getByRole('button', { name: 'Accept the terms' }).click();
  await shot(page, '70-ask-them-to');
  await dialog.getByRole('switch', { name: 'Email them' }).click();
  await page.getByTestId('save-actions').click();
  await expect(page.getByTestId('required-actions')).toContainText('Choose a new password');

  const signInAs = async (password: string) => {
    await tab.getByLabel('Email').fill(tom.email);
    await tab.getByLabel('Password').fill(password);
    await tab.getByRole('button', { name: 'Sign in', exact: true }).click();
  };
  await startLandflowSignIn(tab);
  await signInAs(tom.password);
  await tab.getByRole('button', { name: 'Not now' }).click();
  await expect(tab.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await shot(tab, '71-required-new-password');
  tom.password = 'tom-second-horse-battery';
  await tab.getByLabel('Password', { exact: true }).fill(tom.password);
  await tab.getByLabel('Repeat it').fill(tom.password);
  await tab.getByRole('button', { name: 'Save and continue' }).click();
  await expect(tab.getByRole('heading', { name: 'Before you continue' })).toBeVisible();
  await tab.getByLabel('I accept the terms').check();
  await shot(tab, '72-accept-terms');
  await tab.getByRole('button', { name: 'Continue' }).click();
  await landedWith(tab, ['pwd']);

  // Forgot password: the same answer for anyone; a one-time link by email.
  await startLandflowSignIn(tab);
  await tab.getByRole('link', { name: 'Forgot your password?' }).click();
  await tab.getByLabel('Email').fill(tom.email);
  await shot(tab, '73-forgot-password');
  await tab.getByRole('button', { name: 'Send the link' }).click();
  await expect(tab.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  let link = '';
  await expect(async () => {
    const search = (await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${tom.email}" subject:"Reset"`)}`)
    ).json()) as { messages: Array<{ ID: string }> };
    const message = (await (await fetch(`${MAILPIT}/api/v1/message/${search.messages[0]!.ID}`)).json()) as {
      Text: string;
    };
    link = /http:\/\/\S+\/reset\/[A-Za-z0-9_-]+/.exec(message.Text)![0];
  }).toPass({ timeout: 10_000 });
  await tab.goto(link);
  tom.password = 'tom-third-horse-battery-staple';
  await tab.getByLabel('Password', { exact: true }).fill(tom.password);
  await tab.getByLabel('Repeat it').fill(tom.password);
  await shot(tab, '74-reset-password');
  await tab.getByRole('button', { name: 'Save password' }).click();
  await expect(tab.getByRole('heading', { name: 'Your password is changed' })).toBeVisible();

  // Tom's account page: an authenticator app, then recovery codes.
  await tab.goto(`${stack.idp}/account`);
  await signInAs(tom.password);
  await expect(tab.getByRole('heading', { name: 'Tom Navon' })).toBeVisible();
  await tab.getByRole('link', { name: 'Add an authenticator app' }).click();
  const secret = Secret.fromBase32((await tab.locator('[data-secret]').textContent())!.replace(/\s+/g, ''));
  const code = (offset = 0) => new TOTP({ secret }).generate({ timestamp: Date.now() + offset });
  await tab.getByLabel(/code/i).fill(code());
  await tab.getByRole('button', { name: 'Turn it on' }).click();
  await expect(tab.getByText('Your authenticator app is set up.')).toBeVisible();
  await tab.getByRole('button', { name: 'Create recovery codes' }).click();
  await expect(tab.getByRole('heading', { name: 'Your recovery codes' })).toBeVisible();
  const codes = await tab.locator('[data-codes] code').allTextContents();
  expect(codes).toHaveLength(10);
  await shot(tab, '76-recovery-codes');
  await tab.getByRole('link', { name: 'I’ve saved them' }).click();
  await expect(tab.getByText('10 unused.')).toBeVisible();
  await shot(tab, '75-account', { fullPage: true });

  // A recovery code instead of the app.
  await startLandflowSignIn(tab);
  await signInAs(tom.password);
  await expect(tab.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
  await tab.locator('summary', { hasText: 'Use a recovery code' }).click();
  await tab.getByLabel('Recovery code').fill(codes[0]!);
  await shot(tab, '77-second-step-recovery');
  await tab.getByRole('button', { name: 'Use this code' }).click();
  await landedWith(tab, ['pwd', 'otp', 'mfa']);

  // Step-up: the application now needs a passkey; Tom, signed in with a code, is asked again.
  const apps = await api<{ items: Array<{ id: string; clientId: string }> }>('/api/applications');
  const app = apps.items.find((a) => a.clientId === rp.config.clientId)!;
  await page.goto(`${stack.console}/applications`);
  await page.getByTestId(`strength-${app.clientId}`).selectOption('urn:landbright:acr:phr');
  await expect(page.getByText('now asks for a passkey')).toBeVisible();
  await shot(page, '79-application-sign-in-needs');
  await tab.goto(await rp.authorizationUrl());
  await expect(tab.getByText('asks for a passkey.')).toBeVisible();
  await shot(tab, '78-step-up');
  await signInAs(tom.password);
  await expect(tab.getByRole('heading', { name: 'This app needs a passkey' })).toBeVisible();
  await api(`/api/applications/${app.id}`, 'PATCH', { minimumAcr: null });
  await context.close();
});

test('Lia: her release bot’s key, a CIBA request she approves, and a device code', async ({ browser }) => {
  test.setTimeout(120_000);
  const lia = { email: `lia@${stack.slug}.test`, password: 'lia-correct-horse-battery' };
  const person = await api<{ id: string }>('/api/people', 'POST', {
    email: lia.email,
    givenName: 'Lia',
    familyName: 'Peretz',
    department: 'Platform',
  });
  const context = await browser.newContext();
  const tab = await personBrowser(context);
  await tab.goto((await invite(lia.email)).link);
  await tab.getByLabel('Password', { exact: true }).fill(lia.password);
  await tab.getByLabel('Repeat it').fill(lia.password);
  await tab.getByRole('button', { name: 'Set password' }).click();
  await expect(tab.getByRole('heading', { name: 'Your password is set' })).toBeVisible();
  const agent = await api<{ id: string }>('/api/agents', 'POST', {
    displayName: 'Release bot',
    sponsorId: person.id,
    purpose: 'Cuts releases and files access requests for Lia',
    runtime: 'claude_code',
    maxTokenTtlSeconds: 600,
    actFor: 'sponsor',
  });

  // Lia's administrator connects the bot: its public key, pasted on the Agents page.
  const keys = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'release-bot-1', alg: 'ES256', use: 'sig' };
  await page.goto(`${stack.console}/agents`);
  await page.getByTestId('keys-Release bot').click();
  await page.getByTestId('jwks').fill(JSON.stringify({ keys: [jwk] }, null, 2));
  await shot(page, '80-agent-connect');
  await page.getByTestId('save-keys').click();
  await expect(page.getByTestId('agent-app')).toContainText('private_key_jwt');
  await shot(page, '81-agent-connected');
  const clientId = (await page.getByTestId('agent-app').locator('dd').first().textContent())!.trim();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.goto(`${stack.console}/applications`);
  await expect(page.getByTestId(`app-${clientId}`)).toContainText('Agent');
  await page.getByTestId(`app-${clientId}`).scrollIntoViewIfNeeded();
  await shot(page, '82-agent-application');

  const asAgent = async (path: string, fields: Record<string, string>) => {
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience(stack.issuer)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(keys.privateKey);
    const response = await fetch(`${stack.issuer}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
        ...fields,
      }),
    });
    return (await response.json()) as Record<string, string>;
  };

  // CIBA: the bot asks Lia; the link (Landflow emails it) opens Landbright's page; she signs in and approves.
  const asked = await asAgent('/backchannel', {
    login_hint: lia.email,
    scope: 'openid profile',
    binding_message: 'REL-7',
  });
  const audit = await api<{ items: Array<{ action: string; data: { link?: string } }> }>('/api/audit?limit=20');
  const link = audit.items.find((e) => e.action === 'ciba.requested')!.data.link!;
  await tab.goto(link);
  await tab.getByLabel('Email').fill(lia.email);
  await tab.getByLabel('Password').fill(lia.password);
  await tab.getByRole('button', { name: 'Sign in', exact: true }).click();
  await tab.getByRole('button', { name: 'Not now' }).click();
  await expect(tab.getByRole('heading', { name: 'Release bot asks to act for you' })).toBeVisible();
  await shot(tab, '83-ciba-decide');
  await tab.getByRole('button', { name: 'Approve' }).click();
  await expect(tab.getByRole('heading', { name: 'Approved' })).toBeVisible();
  const ciba = await asAgent('/token', {
    grant_type: 'urn:openid:params:grant-type:ciba',
    auth_req_id: asked.auth_req_id!,
  });
  expect(ciba.access_token).toBeTruthy();

  // The device grant: the bot shows a code in Lia's terminal; she confirms it here.
  const device = await asAgent('/device/auth', { scope: 'openid' });
  await tab.goto(device.verification_uri!);
  await tab.getByLabel('Code').fill(device.user_code!);
  await shot(tab, '84-device-code');
  await tab.getByRole('button', { name: 'Continue' }).click();
  await expect(tab.getByRole('heading', { name: 'Connect Release bot?' })).toBeVisible();
  await shot(tab, '85-device-confirm');
  await tab.getByRole('button', { name: 'Connect' }).click();
  await expect(tab.getByRole('heading', { name: 'Done' })).toBeVisible();
  const tokens = await asAgent('/token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: device.device_code!,
  });
  expect(tokens.access_token).toBeTruthy();
  expect(agent.id).toBeTruthy();
  await context.close();
});

test('connects a SCIM server and keeps it in step', async () => {
  test.setTimeout(150_000);
  const scim = await new FakeScim('landflow').start();
  try {
    await page.goto(`${stack.console}/provisioning`);
    await expect(page.getByText('No provisioning targets')).toBeVisible();
    await page.getByRole('button', { name: 'Add target' }).first().click();
    await page.getByRole('textbox', { name: /^Name/ }).fill('Landflow');
    await page.getByRole('textbox', { name: /^SCIM base URL/ }).fill(scim.url);
    await page.getByLabel(/^Bearer token/).fill(scim.token);
    await page.getByRole('dialog').getByText('Landflow Editors', { exact: true }).click();
    await page.getByRole('dialog').getByText('Data Team', { exact: true }).click();
    await shot(page, '86-provisioning-add', { mask: [page.getByLabel(/^Bearer token/)] });
    await page.getByRole('button', { name: 'Add target' }).last().click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Landflow');
    await expect(page.getByTestId(`pushed-${people.maya!.email}`)).toContainText('Active', { timeout: 20_000 });
    await expect(page.getByText('In sync')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Test' }).click();
    await expect(page.getByTestId('scim-test')).toContainText('took the token');
    await shot(page, '87-provisioning-target', { fullPage: true });

    // Maya leaves: deactivated in Landbright, inactive (signed out) in Landflow within seconds.
    const maya = scim.byUserName(people.maya!.email)!;
    scim.signIn(maya);
    const mayaId = (await api<{ items: Array<{ id: string; email: string }> }>('/api/people')).items.find(
      (p) => p.email === people.maya!.email,
    )!.id;
    await api(`/api/people/${mayaId}/deactivate`, 'POST');
    await expect.poll(() => scim.sessions.has(maya.id), { timeout: 10_000 }).toBe(false);
    await expect(page.getByTestId(`pushed-${people.maya!.email}`)).toContainText('Inactive', { timeout: 10_000 });
    await page.goto(`${stack.console}/provisioning`);
    await expect(page.getByTestId('target-Landflow')).toContainText('In sync', { timeout: 20_000 });
    await shot(page, '88-provisioning');
    await api(`/api/people/${mayaId}/reactivate`, 'POST');

    // A just-in-time grant of Data Team reaches Landflow, and its end takes it away: the request's page shows both.
    const me = await api<{ id: string }>('/api/auth/me');
    const groups = (await api<{ items: Array<{ id: string; name: string; system: boolean }> }>('/api/groups')).items;
    const dataTeam = groups.find((g) => g.name === 'Data Team')!;
    const admins = groups.find((g) => g.system)!;
    const bundle = await api<{ id: string }>('/api/bundles', 'POST', {
      name: 'Data Team (2 hours)',
      ownerId: me.id,
      groupIds: [dataTeam.id],
      policy: {
        steps: [{ name: admins.name, approvers: { groupIds: [admins.id] }, approvalsRequired: 1 }],
        autoApprove: [{ name: 'Administrators', subjectInGroupIds: [admins.id] }],
        maxDurationMinutes: 120,
      },
    });
    const asked = await api<{ ref: string; grant: { id: string } }>('/api/access/requests', 'POST', {
      bundleId: bundle.id,
      durationMinutes: 120,
      reason: 'Quarterly numbers',
    });
    await expect
      .poll(() => scim.byGroupName('Data Team')?.members.includes(scim.byUserName(stack.admin.email)?.id ?? '-'), {
        timeout: 20_000,
      })
      .toBe(true);
    await api(`/api/access/grants/${asked.grant.id}/revoke`, 'POST', { comment: 'Done with the numbers' });
    await page.goto(`${stack.console}/access/requests/${asked.ref}`);
    await expect(page.getByTestId('push-Landflow-removed')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('push-Landflow-added')).toContainText('Data Team');
    await shot(page, '89-grant-pushes', { fullPage: true });
  } finally {
    await scim.stop();
  }
});

test('a joiner from HR: a pre-hire with their start date and where they came from', async () => {
  // What the Joiner flow's Landbright node does (spec 007): POST /api/v1/people with a worker from HiBob.
  const app = await api<{ application: { clientId: string }; clientSecret: string }>('/api/applications', 'POST', {
    name: 'HR flows',
    clientId: `hr-${stack.slug}`,
    redirectUris: ['http://127.0.0.1:9/callback'],
    grantTypes: ['client_credentials'],
    apiScopes: ['directory:read', 'directory:write'],
  });
  const issued = await fetch(`${stack.issuer}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${app.application.clientId}:${app.clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'directory:write' }),
  });
  const { access_token } = (await issued.json()) as { access_token: string };
  const start = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const created = await fetch(`${stack.control}/api/v1/people`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'hibob',
      sourceId: '3332883884017713238',
      email: `noa.barak@${stack.slug}.test`,
      givenName: 'Noa',
      familyName: 'Barak',
      department: 'Engineering',
      title: 'Platform Engineer',
      site: 'Tel Aviv',
      managerEmail: stack.admin.email,
      startDate: start,
    }),
  });
  expect(created.status).toBe(201);
  const { person } = (await created.json()) as { person: { id: string } };
  await page.goto(`${stack.console}/people/${person.id}`);
  await expect(page.getByTestId('pre-hire')).toBeVisible();
  await expect(page.getByTestId('sources')).toContainText('HiBob');
  await shot(page, '90-person-from-hr');
  await page.goto(`${stack.console}/people`);
  await expect(page.getByText('Noa Barak')).toBeVisible();
  await shot(page, '91-people-pre-hire');
});

test('signs out at the identity plane', async () => {
  const { redirect } = await api<{ redirect: string }>('/api/auth/logout', 'POST');
  await page.goto(redirect);
  await expect(page.getByRole('heading', { name: 'Sign out?' })).toBeVisible();
  await shot(page, '25-sign-out');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.goto(stack.console);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
