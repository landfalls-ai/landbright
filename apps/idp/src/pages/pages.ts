import { html, layout, raw } from './html';

export function loginPage(opts: {
  action: string;
  clientName?: string;
  email?: string;
  error?: string;
  abort: string;
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
      <p class="aside"><a href="${opts.abort}">Cancel</a></p>`,
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
