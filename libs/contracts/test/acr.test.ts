import { describe, expect, it } from 'vitest';
import { acrLevel, acrOf, neededAcr } from '../src/acr';

describe('acr', () => {
  it('follows from amr: a passkey is phr, two factors mfa, else pwd', () => {
    expect(acrOf(['pwd'])).toBe('urn:landbright:acr:pwd');
    expect(acrOf(['pwd', 'otp', 'mfa'])).toBe('urn:landbright:acr:mfa');
    expect(acrOf(['pop', 'mfa'])).toBe('urn:landbright:acr:phr');
    expect(acrOf(['pwd', 'pop', 'mfa'])).toBe('urn:landbright:acr:phr');
  });

  it('orders the levels, and anything unknown is none', () => {
    expect(acrLevel('urn:landbright:acr:pwd')).toBe(1);
    expect(acrLevel('urn:landbright:acr:phr')).toBe(3);
    expect(acrLevel('urn:other:loa:2')).toBe(0);
    expect(acrLevel(undefined)).toBe(0);
  });

  it('needs the application minimum, raised by the weakest acr_values Landbright knows', () => {
    expect(neededAcr(null, undefined)).toBeUndefined();
    expect(neededAcr('urn:landbright:acr:mfa', undefined)).toBe('urn:landbright:acr:mfa');
    expect(neededAcr(null, 'urn:landbright:acr:phr')).toBe('urn:landbright:acr:phr');
    expect(neededAcr(null, 'urn:landbright:acr:phr urn:landbright:acr:mfa')).toBe('urn:landbright:acr:mfa');
    expect(neededAcr('urn:landbright:acr:mfa', 'urn:landbright:acr:pwd')).toBe('urn:landbright:acr:mfa');
    expect(neededAcr(null, 'urn:other:loa:2')).toBeUndefined();
  });
});
