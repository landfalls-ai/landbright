import { ACR_LABELS, type Acr } from '@landbright/contracts';
import { html, layout, raw } from './html';
import { passkeyForm, type PasskeyForm } from './pages';

const when = (d: Date | null | undefined) =>
  d
    ? d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';

const alert = (error?: string) => (error ? raw(html`<p class="alert" role="alert">${error}</p>`) : '');
const ok = (message?: string) => (message ? raw(html`<p class="ok" role="status">${message}</p>`) : '');

/** Forgot password: an email address, and the same answer whether or not it is someone's. */
export function forgotPage(opts: { action: string; back: string; email?: string; error?: string; sent?: boolean }) {
  if (opts.sent)
    return layout(
      'Check your email',
      html`<h1>Check your email</h1>
        <p class="sub">
          If <strong>${opts.email ?? ''}</strong> belongs to someone in your organization, a link to choose a new
          password is on its way. It works once, for 30 minutes.
        </p>
        <p class="aside"><a href="${opts.back}">Back to sign in</a></p>`,
    );
  return layout(
    'Forgot your password',
    html`<h1>Forgot your password?</h1>
      <p class="sub">Enter your work email. We’ll send you a link to choose a new one.</p>
      ${alert(opts.error)}
      <form method="post" action="${opts.action}" class="stack">
        <label
          >Email<input type="email" name="email" value="${opts.email ?? ''}" autocomplete="username" required autofocus
        /></label>
        <button type="submit" class="primary">Send the link</button>
      </form>
      <p class="aside"><a href="${opts.back}">Back to sign in</a></p>`,
  );
}

/** The accept_terms required action. */
export function termsPage(opts: {
  action: string;
  tenantName: string;
  termsUrl?: string;
  abort: string;
  error?: string;
}) {
  return layout(
    'Accept the terms',
    html`<h1>Before you continue</h1>
      <p class="sub">
        ${opts.tenantName} asks you to accept its terms of use for the apps you sign in to with Landbright.
        ${opts.termsUrl ? raw(html`<a href="${opts.termsUrl}" target="_blank" rel="noopener">Read the terms</a>.`) : ''}
      </p>
      ${alert(opts.error)}
      <form method="post" action="${opts.action}" class="stack">
        <label class="check"><input type="checkbox" name="accept" value="yes" required /> I accept the terms</label>
        <button type="submit" class="primary">Continue</button>
      </form>
      <p class="aside"><a href="${opts.abort}">Cancel</a></p>`,
  );
}

export interface AccountView {
  name: string;
  email: string;
  tenantName: string;
  groups: Array<{ name: string; until: Date | null }>;
  csrf: string;
  flash?: { ok?: string; error?: string };
  password: { set: boolean; since?: Date };
  totp?: { id: string; createdAt: Date; lastUsedAt: Date | null };
  passkeys: Array<{ id: string; label: string | null; createdAt: Date; lastUsedAt: Date | null }>;
  /** Present when this browser can add a passkey here (passkeys are on). */
  addPasskey?: PasskeyForm;
  /** Passkeys are on but the sign-in isn't recent: a link to confirm it's them first. */
  confirmFirst?: string;
  recoveryCodes: number;
  mfaRequired: boolean;
  sessions: Array<{ id: string; signedInAt: Date; acr: string | null; apps: string[]; current: boolean }>;
  signOut: string;
}

/** The account page: profile, password, second steps, recovery codes, sessions. */
export function accountPage(v: AccountView): string {
  const csrf = raw(html`<input type="hidden" name="csrf" value="${v.csrf}" />`);
  const secondSteps = (v.totp ? 1 : 0) + v.passkeys.length;
  const canRemove = !v.mfaRequired || secondSteps > 1;
  const remove = (id: string, label: string) =>
    canRemove
      ? raw(
          html`<form method="post" action="/account/credentials/${id}/remove">
            ${csrf}<button type="submit" class="ghost" aria-label="Remove ${label}">Remove</button>
          </form>`,
        )
      : raw(html`<span class="tag" title="Your organization requires a second step">Required</span>`);
  return layout(
    'Your account',
    html`<div class="top">
        <h1>${v.name}</h1>
        <a href="${v.signOut}">Sign out</a>
      </div>
      <p class="sub">${v.email} · ${v.tenantName}</p>
      ${ok(v.flash?.ok)} ${alert(v.flash?.error)}
      ${
        v.groups.length
          ? raw(
              html`<p class="hint">
                Groups: ${v.groups.map((g) => (g.until ? `${g.name} (until ${when(g.until)})` : g.name)).join(', ')}
              </p>`,
            )
          : ''
      }

      <section class="section" aria-labelledby="password">
        <h2 id="password">Password</h2>
        <form method="post" action="/account/password" class="stack">
          ${csrf}
          <input type="email" name="username" value="${v.email}" autocomplete="username" hidden />
          <label
            >Current password<input type="password" name="current" autocomplete="current-password" required
          /></label>
          <label
            >New password<input type="password" name="password" autocomplete="new-password" minlength="12" required
          /></label>
          <label
            >Repeat it<input type="password" name="confirm" autocomplete="new-password" minlength="12" required
          /></label>
          <button type="submit" class="ghost">Change password</button>
        </form>
      </section>

      <section class="section" aria-labelledby="second-step">
        <h2 id="second-step">Second step</h2>
        <ul class="items">
          ${
            v.totp
              ? raw(
                  html`<li>
                    <span class="what"
                      ><strong>Authenticator app</strong
                      ><span class="meta"
                        >Added
                        ${when(v.totp.createdAt)}${v.totp.lastUsedAt ? ` · used ${when(v.totp.lastUsedAt)}` : ''}</span
                      ></span
                    >${remove(v.totp.id, 'the authenticator app')}
                  </li>`,
                )
              : ''
          }
          ${v.passkeys.map((p) =>
            raw(
              html`<li>
                <span class="what"
                  ><strong>${p.label ?? 'Passkey'}</strong
                  ><span class="meta"
                    >Passkey · added ${when(p.createdAt)}${p.lastUsedAt ? ` · used ${when(p.lastUsedAt)}` : ''}</span
                  ></span
                >${remove(p.id, p.label ?? 'this passkey')}
              </li>`,
            ),
          )}
        </ul>
        ${secondSteps === 0 ? raw(html`<p class="hint">None yet: your password alone signs you in.</p>`) : ''}
        <div class="actions">
          ${v.totp ? '' : raw(html`<a class="tag" href="/account/totp">Add an authenticator app</a>`)}
          ${v.confirmFirst ? raw(html`<a class="tag" href="${v.confirmFirst}">Add a passkey</a>`) : ''}
        </div>
        ${v.addPasskey ? raw(passkeyForm('create', v.addPasskey, 'Add a passkey')) : ''}
      </section>

      <section class="section" aria-labelledby="recovery">
        <h2 id="recovery">Recovery codes</h2>
        <p class="hint">
          ${
            secondSteps === 0
              ? 'Add a second step first: recovery codes stand in for it when you lose your device.'
              : v.recoveryCodes
                ? `${v.recoveryCodes} unused. Each works once instead of your second step.`
                : 'None yet. Each code works once instead of your second step, if you lose your device.'
          }
        </p>
        ${
          secondSteps
            ? raw(
                html`<form method="post" action="/account/recovery-codes" class="actions pad">
                  ${csrf}<button type="submit" class="ghost">
                    ${v.recoveryCodes ? 'Replace them with new codes' : 'Create recovery codes'}
                  </button>
                </form>`,
              )
            : ''
        }
      </section>

      <section class="section" aria-labelledby="sessions">
        <h2 id="sessions">Where you’re signed in</h2>
        <ul class="items">
          ${v.sessions.map((s) =>
            raw(
              html`<li>
                <span class="what"
                  ><strong>${s.current ? 'This browser' : 'Another browser'}</strong
                  ><span class="meta"
                    >Since
                    ${when(s.signedInAt)}${s.acr ? ` · ${ACR_LABELS[s.acr as Acr] ?? s.acr}` : ''}${
                      s.apps.length ? ` · ${s.apps.join(', ')}` : ''
                    }</span
                  ></span
                >${s.current ? raw(html`<span class="tag">Current</span>`) : ''}
              </li>`,
            ),
          )}
        </ul>
        ${
          v.sessions.some((s) => !s.current)
            ? raw(
                html`<form method="post" action="/account/sessions/end-others" class="actions">
                  ${csrf}<button type="submit" class="ghost">Sign out everywhere else</button>
                </form>`,
              )
            : ''
        }
      </section>`,
    { passkeys: Boolean(v.addPasskey), wide: true },
  );
}

/** New recovery codes, shown once. */
export function recoveryCodesPage(codes: string[]): string {
  return layout(
    'Your recovery codes',
    html`<h1>Your recovery codes</h1>
      <p class="sub">
        Keep them somewhere safe, away from your phone. Each works once instead of your second step. This is the only
        time they are shown; your earlier codes no longer work.
      </p>
      <div class="codes" data-codes>${codes.map((c) => raw(html`<code>${c}</code>`))}</div>
      <p class="aside"><a href="/account">I’ve saved them</a></p>`,
  );
}
