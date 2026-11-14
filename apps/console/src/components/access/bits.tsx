import type { AccessRequestView, GrantView, RequestStatus, TargetStatus } from '@landbright/contracts';
import { Badge, type Tone } from '@/components/ui/badge';

const REQUEST: Record<RequestStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Waiting', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  denied: { label: 'Denied', tone: 'danger' },
  expired: { label: 'Not decided in time', tone: 'muted' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
  superseded: { label: 'Replaced', tone: 'muted' },
};

export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  return <Badge tone={REQUEST[status].tone}>{REQUEST[status].label}</Badge>;
}

const GRANT: Record<GrantView['status'], { label: string; tone: Tone }> = {
  scheduled: { label: 'Starts later', tone: 'accent' },
  active: { label: 'Active', tone: 'success' },
  expired: { label: 'Expired', tone: 'muted' },
  revoked: { label: 'Revoked', tone: 'muted' },
};

export function GrantStatusBadge({ status }: { status: GrantView['status'] }) {
  return <Badge tone={GRANT[status].tone}>{GRANT[status].label}</Badge>;
}

const TARGET: Record<TargetStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Waiting for its flow', tone: 'warning' },
  provisioned: { label: 'Provisioned', tone: 'success' },
  verified: { label: 'Verified', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  revoked: { label: 'Removed', tone: 'muted' },
  revoke_failed: { label: 'Removal failed', tone: 'danger' },
  drift: { label: 'Drifted', tone: 'warning' },
};

export function TargetStatusBadge({ status }: { status: TargetStatus }) {
  return <Badge tone={TARGET[status].tone}>{TARGET[status].label}</Badge>;
}

/** 90 → "1 h 30 min". */
export function minutes(total: number): string {
  if (total < 60) return `${total} min`;
  const days = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  return [days && `${days} d`, h && `${h} h`, m && `${m} min`].filter(Boolean).join(' ');
}

/** "in 42 min", "3 h ago". */
export function relative(iso: string, now = Date.now()): string {
  const diff = Math.round((new Date(iso).getTime() - now) / 60_000);
  const span = minutes(Math.max(1, Math.abs(diff)));
  return diff >= 0 ? `in ${span}` : `${span} ago`;
}

/** Where a request stands, in a few words. */
export function standing(r: AccessRequestView): string {
  if (r.status === 'pending') {
    const names = r.waitingOn.map((p) => p.displayName);
    return names.length
      ? `Waiting on ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''}`
      : 'Waiting';
  }
  if (r.grant?.status === 'active')
    return `Until ${new Date(r.grant.expiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  if (r.grant?.status === 'scheduled') return `Starts ${relative(r.grant.startsAt)}`;
  return r.closingReason ?? '—';
}
