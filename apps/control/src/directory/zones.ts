/**
 * Start and last days are dates in the person's zone (spec 007): their site's, else the tenant's. HiBob, for one,
 * sends `employee.joined` and `employee.left` at midnight in the site's zone, and documents no zone field, so the
 * zones are Landbright's settings.
 */
export interface Zones {
  timeZone: string;
  sites: Record<string, string>;
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** The date (YYYY-MM-DD) it is in `timeZone` at `now`. */
export function localDate(now: Date, timeZone: string): string {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formats.set(timeZone, format);
  }
  return format.format(now);
}

export const zoneOf = (zones: Zones, site: string | null | undefined) =>
  (site && zones.sites[site]) || zones.timeZone || 'UTC';

/** Today where the person is. */
export const todayIn = (zones: Zones, site: string | null | undefined, now = new Date()) =>
  localDate(now, zoneOf(zones, site));

/** `date` plus `days` (YYYY-MM-DD, calendar arithmetic in UTC). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function zonesOf(tenant: { timeZone: string; siteTimeZones: unknown }): Zones {
  const raw = tenant.siteTimeZones;
  const sites =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'))
      : {};
  return { timeZone: tenant.timeZone || 'UTC', sites };
}
