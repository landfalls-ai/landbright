import { describe, expect, it } from 'vitest';
import { AccessPolicy, inWindow, RelayDecision, TimeWindow } from '../src';

describe('auto-approve hours', () => {
  // 2026-11-16 is a Monday.
  const at = (iso: string) => new Date(iso);
  const business = TimeWindow.parse({ timeZone: 'Asia/Jerusalem' }); // Mon–Fri 09:00–18:00

  it('is inside on a weekday during the hours, in the window’s time zone', () => {
    expect(inWindow(business, at('2026-11-16T08:00:00Z'))).toBe(true); // 10:00 in Jerusalem
    expect(inWindow(business, at('2026-11-16T06:30:00Z'))).toBe(false); // 08:30
    expect(inWindow(business, at('2026-11-16T16:00:00Z'))).toBe(false); // 18:00, the end is open
    expect(inWindow(business, at('2026-11-15T08:00:00Z'))).toBe(false); // Sunday
  });

  it('spans midnight when `to` is before `from` (the morning belongs to the day before)', () => {
    const night = TimeWindow.parse({ days: [5], from: '22:00', to: '06:00' }); // Friday night, UTC
    expect(inWindow(night, at('2026-11-20T23:00:00Z'))).toBe(true); // Friday 23:00
    expect(inWindow(night, at('2026-11-21T05:00:00Z'))).toBe(true); // Saturday 05:00, Friday's night
    expect(inWindow(night, at('2026-11-21T23:00:00Z'))).toBe(false); // Saturday night
  });

  it('is the whole day when `from` equals `to`', () => {
    expect(inWindow(TimeWindow.parse({ days: [1], from: '00:00', to: '00:00' }), at('2026-11-16T23:59:00Z'))).toBe(
      true,
    );
  });

  it('refuses a time zone that doesn’t exist', () => {
    expect(TimeWindow.safeParse({ timeZone: 'Mars/Olympus' }).success).toBe(false);
  });
});

describe('the access policy', () => {
  it('lets a step allow relayed votes only when asked, and extensions twice by default', () => {
    const policy = AccessPolicy.parse({});
    expect(policy.steps[0]!.allowRelayed).toBe(false);
    expect(policy.extensions).toEqual({ allowed: true, maxCount: 2 });
  });

  it('takes relayed votes only from a chat channel', () => {
    const ticket = 'x'.repeat(40);
    expect(RelayDecision.safeParse({ ticket, outcome: 'approve', channel: 'chat:slack' }).success).toBe(true);
    expect(RelayDecision.safeParse({ ticket, outcome: 'approve', channel: 'landbright' }).success).toBe(false);
  });
});

describe('update schemas', () => {
  it('leave out what a PATCH doesn’t name, instead of resetting it to a default', async () => {
    const { UpdateAgent, UpdateApplication, UpdateBundle } = await import('../src');
    expect(UpdateBundle.parse({ disabled: true })).toEqual({ disabled: true });
    expect(UpdateApplication.parse({ name: 'Landflow' })).toEqual({ name: 'Landflow' });
    expect(UpdateAgent.parse({ displayName: 'Bot' })).toEqual({ displayName: 'Bot' });
    // What is named still validates.
    expect(UpdateBundle.safeParse({ groupIds: ['not-a-uuid'] }).success).toBe(false);
  });
});
