import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Secrets derived from LANDBRIGHT_SECRET_KEY. Each use gets its own key (HKDF with a purpose label), so a key
 * leaked from one use says nothing about another.
 */
export function deriveKey(secretKey: string, purpose: string, length = 32): Buffer {
  return Buffer.from(hkdfSync('sha256', secretKey, 'landbright', purpose, length));
}

/** AES-256-GCM: `v1.<iv>.<tag>.<ciphertext>`, base64url. For signing keys and other secrets at rest. */
export function seal(secretKey: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secretKey, 'seal'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ciphertext]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function unseal(secretKey: string, sealed: string): string {
  const [version, iv, tag, ciphertext] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || ciphertext === undefined) throw new Error('not a sealed value');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secretKey, 'seal'), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * An OIDC client's secret: never stored, derived from the client id and its secret version. Rotating bumps the
 * version, which changes the secret.
 */
export function clientSecret(secretKey: string, clientId: string, version: number): string {
  return createHmac('sha256', deriveKey(secretKey, 'client-secret'))
    .update(`${clientId}:${version}`)
    .digest('base64url');
}

/** A random token for a link (invite, reset), and the hash that is stored instead of it. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
