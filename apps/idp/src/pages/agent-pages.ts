import { html, layout, raw } from './html';

const alert = (error?: string) => (error ? raw(html`<p class="alert" role="alert">${error}</p>`) : '');

/** oidc-provider hands its device forms as HTML; Landbright renders its own, keeping only the action and the token. */
export function deviceFormParts(form: string): { action: string; xsrf: string } {
  const action = /action="([^"]+)"/.exec(form)?.[1] ?? '/oidc/device';
  const xsrf = /name="xsrf" value="([^"]+)"/.exec(form)?.[1] ?? '';
  return { action: action.replace(/&amp;/g, '&'), xsrf };
}

/** RFC 8628: the person types the code a device (a command-line agent, a TV) shows. */
export function deviceInputPage(opts: { action: string; xsrf: string; code?: string; error?: string }): string {
  return layout(
    'Connect a device',
    html`<h1>Connect a device</h1>
      <p class="sub">Enter the code the device or app shows you.</p>
      ${alert(opts.error)}
      <form method="post" action="${opts.action}" class="stack">
        <input type="hidden" name="xsrf" value="${opts.xsrf}" />
        <label
          >Code<input
            type="text"
            name="user_code"
            value="${opts.code ?? ''}"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            required
            autofocus
        /></label>
        <button type="submit" class="primary">Continue</button>
      </form>`,
  );
}

/** Confirm the code, and say who will act with the person's access. */
export function deviceConfirmPage(opts: {
  action: string;
  xsrf: string;
  userCode: string;
  clientName: string;
  agent?: string;
}): string {
  return layout(
    'Connect a device',
    html`<h1>Connect ${opts.clientName}?</h1>
      <p class="sub">
        Check that the device shows <strong>${opts.userCode}</strong>.
        ${
          opts.agent
            ? raw(html`It is the agent <strong>${opts.agent}</strong>: it will act for you, with your access.`)
            : 'It will sign in as you.'
        }
      </p>
      <form method="post" action="${opts.action}" class="stack">
        <input type="hidden" name="xsrf" value="${opts.xsrf}" />
        <input type="hidden" name="user_code" value="${opts.userCode}" />
        <input type="hidden" name="confirm" value="yes" />
        <button type="submit" class="primary">Connect</button>
      </form>
      <form method="post" action="${opts.action}" class="aside">
        <input type="hidden" name="xsrf" value="${opts.xsrf}" />
        <input type="hidden" name="user_code" value="${opts.userCode}" />
        <input type="hidden" name="abort" value="yes" />
        <button type="submit" class="ghost">This isn’t mine: cancel</button>
      </form>`,
  );
}

export function deviceDonePage(clientName: string): string {
  return layout(
    'Device connected',
    html`<h1>Done</h1>
      <p class="sub">${clientName} is connected. You can go back to it and close this page.</p>`,
  );
}

export interface CibaView {
  agent: string;
  sponsor?: string;
  scope: string[];
  bindingMessage: string | null;
  expiresAt: Date;
  action: string;
  csrf: string;
}

/** A CIBA request: the agent asks the person; the person decides here, signed in. */
export function cibaPage(v: CibaView): string {
  const minutes = Math.max(1, Math.round((v.expiresAt.getTime() - Date.now()) / 60_000));
  return layout(
    'An agent asks you',
    html`<h1>${v.agent} asks to act for you</h1>
      <p class="sub">
        The agent wants a token that says it acts for you${v.scope.length ? `, with: ${v.scope.join(', ')}` : ''}. Only
        approve if you started this.
      </p>
      ${
        v.bindingMessage
          ? raw(
              html`<p class="note">
                The agent shows this code: <strong data-binding>${v.bindingMessage}</strong>. Check it matches.
              </p>`,
            )
          : ''
      }
      ${v.sponsor ? raw(html`<p class="hint">Sponsor: ${v.sponsor}.</p>`) : ''}
      <form method="post" action="${v.action}" class="stack">
        <input type="hidden" name="csrf" value="${v.csrf}" />
        <button type="submit" name="decision" value="approve" class="primary">Approve</button>
        <button type="submit" name="decision" value="deny" class="ghost">Deny</button>
      </form>
      <p class="aside">This request ends in ${minutes} min.</p>`,
  );
}
