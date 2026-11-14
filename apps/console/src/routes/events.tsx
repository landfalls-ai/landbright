import { useState } from 'react';
import { Plus, RotateCw, Webhook } from 'lucide-react';
import { Subscription } from '@landbright/contracts';
import { formatTime, ListState } from '@/components/directory/bits';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge, Chip } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, FormError } from '@/components/ui/dialog';
import { Field, Input, PickMany, Switch } from '@/components/ui/inputs';
import { SectionLabel } from '@/components/ui/section-label';
import { Cell, Row, Table } from '@/components/ui/table';
import { send, useDeliveries, useSubscriptions, useWrite } from '@/lib/api';

/**
 * Events out (spec 004): Landbright's answer to Keycloak's event listeners. Each subscription gets every audit event
 * matching its patterns, POSTed as a JWT signed with Landbright's key (Landflow's Webhook trigger checks it against
 * /oidc/jwks), retried with back-off for a day, at least once (an `Idempotency-Key` lets the flow drop repeats).
 */
export function EventsPage() {
  const subs = useSubscriptions();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string>();
  const items = subs.data?.items ?? [];
  const selected = items.find((s) => s.id === open);
  const add = (
    <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
      <Plus className="size-3.5" /> New subscription
    </Button>
  );
  return (
    <>
      <PageHeader
        title="Events"
        meta={
          subs.data && (
            <span>
              {items.length} {items.length === 1 ? 'subscription' : 'subscriptions'}
            </span>
          )
        }
        actions={add}
      />
      <PageBody className="flex max-w-[1180px] flex-col gap-4">
        {items.length ? (
          <Table head={['Delivered to', 'Events', 'Deliveries', 'On']}>
            {items.map((s) => (
              <Row
                key={s.id}
                onClick={() => setOpen(open === s.id ? undefined : s.id)}
                testId={`subscription-${s.url}`}
              >
                <Cell>
                  <div className="max-w-[380px] truncate font-mono text-[12px] text-t1" title={s.url}>
                    {s.url}
                  </div>
                  <div className="text-[12px] text-t3">{s.description ?? `aud ${s.audience}`}</div>
                </Cell>
                <Cell>
                  <div className="flex max-w-[300px] flex-wrap gap-1">
                    {s.events.map((e) => (
                      <Chip key={e} mono>
                        {e}
                      </Chip>
                    ))}
                  </div>
                </Cell>
                <Cell className="whitespace-nowrap text-[12px]">
                  <span className="text-gn">{s.stats.delivered} delivered</span>
                  {s.stats.pending > 0 && <span className="text-warn"> · {s.stats.pending} pending</span>}
                  {s.stats.failed > 0 && <span className="text-rd"> · {s.stats.failed} failed</span>}
                </Cell>
                <Cell>
                  <Toggle sub={s} />
                </Cell>
              </Row>
            ))}
          </Table>
        ) : (
          <ListState
            loading={subs.isLoading}
            error={subs.error}
            icon={<Webhook className="size-5" strokeWidth={1.7} />}
            empty="Nothing subscribed"
            emptyHint="Point a subscription at a Landflow Webhook trigger whose JWT Auth credential uses Landbright’s JWKS."
            action={add}
          />
        )}
        {selected && <Deliveries sub={selected} />}
      </PageBody>
      {adding && <NewSubscription eventTypes={subs.data?.eventTypes ?? []} onClose={() => setAdding(false)} />}
    </>
  );
}

function Toggle({ sub }: { sub: Subscription }) {
  const write = useWrite((disabled: boolean) =>
    send('PATCH', `/api/events/subscriptions/${sub.id}`, { disabled }, Subscription),
  );
  return (
    <span onClick={(e) => e.stopPropagation()}>
      <Switch checked={!sub.disabled} onChange={(on) => write.mutate(!on)} disabled={write.isPending} label="Deliver" />
    </span>
  );
}

function Deliveries({ sub }: { sub: Subscription }) {
  const deliveries = useDeliveries(sub.id);
  const resend = useWrite((id: string) => send('POST', `/api/events/deliveries/${id}/resend`));
  const items = deliveries.data?.items ?? [];
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>Last deliveries to {new URL(sub.url).pathname}</SectionLabel>
      {items.length ? (
        <Table head={['When', 'Event', 'Status', 'Answer', '']}>
          {items.map((d) => (
            <Row key={d.id}>
              <Cell className="whitespace-nowrap font-mono text-[12px] text-t3">{formatTime(d.createdAt)}</Cell>
              <Cell>
                <Chip mono>{d.action}</Chip>
                <span className="ml-1.5 font-mono text-[11px] text-t3">#{d.auditEventId}</span>
              </Cell>
              <Cell>
                <Badge tone={d.status === 'delivered' ? 'success' : d.status === 'failed' ? 'danger' : 'warning'}>
                  {d.status}
                </Badge>
                {d.attempts > 1 && <span className="ml-1.5 text-[11px] text-t3">{d.attempts} tries</span>}
              </Cell>
              <Cell className="max-w-[360px] text-[12px] text-t2">
                <div className="truncate" title={d.lastError ?? JSON.stringify(d.response)}>
                  {d.lastStatus ? `${d.lastStatus} ` : ''}
                  {d.lastError ?? (d.response ? JSON.stringify(d.response) : '')}
                </div>
                {d.nextAttemptAt && <div className="text-[11px] text-t3">next try {formatTime(d.nextAttemptAt)}</div>}
              </Cell>
              <Cell>
                <Button size="sm" variant="ghost" onClick={() => resend.mutate(d.id)} title="Send it again">
                  <RotateCw className="size-3.5" /> Resend
                </Button>
              </Cell>
            </Row>
          ))}
        </Table>
      ) : (
        <Card>
          <p className="py-4 text-center text-[13px] text-t3">
            {deliveries.isLoading ? 'Loading…' : 'Nothing delivered yet.'}
          </p>
        </Card>
      )}
    </section>
  );
}

function NewSubscription({ eventTypes, onClose }: { eventTypes: string[]; onClose: () => void }) {
  const [f, setF] = useState({
    url: '',
    events: [] as string[],
    extra: '',
    description: '',
    audience: '',
    replay: false,
  });
  const create = useWrite(() =>
    send(
      'POST',
      '/api/events/subscriptions',
      {
        url: f.url,
        events: [...f.events, ...f.extra.split(/[\s,]+/).filter(Boolean)],
        description: f.description || undefined,
        audience: f.audience || undefined,
        replay: f.replay ? 20 : 0,
      },
      Subscription,
    ),
  );
  const groups = [...new Set(eventTypes.map((t) => t.split('.')[0]!))];
  return (
    <Dialog
      title="New subscription"
      subtitle="Usually a Landflow Webhook trigger’s production URL."
      width={680}
      onClose={onClose}
      onSubmit={() => create.mutate(undefined, { onSuccess: onClose })}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Subscribe
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Field label="URL">
          <Input
            value={f.url}
            onChange={(e) => setF({ ...f, url: e.target.value })}
            required
            autoFocus
            placeholder="http://localhost:57300/api/webhook/landbright-requests"
          />
        </Field>
        <Field label="Events" hint="Or type patterns below: grant.*, group.member_*, * for everything.">
          <div className="flex max-h-[220px] flex-col gap-2 overflow-y-auto">
            {groups.map((g) => (
              <PickMany
                key={g}
                options={eventTypes.filter((t) => t.startsWith(`${g}.`)).map((t) => ({ value: t, label: t }))}
                value={f.events}
                onChange={(v) => setF({ ...f, events: v })}
              />
            ))}
          </div>
        </Field>
        <Field label="Patterns">
          <Input value={f.extra} onChange={(e) => setF({ ...f, extra: e.target.value })} placeholder="grant.*" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Audience (aud)" hint="Defaults to the URL’s origin.">
            <Input value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })} />
          </Field>
          <Field label="Description">
            <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[13px] text-t2">
          <Switch checked={f.replay} onChange={(v) => setF({ ...f, replay: v })} label="Replay" /> Start 20 audit events
          back, and send those that match (to try a new flow)
        </label>
        <FormError error={create.error} />
      </div>
    </Dialog>
  );
}
