import { createHash } from 'node:crypto';
import { calculateJwkThumbprint, decodeProtectedHeader, importJWK, type JWK, jwtVerify } from 'jose';

/** How old a DPoP proof may be, and how long its `jti` is remembered against replay. */
const PROOF_WINDOW_SECONDS = 300;

/**
 * Checks a DPoP proof (RFC 9449 §4.3, §7.1) for a request to the machine API with a DPoP-bound access token: a JWT of
 * type `dpop+jwt`, signed by the public key in its header, for this method and URL, recent, carrying the token's hash
 * (`ath`), whose key's thumbprint is the token's `cnf.jkt`. Each proof works once (its `jti`, remembered in this
 * process for the window).
 */
export class DpopVerifier {
  private readonly seen = new Map<string, number>();

  async verify(proof: string, opts: { method: string; url: string; accessToken: string; jkt: string }): Promise<void> {
    const header = decodeProtectedHeader(proof);
    if (header.typ !== 'dpop+jwt') throw new Error('not a DPoP proof');
    const jwk = header.jwk as JWK | undefined;
    if (!jwk || 'd' in jwk) throw new Error('the proof must carry a public key');
    if (!header.alg || header.alg.startsWith('HS') || header.alg === 'none') throw new Error('unsupported alg');
    const { payload } = await jwtVerify(proof, await importJWK(jwk, header.alg), { typ: 'dpop+jwt' });
    if ((await calculateJwkThumbprint(jwk, 'sha256')) !== opts.jkt)
      throw new Error('the proof’s key isn’t the token’s');
    if (payload.htm !== opts.method) throw new Error('htm mismatch');
    if (normalize(String(payload.htu ?? '')) !== normalize(opts.url)) throw new Error('htu mismatch');
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.iat !== 'number' || Math.abs(now - payload.iat) > PROOF_WINDOW_SECONDS)
      throw new Error('the proof is too old');
    const ath = createHash('sha256').update(opts.accessToken).digest('base64url');
    if (payload.ath !== ath) throw new Error('ath mismatch');
    const jti = String(payload.jti ?? '');
    if (!jti) throw new Error('no jti');
    this.forget(now);
    if (this.seen.has(jti)) throw new Error('the proof was used already');
    this.seen.set(jti, now + PROOF_WINDOW_SECONDS);
  }

  private forget(now: number): void {
    for (const [jti, until] of this.seen) if (until < now) this.seen.delete(jti);
  }
}

/** htu is compared without query and fragment (RFC 9449 §4.3). */
function normalize(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '';
  }
}
