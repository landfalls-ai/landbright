import { describe, expect, it } from 'vitest';
import { rotateAfter, RotationTooSoon } from '../src/signing-keys';

const at = (iso: string) => ({ createdAt: new Date(iso) });
const now = new Date('2026-11-12T12:00:00Z');

describe('when the signing keys may rotate', () => {
  it('rotates at once with one key or none: nothing would be retired', () => {
    expect(rotateAfter([], 3600, now)).toBeNull();
    expect(rotateAfter([at('2026-11-12T11:59:00Z')], 3600, now)).toBeNull();
  });

  it('waits while the replaced key could still have live ID tokens', () => {
    // The current key took over at 11:30, so the previous one signed its last token then; it lives until 12:30.
    const keys = [at('2026-11-12T09:00:00Z'), at('2026-11-12T11:30:00Z')];
    expect(rotateAfter(keys, 3600, now)?.toISOString()).toBe('2026-11-12T12:30:00.000Z');
  });

  it('rotates once those tokens have expired, whatever order the keys come in', () => {
    const keys = [at('2026-11-12T10:30:00Z'), at('2026-11-12T08:00:00Z')];
    expect(rotateAfter(keys, 3600, now)).toBeNull();
  });

  it('says when, in the refusal', () => {
    expect(new RotationTooSoon(new Date('2026-11-12T12:30:00Z')).message).toContain('2026-11-12T12:30:00.000Z');
  });
});
