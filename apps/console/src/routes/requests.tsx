import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Inbox, Plus, Siren, Zap } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { AccessRequestView, RequestPreview } from '@landbright/contracts';
import { minutes, RequestStatusBadge, standing } from '@/components/access/bits';
import { formatTime, ListState } from '@/components/directory/bits';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, FormError } from '@/components/ui/dialog';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/inputs';
import { Cell, Row, Table } from '@/components/ui/table';
import { type RequestScope, send, useMe, useRequestable, useRequests, useWrite } from '@/lib/api';
import { cn } from '@/lib/utils';

const TABS: Array<{ scope: RequestScope; label: string; admin?: boolean }> = [
  { scope: 'to-decide', label: 'To decide' },
  { scope: 'mine', label: 'Mine' },
  { scope: 'all', label: 'All', admin: true },
];

/**
 * Requests (spec 004): ask for a bundle, follow your requests, and decide the ones you are named on. Landflow flows
 * run the conversation (email, Slack); the decision is made here.
 */
export function RequestsPage() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const toDecide = useRequests('to-decide');
  const scope = (params.get('tab') as RequestScope | null) ?? (toDecide.data?.items.length ? 'to-decide' : 'mine');
  const list = useRequests(scope);
  const [asking, setAsking] = useState(false);
  const navigate = useNavigate();
  const items = list.data?.items ?? [];
  const ask = (
    <Button variant="primary" size="sm" onClick={() => setAsking(true)} data-testid="ask-access">
      <Plus className="size-3.5" /> Request access
    </Button>
  );
  return (
    <>
      <PageHeader title="Requests" actions={ask} />
      <PageBody className="flex max-w-[1180px] flex-col gap-3">
        <div className="flex gap-1" role="tablist">
          {TABS.filter((t) => !t.admin || me.data?.admin).map((t) => (
            <button
              key={t.scope}
              role="tab"
              aria-selected={scope === t.scope}
              onClick={() => setParams({ tab: t.scope })}
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] transition-colors duration-[120ms]',
                scope === t.scope ? 'bg-acdim font-semibold text-t1' : 'text-t2 hover:text-t1',
              )}
            >
              {t.label}
              {t.scope === 'to-decide' && Boolean(toDecide.data?.items.length) && (
                <Badge tone="warning">{toDecide.data?.items.length}</Badge>
              )}
            </button>
          ))}
        </div>
        {items.length ? (
          <Table head={['Request', 'For', 'Status', 'Where it stands', 'Asked']}>
            {items.map((r) => (
              <Row key={r.id} onClick={() => navigate(`/access/requests/${r.ref}`)} testId={`request-${r.ref}`}>
                <Cell>
                  <div className="font-medium text-t1">{r.bundle.name}</div>
                  <div className="font-mono text-[11px] text-t3">
                    {r.ref} · {minutes(r.durationMinutes)}
                    {r.breakGlass ? ' · break-glass' : ''}
                  </div>
                </Cell>
                <Cell>
                  <div className="text-t1">{r.subject.displayName}</div>
                  {r.requester.id !== r.subject.id && (
                    <div className="text-[12px] text-t3">asked by {r.requester.displayName}</div>
                  )}
                </Cell>
                <Cell>
                  <RequestStatusBadge status={r.status} />
                </Cell>
                <Cell className="text-[12px] text-t2">{standing(r)}</Cell>
                <Cell className="whitespace-nowrap font-mono text-[12px] text-t3">{formatTime(r.createdAt)}</Cell>
              </Row>
            ))}
          </Table>
        ) : (
          <ListState
            loading={list.isLoading}
            error={list.error}
            icon={<Inbox className="size-5" strokeWidth={1.7} />}
            empty={
              scope === 'to-decide'
                ? 'Nothing waits for you'
                : scope === 'mine'
                  ? 'You haven’t asked for anything'
                  : 'No requests yet'
            }
            emptyHint={
              scope === 'to-decide'
                ? 'Requests that name you as an approver show up here, and in the email or message their Landflow flow sends.'
                : 'Ask for a bundle: access for a while, approved by the people its policy names.'
            }
            action={scope === 'to-decide' ? undefined : ask}
          />
        )}
      </PageBody>
      {asking && (
        <RequestDialog onClose={() => setAsking(false)} onCreated={(r) => navigate(`/access/requests/${r.ref}`)} />
      )}
    </>
  );
}

const DURATIONS = [15, 30, 60, 120, 240, 480, 1440, 2880, 10080];

function RequestDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (r: AccessRequestView) => void }) {
  const bundles = useRequestable();
  const [form, setForm] = useState({ bundleId: '', duration: 0, reason: '', ticket: '', breakGlass: false });
  const bundleId = form.bundleId || bundles.data?.items[0]?.id || '';
  const bundle = bundles.data?.items.find((b) => b.id === bundleId);
  const duration = form.duration || bundle?.policy.defaultDurationMinutes || 60;
  const preview = useQuery({
    queryKey: ['preview', bundleId, duration],
    queryFn: () =>
      send('POST', '/api/access/requests/preview', { bundleId, durationMinutes: duration }, RequestPreview),
    enabled: Boolean(bundleId),
    retry: false,
  });
  const p = preview.data;
  const create = useWrite(() =>
    send(
      'POST',
      '/api/access/requests',
      {
        bundleId,
        durationMinutes: duration,
        reason: form.reason || undefined,
        ticket: form.ticket ? { id: form.ticket } : undefined,
        breakGlass: form.breakGlass,
      },
      AccessRequestView,
    ),
  );
  const max = form.breakGlass ? (bundle?.policy.breakGlass.maxDurationMinutes ?? 60) : (p?.maxDurationMinutes ?? 240);
  const choices = [...new Set([...DURATIONS.filter((d) => d <= max), duration])].sort((a, b) => a - b);
  if (bundles.data && !bundles.data.items.length)
    return (
      <Dialog title="Request access" onClose={onClose}>
        <p className="py-6 text-center text-[13px] text-t2">
          There is nothing you may ask for yet. An administrator makes bundles in the catalog, and their policy says who
          may ask.
        </p>
      </Dialog>
    );
  return (
    <Dialog
      title="Request access"
      subtitle="For a while: it ends by itself."
      onClose={onClose}
      onSubmit={() => create.mutate(undefined, { onSuccess: onCreated })}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={form.breakGlass ? 'danger' : 'primary'}
            loading={create.isPending}
            disabled={!p?.eligible}
            data-testid="submit-request"
          >
            {form.breakGlass ? 'Take it now' : p?.autoApproveRule ? 'Get it now' : 'Ask'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Field label="Bundle" hint={bundle?.description ?? undefined}>
          <Select
            value={bundleId}
            onChange={(e) => setForm({ ...form, bundleId: e.target.value, duration: 0, breakGlass: false })}
            autoFocus
          >
            {bundles.data?.items.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        {bundle && (bundle.groups.length > 0 || bundle.targets.length > 0) && (
          <div className="flex flex-wrap gap-1.5 text-[12px] text-t2">
            {bundle.groups.map((g) => (
              <Badge key={g.id} tone="accent">
                Group {g.name}
              </Badge>
            ))}
            {bundle.targets.map((t) => (
              <Badge key={t.key}>{t.label}</Badge>
            ))}
          </div>
        )}
        <Field label="For how long">
          <Select value={duration} onChange={(e) => setForm({ ...form, duration: Number(e.target.value) })}>
            {choices.map((d) => (
              <option key={d} value={d}>
                {minutes(d)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={`${p?.reason.prompt ?? 'Why do you need it?'}${p?.reason.mode === 'required' ? '' : ' (optional)'}`}
          hint={
            p?.reason.mode === 'required' && p.reason.minLength
              ? `At least ${p.reason.minLength} characters.`
              : undefined
          }
        >
          <Textarea
            rows={3}
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
            placeholder="Fix the Payments retry flow"
          />
        </Field>
        {p && p.ticket.mode !== 'off' && (
          <Field label={`${p.ticket.label}${p.ticket.mode === 'optional' ? ' (optional)' : ''}`}>
            <Input
              value={form.ticket}
              onChange={(e) => setForm({ ...form, ticket: e.target.value })}
              placeholder={p.ticket.pattern ? `Matches ${p.ticket.pattern}` : 'OPS-1234'}
            />
          </Field>
        )}
        {p?.breakGlassAllowed && (
          <div className="flex items-start gap-3 rounded-xl border border-rdbd bg-rddim px-3 py-2.5">
            <Siren className="mt-0.5 size-4 shrink-0 text-rd" />
            <div className="flex-1 text-[12px] leading-snug text-t2">
              <div className="font-semibold text-t1">Break-glass</div>
              Take it now, without waiting, for at most {minutes(bundle?.policy.breakGlass.maxDurationMinutes ?? 60)}.
              The approvers review it afterwards, and everyone sees it was break-glass.
            </div>
            <Switch
              checked={form.breakGlass}
              onChange={(v) => setForm({ ...form, breakGlass: v })}
              label="Break-glass"
            />
          </div>
        )}
        <Preview preview={p} loading={preview.isLoading} error={preview.error} breakGlass={form.breakGlass} />
        <FormError error={create.error} />
      </div>
    </Dialog>
  );
}

function Preview({
  preview: p,
  loading,
  error,
  breakGlass,
}: {
  preview?: RequestPreview;
  loading: boolean;
  error: unknown;
  breakGlass: boolean;
}) {
  if (loading) return <p className="text-[12px] text-t3">Checking the policy…</p>;
  if (error) return <FormError error={error} />;
  if (!p) return null;
  if (!p.eligible)
    return <p className="rounded-xl border border-warnbd bg-warndim px-3 py-2 text-[12px] text-warn">{p.whyNot}</p>;
  return (
    <div
      className="rounded-xl border border-hair bg-sf2 px-3 py-2.5 text-[12px] leading-snug text-t2"
      data-testid="preview"
    >
      {breakGlass ? (
        <>You get it as soon as you ask. </>
      ) : p.autoApproveRule ? (
        <span className="flex items-center gap-1.5">
          <Zap className="size-3.5 text-gn" /> Approved at once by the rule “{p.autoApproveRule}”.
        </span>
      ) : (
        <>
          Decided by{' '}
          <span className="font-semibold text-t1">
            {p.approvers.map((a) => a.displayName).join(', ') || 'nobody yet'}
          </span>
          . Their Landflow flow tells them; they decide in Landbright.
        </>
      )}
      {p.pendingRequest && <div className="mt-1 text-t3">This replaces your waiting request {p.pendingRequest}.</div>}
    </div>
  );
}
