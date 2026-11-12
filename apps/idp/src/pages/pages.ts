import { html, layout, raw } from './html';

/** A passkey ceremony on a page: where the response goes, and the WebAuthn options for the browser. */
export interface PasskeyForm {
  action: string;
  options: unknown;
}

/**
 * A form the passkey script drives (passkey-script.ts). Hidden until the script shows it, so browsers without the
 * script or without WebAuthn never see a button that can't work.
 */
function passkeyForm(
  kind: 'get' | 'create',
  form: PasskeyForm,
  label: string,
  opts: { primary?: boolean; divider?: boolean } = {},
): string {
  return html`<form
    method="post"
    action="${form.action}"
    class="stack passkey"
    data-passkey="${kind}"
    data-options="${JSON.stringify(form.options)}"
    hidden
  >
    ${opts.divider ? raw('<p class="or">or</p>') : ''}
    <input type="hidden" name="response" />
    <button type="submit" class="${opts.primary ? 'primary' : 'ghost'}">${label}</button>
    <p class="hint center" data-status role="status" aria-live="polite"></p>
  </form>`;
}

export function loginPage(opts: {
  action: string;
  clientName?: string;
  email?: string;
  error?: string;
  abort: string;
  passkey?: PasskeyForm;
}): string {
  return layout(
    'Sign in',
    html`<h1>Sign in</h1>
      <p class="sub">
        ${opts.clientName ? raw(html`to continue to <strong>${opts.clientName}</strong>`) : 'to your organization'}
      </p>
      ${opts.error ? raw(html`<p class="alert" role="alert">${opts.error}</p>`) : ''}
      <form method="post" action="${opts.action}" class="stack">
        <label
          >Email<input type="email" name="email" value="${opts.email ?? ''}" autocomplete="username" required autofocus
        /></label>
        <label>Password<input type="password" name="password" autocomplete="current-password" required /></label>
        <button type="submit" class="primary">Sign in</button>
      </form>
      ${opts.passkey ? raw(passkeyForm('get', opts.passkey, 'Sign in with a passkey', { divider: true })) : ''}
      <p class="aside"><a href="${opts.abort}">Cancel</a></p>`,
    { passkeys: Boolean(opts.passkey) },
  );
}

export function invitePage(opts: { action: string; name: string; email: string; error?: string }): string {
  return layout(
    'Set your password',
    html`<h1>Welcome, ${opts.name}</h1>
      <p class="sub">
        Choose a password for <strong>${opts.email}</strong>. You’ll use it to sign in to your organization’s apps.
      </p>
      ${opts.error ? raw(html`<p class="alert" role="alert">${opts.error}</p>`) : ''}
      <form method="post" action="${opts.action}" class="stack">
        <input type="email" name="username" value="${opts.email}" autocomplete="username" hidden />
        <label
          >Password<input type="password" name="password" autocomplete="new-password" minlength="12" required autofocus
        /></label>
        <label
          >Repeat it<input type="password" name="confirm" autocomplete="new-password" minlength="12" required
        /></label>
        <p class="hint">At least 12 characters. A few unrelated words work well.</p>
        <button type="submit" class="primary">Set password</button>
      </form>`,
  );
}

export function messagePage(title: string, message: string): string {
  return layout(
    title,
    html`<h1>${title}</h1>
      <p class="sub">${message}</p>`,
  );
}

export function errorPage(message: string): string {
  return layout(
    'Something went wrong',
    html`<h1>Something went wrong</h1>
      <p class="alert">${message}</p>
      <p class="sub">Go back to the app you came from and try again.</p>`,
  );
}

/** RP-initiated logout: oidc-provider gives the form (with its xsrf token); the buttons submit it. */
export function logoutPage(form: string, clientName?: string): string {
  return layout(
    'Sign out',
    html`<h1>Sign out?</h1>
      <p class="sub">
        ${clientName ? raw(html`<strong>${clientName}</strong> asked to sign you out of Landbright.`) : 'You’ll be signed out of Landbright.'}
      </p>
      ${raw(form)}
      <div class="row">
        <button type="submit" form="op.logoutForm" name="logout" value="yes" class="primary">Sign out</button>
        <button type="submit" form="op.logoutForm" class="ghost">Stay signed in</button>
      </div>`,
  );
}

export function signedOutPage(clientName?: string): string {
  return messagePage(
    'Signed out',
    clientName ? `You’re signed out of Landbright and ${clientName}.` : 'You’re signed out of Landbright.',
  );
}

/**
 * The second step for someone who has one set up: a code from their authenticator app, their passkey, or either.
 */
export function secondStepPage(opts: {
  totp?: { action: string };
  passkey?: PasskeyForm;
  abort: string;
  email: string;
  error?: string;
}): string {
  const aside = html`<p class="aside">
    Lost your device? Ask an administrator to reset your second step. · <a href="${opts.abort}">Cancel</a>
  </p>`;
  const error = opts.error ? html`<p class="alert" role="alert">${opts.error}</p>` : '';
  if (!opts.totp) {
    return layout(
      'Use your passkey',
      html`<h1>Use your passkey</h1>
        <p class="sub">Confirm it’s you with your passkey for <strong>${opts.email}</strong>.</p>
        ${raw(error)}
        <p class="alert" data-passkey-hint>This browser can’t use passkeys. Try another browser or device.</p>
        ${opts.passkey ? raw(passkeyForm('get', opts.passkey, 'Use your passkey', { primary: true })) : ''}
        ${raw(aside)}`,
      { passkeys: true },
    );
  }
  return layout(
    'Enter your code',
    html`<h1>Enter your code</h1>
      <p class="sub">Open your authenticator app and enter the 6-digit code for <strong>${opts.email}</strong>.</p>
      ${raw(error)}
      <form method="post" action="${opts.totp.action}" class="stack">
        <label
          >Code<input
            type="text"
            name="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxlength="7"
            required
            autofocus
        /></label>
        <button type="submit" class="primary">Continue</button>
      </form>
      ${opts.passkey ? raw(passkeyForm('get', opts.passkey, 'Use your passkey instead', { divider: true })) : ''}
      ${raw(aside)}`,
    { passkeys: Boolean(opts.passkey) },
  );
}

/** Setting up an authenticator app during sign-in: scan, then confirm with a first code. */
export function enrollTotpPage(opts: {
  action: string;
  skip?: string;
  abort: string;
  qr: string;
  secret: string;
  error?: string;
  passkey?: PasskeyForm;
}): string {
  return layout(
    'Add a second step',
    html`<h1>Add a second step</h1>
      <p class="sub">
        ${
          opts.skip
            ? 'Protect your account with an authenticator app: after your password, you’ll enter a code from it.'
            : 'Your organization asks for a code from an authenticator app after your password. Set one up now.'
        }
      </p>
      ${opts.error ? raw(html`<p class="alert" role="alert">${opts.error}</p>`) : ''}
      <div class="qr">
        <img src="${opts.qr}" alt="QR code to scan with your authenticator app" width="168" height="168" />
      </div>
      <p class="hint center">Can’t scan it? Enter this key in the app:</p>
      <p class="key"><code data-secret>${opts.secret}</code></p>
      <form method="post" action="${opts.action}" class="stack">
        <label
          >Code from the app<input
            type="text"
            name="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxlength="7"
            required
            autofocus
        /></label>
        <button type="submit" class="primary">Turn it on</button>
      </form>
      ${opts.passkey ? raw(passkeyForm('create', opts.passkey, 'Use a passkey instead', { divider: true })) : ''}
      ${
        opts.skip
          ? raw(
              html`<form method="post" action="${opts.skip}" class="aside">
                <button type="submit" class="link">Not now</button>
              </form>`,
            )
          : raw(html`<p class="aside"><a href="${opts.abort}">Cancel</a></p>`)
      }`,
    { passkeys: Boolean(opts.passkey) },
  );
}
