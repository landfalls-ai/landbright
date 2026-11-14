import { describe, expect, it } from 'vitest';
import { clientSecret, newToken, seal, sha256, unseal } from '../src/crypto';

const key = 'k'.repeat(40);

describe('seal', () => {
  it('round-trips', () => {
    expect(unseal(key, seal(key, 'private jwk'))).toBe('private jwk');
  });
  it('uses a fresh IV each time', () => {
    expect(seal(key, 'x')).not.toBe(seal(key, 'x'));
  });
  it('refuses another key and tampering', () => {
    const sealed = seal(key, 'secret');
    expect(() => unseal('j'.repeat(40), sealed)).toThrow();
    const parts = sealed.split('.');
    parts[3] = Buffer.from('other').toString('base64url');
    expect(() => unseal(key, parts.join('.'))).toThrow();
  });
});

describe('clientSecret', () => {
  it('is stable for a client and version, and changes on rotation', () => {
    expect(clientSecret(key, 'landflow', 1)).toBe(clientSecret(key, 'landflow', 1));
    expect(clientSecret(key, 'landflow', 2)).not.toBe(clientSecret(key, 'landflow', 1));
    expect(clientSecret(key, 'landfall', 1)).not.toBe(clientSecret(key, 'landflow', 1));
  });
});

describe('newToken', () => {
  it('returns the token and the hash to store', () => {
    const { token, hash } = newToken();
    expect(sha256(token)).toBe(hash);
    expect(token.length).toBeGreaterThan(40);
  });
});
