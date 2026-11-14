import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, X } from 'lucide-react';
import { type PeopleSettings, Settings } from '@landbright/contracts';
import { Card } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/inputs';
import { SectionLabel } from '@/components/ui/section-label';
import { send, useWrite } from '@/lib/api';

const ZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
})();

/**
 * Start and last days (spec 007): which zone they begin and end in. A person's zone is their site's, else the
 * default. HiBob sends no zone, so the sites are listed here by the name HR gives them.
 */
export function PeopleZonesCard({ people }: { people: PeopleSettings }) {
  const [timeZone, setTimeZone] = useState(people.timeZone);
  const [sites, setSites] = useState(() =>
    Object.entries(people.siteTimeZones)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([site, zone]) => ({ site, zone })),
  );
  const save = useWrite(() =>
    send(
      'PATCH',
      '/api/settings/people',
      {
        timeZone: timeZone.trim(),
        siteTimeZones: Object.fromEntries(
          sites.filter((s) => s.site.trim()).map((s) => [s.site.trim(), s.zone.trim()]),
        ),
      },
      Settings,
    ),
  );
  const row = (i: number, key: 'site' | 'zone') => (e: { target: { value: string } }) =>
    setSites(sites.map((s, j) => (j === i ? { ...s, [key]: e.target.value } : s)));
  return (
    <section data-testid="people-zones">
      <Card className="flex flex-col gap-3">
        <SectionLabel>Start and last days</SectionLabel>
        <p className="text-[13px] leading-snug text-t2">
          A pre-hire can sign in from the start of their start date, and someone with a last day is deactivated when it
          ends, both in their zone: their site&rsquo;s below, else the default. HiBob sends no zone, so name the sites
          as HR does.
        </p>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined, {
              onSuccess: () => toast.success('Zones saved'),
              onError: (error) => toast.error(error.message),
            });
          }}
        >
          <datalist id="time-zones">
            {ZONES.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          <Field label="Default zone" className="max-w-[320px]">
            <Input list="time-zones" value={timeZone} onChange={(e) => setTimeZone(e.target.value)} required />
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-[12px] font-semibold text-t2">Sites</span>
            {sites.length === 0 && <p className="text-[12px] text-t3">No sites yet: everyone uses the default.</p>}
            {sites.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input aria-label="Site" placeholder="Tel Aviv" value={s.site} onChange={row(i, 'site')} required />
                <Input
                  aria-label="Zone"
                  list="time-zones"
                  placeholder="Asia/Jerusalem"
                  value={s.zone}
                  onChange={row(i, 'zone')}
                  required
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${s.site || 'this site'}`}
                  onClick={() => setSites(sites.filter((_, j) => j !== i))}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" onClick={() => setSites([...sites, { site: '', zone: '' }])}>
                <Plus className="size-3.5" /> Add a site
              </Button>
              <Button type="submit" size="sm" variant="primary" className="ml-auto" loading={save.isPending}>
                Save
              </Button>
            </div>
          </div>
        </form>
      </Card>
    </section>
  );
}
