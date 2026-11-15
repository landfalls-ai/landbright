import { describe, expect, it } from 'vitest';
import { PeopleSettings } from '@landbright/contracts';
import { addDays, localDate, todayIn, zonesOf } from '../src/directory/zones';

/** Start and last days are dates in the person's zone (spec 007, slice 2). */
describe('zones', () => {
  // 2026-11-15 22:30 UTC: already the 16th in Tel Aviv (UTC+2) and Kiritimati (UTC+14), still the 15th in London and
  // Pago Pago (UTC-11).
  const now = new Date('2026-11-15T22:30:00Z');
  const zones = zonesOf({
    timeZone: 'Europe/London',
    siteTimeZones: {
      'Tel Aviv': 'Asia/Jerusalem',
      Kiritimati: 'Pacific/Kiritimati',
      'Pago Pago': 'Pacific/Pago_Pago',
      bad: 7,
    },
  });

  it('reads the date where the person is: their site, else the default', () => {
    expect(localDate(now, 'UTC')).toBe('2026-11-15');
    expect(todayIn(zones, 'Tel Aviv', now)).toBe('2026-11-16');
    expect(todayIn(zones, 'Kiritimati', now)).toBe('2026-11-16');
    expect(todayIn(zones, 'Pago Pago', now)).toBe('2026-11-15');
    expect(todayIn(zones, 'Somewhere new', now)).toBe('2026-11-15');
    expect(todayIn(zones, null, now)).toBe('2026-11-15');
    // A site value that isn't a zone name is dropped.
    expect(zones.sites).not.toHaveProperty('bad');
  });

  it('never is more than a day ahead of UTC, nor a day behind (what the worker relies on)', () => {
    for (const hour of [0, 6, 11, 12, 18, 23]) {
      const at = new Date(`2026-11-15T${String(hour).padStart(2, '0')}:59:00Z`);
      expect(localDate(at, 'Pacific/Kiritimati') <= addDays('2026-11-15', 1)).toBe(true);
      expect(localDate(at, 'Pacific/Pago_Pago') >= addDays('2026-11-15', -1)).toBe(true);
    }
  });

  it('adds days across months and years', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('takes only IANA zones in the settings', () => {
    expect(
      PeopleSettings.safeParse({ timeZone: 'Asia/Jerusalem', siteTimeZones: { London: 'Europe/London' } }).success,
    ).toBe(true);
    expect(PeopleSettings.safeParse({ timeZone: 'Mars/Olympus', siteTimeZones: {} }).success).toBe(false);
    expect(PeopleSettings.safeParse({ timeZone: 'UTC', siteTimeZones: { London: 'GMT+25' } }).success).toBe(false);
  });
});
