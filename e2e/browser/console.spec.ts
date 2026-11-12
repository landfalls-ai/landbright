import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { type BrowserContext, expect, type Locator, type Page, test } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { LandflowLikeRp } from '../test/landflow-rp';
import { MAILPIT, type Stack, startStack } from '../test/stack';

/**
 * The console and the sign-in pages in real Chromium, as one story: an administrator signs in and builds the
 * directory through the console; Maya sets her password from the invite, adds a passkey (Chrome's virtual
 * authenticator, so the page's own script runs the ceremony) and signs in to a Landflow-shaped app with it; Noa sets
 * up an authenticator app; the console then shows what happened. Each screen is captured on the way.
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

  await page.getByRole('link', { name: /^Requests/ }).click();
  await shot(page, '24-upcoming-requests');

  await page.getByRole('radio', { name: 'Dark' }).click();
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await expect(page.getByText(`noa@${stack.slug}.test`)).toBeVisible();
  // Reaching the theme switch scrolled the sidebar; back to the top for the picture.
  await page.evaluate('for (const el of document.querySelectorAll("*")) el.scrollTop = 0');
  await shot(page, '26-people-dark');
  await page.getByRole('radio', { name: 'System' }).click();
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
