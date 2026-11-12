import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';

/**
 * A software passkey authenticator: what a browser and a platform authenticator do for
 * `navigator.credentials.create` and `.get`, with a P-256 key, `none` attestation and user verification. It answers
 * with the same JSON the sign-in pages' script posts (base64url fields), so the identity plane can't tell the
 * difference.
 */
export class SoftAuthenticator {
  private readonly credentials: Array<{
    id: Buffer;
    rpId: string;
    userHandle: Buffer;
    key: KeyObject;
    counter: number;
  }> = [];

  constructor(private readonly origin: string) {}

  /** `navigator.credentials.create` with the options the page carries. */
  create(options: CreationOptions, opts: { origin?: string; userVerified?: boolean } = {}) {
    const rpId = options.rp.id ?? new URL(this.origin).hostname;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const id = randomBytes(16);
    const cose = cbor(
      new Map<number, number | Buffer>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
    const length = Buffer.alloc(2);
    length.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([0x01 | (opts.userVerified === false ? 0 : 0x04) | 0x40]), // UP, UV, AT
      Buffer.alloc(4), // sign counter 0
      Buffer.alloc(16), // AAGUID
      length,
      id,
      cose,
    ]);
    const clientDataJSON = this.clientData('webauthn.create', options.challenge, opts.origin);
    this.credentials.push({
      id,
      rpId,
      userHandle: Buffer.from(options.user.id, 'base64url'),
      key: privateKey,
      counter: 0,
    });
    return {
      id: id.toString('base64url'),
      rawId: id.toString('base64url'),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: cbor(
          new Map<string, unknown>([
            ['fmt', 'none'],
            ['attStmt', new Map()],
            ['authData', authData],
          ]),
        ).toString('base64url'),
        transports: ['internal'],
      },
    };
  }

  /**
   * `navigator.credentials.get`: one of `allowCredentials` if the page names any, else any passkey this authenticator
   * holds for the site (a discoverable credential).
   */
  get(options: RequestOptions, opts: { origin?: string; userVerified?: boolean } = {}) {
    const rpId = options.rpId ?? new URL(this.origin).hostname;
    const allowed = (options.allowCredentials ?? []).map((c) => c.id);
    const credential = this.credentials.find(
      (c) => c.rpId === rpId && (allowed.length === 0 || allowed.includes(c.id.toString('base64url'))),
    );
    if (!credential) throw new Error('NotAllowedError: no passkey for this site');
    credential.counter += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(credential.counter);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([0x01 | (opts.userVerified === false ? 0 : 0x04)]),
      counter,
    ]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, opts.origin);
    return {
      id: credential.id.toString('base64url'),
      rawId: credential.id.toString('base64url'),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        // ECDSA over authenticatorData ‖ SHA-256(clientDataJSON), DER-encoded as WebAuthn expects.
        signature: sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), credential.key).toString(
          'base64url',
        ),
        userHandle: credential.userHandle.toString('base64url'),
      },
    };
  }

  private clientData(type: string, challenge: string, origin = this.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }
}

export interface CreationOptions {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  authenticatorSelection?: { residentKey?: string; userVerification?: string };
  excludeCredentials?: Array<{ id: string }>;
}

export interface RequestOptions {
  challenge: string;
  rpId?: string;
  userVerification?: string;
  allowCredentials?: Array<{ id: string }>;
}

/** The `[data-passkey]` form on a sign-in page: where it posts, and its WebAuthn options. */
export function passkeyForm<T>(html: string, kind: 'get' | 'create'): { action: string; options: T } | undefined {
  const tag = new RegExp(`<form[^>]*data-passkey="${kind}"[^>]*>`).exec(html)?.[0];
  if (!tag) return undefined;
  const attribute = (name: string) => unescapeHtml(new RegExp(`${name}="([^"]*)"`).exec(tag)![1]!);
  return { action: attribute('action'), options: JSON.parse(attribute('data-options')) as T };
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest();

/** Just enough CBOR (RFC 8949) for attestation objects and COSE keys: integers, strings, bytes, maps. */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
    if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map)
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error(`cbor: can't encode ${typeof value}`);
}
