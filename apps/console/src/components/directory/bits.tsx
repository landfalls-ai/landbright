import type { ReactNode } from 'react';
import type { IdentityStatus } from '@landbright/contracts';
import { Badge, type Tone } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Card } from '@/components/shell/page-header';

const STATUS: Record<IdentityStatus, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'success' },
  pre_hire: { label: 'Pre-hire', tone: 'accent' },
  suspended: { label: 'Suspended', tone: 'warning' },
  deactivated: { label: 'Deactivated', tone: 'muted' },
};

export function StatusBadge({ status }: { status: IdentityStatus }) {
  const s = STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** "12 Nov 2026". */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: iso.length === 10 ? 'UTC' : undefined,
  });
}

/** "12 Nov 2026, 14:03:22". */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Loading, failed or empty, in one place, so every list says the same thing the same way. */
export function ListState({
  loading,
  error,
  empty,
  icon,
  emptyHint,
  action,
}: {
  loading: boolean;
  error: unknown;
  empty: string;
  icon: ReactNode;
  emptyHint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card>
      {loading ? (
        <p className="py-8 text-center text-[13px] text-t3">Loading…</p>
      ) : error ? (
        <EmptyState
          icon={icon}
          title="Couldn’t load this"
          hint={error instanceof Error ? error.message : String(error)}
        />
      ) : (
        <EmptyState icon={icon} title={empty} hint={emptyHint} action={action} />
      )}
    </Card>
  );
}

/** A label and a value, for detail pages. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{label}</dt>
      <dd className="text-[13px] text-t1">{children}</dd>
    </div>
  );
}
