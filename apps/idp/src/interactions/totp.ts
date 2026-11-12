import { Secret, TOTP } from 'otpauth';
import QRCode from 'qrcode';

/** RFC 6238 with the settings every authenticator app supports: SHA-1, 6 digits, 30 seconds. */
const PERIOD = 30;

function totp(secret: string, label = 'Landbright', issuer = 'Landbright'): TOTP {
  return new TOTP({ issuer, label, algorithm: 'SHA1', digits: 6, period: PERIOD, secret: Secret.fromBase32(secret) });
}

/** A new seed, base32 (what authenticator apps take when typed in). 160 bits, as RFC 4226 recommends. */
export function newTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

/**
 * Checks a code, allowing one step of clock drift either way. Returns the time step it matched, which must be later
 * than `lastStep` (the last one accepted), so a code works once; undefined when it doesn't match or was used.
 */
export function checkTotp(secret: string, code: string, lastStep: bigint, now = Date.now()): bigint | undefined {
  const token = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(token)) return undefined;
  const delta = totp(secret).validate({ token, timestamp: now, window: 1 });
  if (delta === null) return undefined;
  const step = BigInt(Math.floor(now / 1000 / PERIOD) + delta);
  return step > lastStep ? step : undefined;
}

/** The QR code an authenticator app scans: an `otpauth://` URI as a PNG data URL (the CSP allows `data:` images). */
export function totpQrCode(secret: string, account: string, issuer: string): Promise<string> {
  return QRCode.toDataURL(totp(secret, account, issuer).toString(), { margin: 1, width: 200 });
}

/** The seed in groups of four, for typing in by hand. */
export const groupSecret = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();
