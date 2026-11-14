import { createHash } from 'node:crypto';

/**
 * The only script on the sign-in pages, for passkeys. Each `form[data-passkey]` carries the WebAuthn options (JSON in
 * `data-options`, from @simplewebauthn/server); on submit the script runs the ceremony, puts the authenticator's
 * response (JSON, base64url fields) in the form's `response` field and submits it. The forms start hidden, so a
 * browser without the script or without WebAuthn shows the password path only.
 */
export const PASSKEY_SCRIPT = `(() => {
  'use strict';
  if (!window.PublicKeyCredential || !navigator.credentials) return;
  const bytes = (text) => {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  };
  const text = (buffer) => {
    let binary = '';
    for (const b of new Uint8Array(buffer)) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  };
  const descriptors = (list) => (list || []).map((c) => ({ ...c, id: bytes(c.id) }));
  const common = (credential) => ({
    id: credential.id,
    rawId: text(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
  });
  async function create(o) {
    const credential = await navigator.credentials.create({
      publicKey: { ...o, challenge: bytes(o.challenge), user: { ...o.user, id: bytes(o.user.id) }, excludeCredentials: descriptors(o.excludeCredentials) },
    });
    const r = credential.response;
    return { ...common(credential), response: { clientDataJSON: text(r.clientDataJSON), attestationObject: text(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] } };
  }
  async function get(o) {
    const credential = await navigator.credentials.get({
      publicKey: { ...o, challenge: bytes(o.challenge), allowCredentials: descriptors(o.allowCredentials) },
    });
    const r = credential.response;
    return {
      ...common(credential),
      response: { clientDataJSON: text(r.clientDataJSON), authenticatorData: text(r.authenticatorData), signature: text(r.signature), userHandle: r.userHandle ? text(r.userHandle) : undefined },
    };
  }
  for (const form of document.querySelectorAll('form[data-passkey]')) {
    const status = form.querySelector('[data-status]');
    const button = form.querySelector('button');
    for (const el of document.querySelectorAll('[data-passkey-hint]')) el.hidden = true;
    form.hidden = false;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true;
      if (status) status.textContent = '';
      try {
        const options = JSON.parse(form.dataset.options);
        const result = form.dataset.passkey === 'create' ? await create(options) : await get(options);
        form.elements.namedItem('response').value = JSON.stringify(result);
        form.submit();
      } catch (error) {
        button.disabled = false;
        if (status)
          status.textContent =
            error && error.name === 'NotAllowedError'
              ? 'Cancelled, or there’s no passkey for this site here.'
              : 'That didn’t work. Try again.';
      }
    });
  }
})();
`;

export const PASSKEY_SCRIPT_HREF = `/assets/passkey.js?v=${createHash('sha256').update(PASSKEY_SCRIPT).digest('hex').slice(0, 12)}`;
