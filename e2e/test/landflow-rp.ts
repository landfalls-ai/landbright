import { createHash, createPublicKey, type JsonWebKey, randomBytes, verify } from 'node:crypto';

/**
 * A relying party that signs in the way Landflow does (apps/web/src/lib/server/auth/oidc.ts in the landflow
 * repository): discovery at `<issuer>/.well-known/openid-configuration`, authorization code with PKCE (S256) and a
 * nonce, the token request with HTTP Basic client authentication *and* client_id in the body, the ID token verified
 * against the JWKS, and the role taken from the `roles` claim through LANDFLOW_OIDC_ROLE_MAP. Landflow is not
 * imported; this copies its wire behaviour so a change on either side shows up here.
 */
export interface RpConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** LANDFLOW_OIDC_SCOPES; Landflow's default is `openid email profile`, and roles need `roles` too. */
  scopes: string;
  /** LANDFLOW_OIDC_ROLE_MAP, parsed: claim value → Landflow role. */
  roleMap: Record<string, 'admin' | 'member'>;
}

type Claims = Record<string, unknown> & {
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
  nonce?: string;
};

const b64url = (b: Buffer) => b.toString('base64url');

export class LandflowLikeRp {
  private pending?: { state: string; nonce: string; verifier: string };

  constructor(readonly config: RpConfig) {}

  async discovery(): Promise<Record<string, string & string[]>> {
    return (await fetch(`${this.config.issuer}/.well-known/openid-configuration`)).json() as Promise<
      Record<string, string & string[]>
    >;
  }

  /** `extra` adds parameters Landflow doesn't send (prompt, other scopes), for cases beyond its own flow. */
  async authorizationUrl(extra: Record<string, string> = {}): Promise<string> {
    const d = await this.discovery();
    const verifier = b64url(randomBytes(32));
    this.pending = { state: b64url(randomBytes(16)), nonce: b64url(randomBytes(16)), verifier };
    const url = new URL(d.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', this.config.scopes);
    url.searchParams.set('state', this.pending.state);
    url.searchParams.set('nonce', this.pending.nonce);
    url.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
    url.searchParams.set('code_challenge_method', 'S256');
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
    return url.href;
  }

  /** Landflow's completeLogin: exchange, verify, then the role it would assign. */
  async complete(callback: string): Promise<{
    claims: Claims;
    role: 'admin' | 'member' | undefined;
    accessToken: string;
    idToken: string;
    refreshToken?: string;
  }> {
    const url = new URL(callback);
    const pending = this.pending!;
    if (url.searchParams.get('state') !== pending.state) throw new Error(`state mismatch: ${callback}`);
    const code = url.searchParams.get('code');
    if (!code) throw new Error(`no code: ${callback}`);
    const d = await this.discovery();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: pending.verifier,
      client_id: this.config.clientId,
    });
    const basic = Buffer.from(
      `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`,
    ).toString('base64');
    const response = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` },
      body,
    });
    const tokens = (await response.json()) as {
      id_token?: string;
      access_token?: string;
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!response.ok || !tokens.id_token)
      throw new Error(`token request failed: ${response.status} ${JSON.stringify(tokens)}`);
    const claims = await this.verifyIdToken(tokens.id_token, d.jwks_uri, pending.nonce);
    return {
      claims,
      role: this.mappedRole(claims),
      accessToken: tokens.access_token!,
      idToken: tokens.id_token,
      refreshToken: tokens.refresh_token,
    };
  }

  /** Landflow's mappedRole: the highest role any `roles` value maps to. */
  mappedRole(claims: Claims): 'admin' | 'member' | undefined {
    const raw = claims.roles;
    const values = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : []).map(String);
    const roles = values.map((v) => this.config.roleMap[v]).filter(Boolean);
    return roles.includes('admin') ? 'admin' : roles.includes('member') ? 'member' : undefined;
  }

  /** What Landflow checks: the signature against the issuer's JWKS (by `kid`), then iss, aud, exp and nonce. */
  async verifyIdToken(token: string, jwksUri: string, nonce: string): Promise<Claims> {
    const [h, p, s] = token.split('.') as [string, string, string];
    const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg: string; kid: string };
    if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);
    const { keys } = (await (await fetch(jwksUri)).json()) as { keys: Array<JsonWebKey & { kid: string }> };
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) throw new Error(`no key ${header.kid}`);
    if (
      !verify(
        'RSA-SHA256',
        Buffer.from(`${h}.${p}`),
        createPublicKey({ key: jwk, format: 'jwk' }),
        Buffer.from(s, 'base64url'),
      )
    )
      throw new Error('bad signature');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Claims;
    if (claims.iss !== this.config.issuer) throw new Error(`iss ${claims.iss}`);
    if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(this.config.clientId)) throw new Error('aud');
    if (claims.exp * 1000 < Date.now()) throw new Error('expired');
    if (claims.nonce !== nonce) throw new Error('nonce');
    return claims;
  }
}
