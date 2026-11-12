import { Secret, TOTP } from 'otpauth';
import { describe, expect, it } from 'vitest';
import { enrollTotpPage, totpPage } from '../src/pages/pages';
import { checkTotp, groupSecret, newTotpSecret, totpQrCode } from '../src/interactions/totp';

const codeAt = (secret: string, ms: number) =>
  new TOTP({ secret: Secret.fromBase32(secret) }).generate({ timestamp: ms });

describe('TOTP', () => {
  const secret = newTotpSecret();
  const now = 1_800_000_000_000;
  const step = BigInt(Math.floor(now / 30_000));

  it('makes 160-bit base32 seeds', () => {
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(newTotpSecret()).not.toBe(secret);
  });

  it('accepts the current code and returns its step', () => {
    expect(checkTotp(secret, codeAt(secret, now), 0n, now)).toBe(step);
  });

  it('allows one step of clock drift, not two', () => {
    expect(checkTotp(secret, codeAt(secret, now - 30_000), 0n, now)).toBe(step - 1n);
    expect(checkTotp(secret, codeAt(secret, now + 30_000), 0n, now)).toBe(step + 1n);
    expect(checkTotp(secret, codeAt(secret, now - 90_000), 0n, now)).toBeUndefined();
  });

  it('accepts a code once: not again, and not an older one', () => {
    expect(checkTotp(secret, codeAt(secret, now), step, now)).toBeUndefined();
    expect(checkTotp(secret, codeAt(secret, now - 30_000), step, now)).toBeUndefined();
  });

  it('ignores spaces and refuses anything but six digits', () => {
    const code = codeAt(secret, now);
    expect(checkTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, 0n, now)).toBe(step);
    expect(checkTotp(secret, 'abcdef', 0n, now)).toBeUndefined();
    expect(checkTotp(secret, '12345', 0n, now)).toBeUndefined();
  });

  it('draws a QR code as a PNG data URL and groups the key for typing', async () => {
    expect(await totpQrCode(secret, 'maya@example.test', 'Landbright')).toMatch(/^data:image\/png;base64,/);
    expect(groupSecret('ABCDEFGHIJKL')).toBe('ABCD EFGH IJKL');
  });
});

describe('second-step pages', () => {
  it('asks for a code, escaping the email', () => {
    const page = totpPage({ action: '/interaction/u/totp', abort: '/interaction/u/abort', email: '<b>@x' });
    expect(page).toContain('autocomplete="one-time-code"');
    expect(page).not.toContain('<b>@x');
  });

  it('offers "Not now" only when the second step is optional', () => {
    const base = { action: '/a', abort: '/b', qr: 'data:image/png;base64,AA', secret: 'ABCD EFGH' };
    expect(enrollTotpPage({ ...base, skip: '/s' })).toContain('Not now');
    expect(enrollTotpPage(base)).not.toContain('Not now');
    expect(enrollTotpPage(base)).toContain('Your organization asks');
  });
});
