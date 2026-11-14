import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Check, Clock, Inbox, Siren, Workflow, X, Zap } from 'lucide-react';
import { AccessRequestView } from '@landbright/contracts';
import { GrantStatusBadge, minutes, relative, RequestStatusBadge, TargetStatusBadge } from '@/components/access/bits';
import { Fact, formatTime, ListState } from '@/components/directory/bits';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge, Chip } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, FormError } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/inputs';
import { SectionLabel } from '@/components/ui/section-label';
import { Cell, Row, Table } from '@/components/ui/table';
import { send, useRequest, useWrite } from '@/lib/api';

/**
 * One request: the decision page every Landflow flow links to (`decisionUrl`). Approvers decide here, signed in, so
 * the vote carries their session's assurance. Where a step allows it, a vote can also come from a chat a flow relays,
 * with a ticket Landbright gave that approver (`assurance: chat`).
 */
export function RequestPage() {
  const { ref = '' } = useParams();
  const request = useRequest(ref);
  const r = request.data;
  const [deciding, setDeciding] = useState<'approve' | 'deny'>();
  const [revoking, setRevoking] = useState(false);
  const [extending, setExtending] = useState(false);
  const cancel = useWrite(() => send('POST', `/api/access/requests/${r?.id}/cancel`, undefined, AccessRequestView));
  if (!r)
    return (
      <>
        <PageHeader title={ref} />
        <PageBody className="max-w-[1080px]">
          <ListState
            loading={request.isLoading}
            error={request.error}
            icon={<Inbox className="size-5" strokeWidth={1.7} />}
            empty="No such request"
          />
        </PageBody>
      </>
    );
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to="/requests" className="text-t3 hover:text-t1" aria-label="Back to requests">
              <ArrowLeft className="size-4" />
            </Link>
            {r.bundle.name}
          </span>
        }
        meta={
          <>
            <Chip mono>{r.ref}</Chip>
            <RequestStatusBadge status={r.status} />
          </>
        }
        actions={
          <>
            {r.actions.cancel && (
              <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate(undefined)}>
                Cancel request
              </Button>
            )}
            {r.actions.extend && r.grant && (
              <Button size="sm" variant="ghost" onClick={() => setExtending(true)} data-testid="extend">
                <Clock className="size-3.5" /> Ask for more time
              </Button>
            )}
            {r.actions.revoke && r.grant && (
              <Button size="sm" variant="danger" onClick={() => setRevoking(true)} data-testid="revoke">
                Revoke now
              </Button>
            )}
            {r.actions.decide && (
              <>
                <Button size="sm" variant="danger" onClick={() => setDeciding('deny')} data-testid="deny">
                  <X className="size-3.5" /> Deny
                </Button>
                <Button size="sm" variant="primary" onClick={() => setDeciding('approve')} data-testid="approve">
                  <Check className="size-3.5" /> Approve
                </Button>
              </>
            )}
          </>
        }
      />
      <PageBody className="flex max-w-[1080px] flex-col gap-4">
        <FormError error={cancel.error} />
        {r.extends && (
          <Card className="flex items-center gap-3">
            <Clock className="size-4 text-ac" />
            <span className="text-[13px] text-t1">
              More time on the grant of{' '}
              <Link to={`/access/requests/${r.extends.ref}`} className="text-ac underline">
                {r.extends.ref}
              </Link>
              . Approved, that grant ends {minutes(r.durationMinutes)} later.
            </span>
          </Card>
        )}
        {r.breakGlass != null && (
          <Card className="flex items-center gap-3 border-rdbd bg-rddim">
            <Siren className="size-4 text-rd" />
            <span className="text-[13px] text-t1">
              Break-glass: granted when asked. The approvers below review it afterwards.
            </span>
          </Card>
        )}
        {r.autoApproval != null && (
          <Card className="flex items-center gap-3">
            <Zap className="size-4 text-gn" />
            <span className="text-[13px] text-t1">
              Approved at once by a rule of the policy (
              {String((r.autoApproval as { rule?: string }).rule ?? 'auto-approve')}).
            </span>
          </Card>
        )}
        <Card className="animate-fade-up">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3.5 md:grid-cols-3">
            <Fact label="For">
              {r.subject.displayName}
              {r.subject.kind === 'agent' && <Badge className="ml-1.5">Agent</Badge>}
            </Fact>
            <Fact label="Asked by">{r.requester.displayName}</Fact>
            <Fact label="For how long">{minutes(r.durationMinutes)}</Fact>
            <Fact label="Why">{r.reason ?? '—'}</Fact>
            <Fact label="Ticket">
              {r.ticket ? (
                r.ticket.url ? (
                  <a className="text-ac underline" href={r.ticket.url} target="_blank" rel="noreferrer">
                    {r.ticket.id}
                  </a>
                ) : (
                  r.ticket.id
                )
              ) : (
                '—'
              )}
            </Fact>
            <Fact label="Asked">{formatTime(r.createdAt)}</Fact>
            {r.status === 'pending' ? (
              <Fact label="Decide by">
                {formatTime(r.deadline)} <span className="text-t3">({relative(r.deadline)})</span>
              </Fact>
            ) : (
              <Fact label="Decided">
                {r.decidedAt ? formatTime(r.decidedAt) : '—'}
                {r.closingReason && <span className="text-t3"> · {r.closingReason}</span>}
              </Fact>
            )}
            {r.startsAt && <Fact label="Starts">{formatTime(r.startsAt)}</Fact>}
            <Fact label="Through">{r.source}</Fact>
          </dl>
        </Card>

        <section className="flex flex-col gap-2">
          <SectionLabel>Approval</SectionLabel>
          {r.steps.map((s, i) => (
            <Card key={i} className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold text-t1">
                  {r.steps.length > 1 ? `Step ${i + 1}: ` : ''}
                  {s.name}
                </span>
                <Badge
                  tone={
                    s.approvals >= s.approvalsRequired
                      ? 'success'
                      : i === r.currentStep && r.status === 'pending'
                        ? 'warning'
                        : 'muted'
                  }
                >
                  {s.approvals} of {s.approvalsRequired}
                </Badge>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {s.approvers.map((a) => {
                  const vote = r.votes.find((v) => v.decider.id === a.id && v.step === i);
                  return (
                    <Chip key={a.id} tone={vote ? (vote.outcome === 'approve' ? 'success' : 'danger') : 'muted'}>
                      {vote ? (
                        vote.outcome === 'approve' ? (
                          <Check className="size-3" />
                        ) : (
                          <X className="size-3" />
                        )
                      ) : null}
                      {a.displayName}
                    </Chip>
                  );
                })}
                {!s.approvers.length && <span className="text-[12px] text-t3">Nobody (approved by the policy)</span>}
              </div>
            </Card>
          ))}
          {r.votes.length > 0 && (
            <Table head={['Who', 'Decided', 'How', 'Comment', 'When']}>
              {r.votes.map((v, i) => (
                <Row key={i}>
                  <Cell className="text-t1">{v.decider.displayName}</Cell>
                  <Cell>
                    <Badge tone={v.outcome === 'approve' ? 'success' : 'danger'}>
                      {v.outcome === 'approve' ? 'Approved' : 'Denied'}
                    </Badge>
                  </Cell>
                  <Cell className="text-[12px] text-t2">
                    {v.channel}
                    {v.submittedBy ? ` via ${v.submittedBy}` : ''} · {v.assurance}
                  </Cell>
                  <Cell className="text-[12px] text-t2">{v.comment ?? '—'}</Cell>
                  <Cell className="whitespace-nowrap font-mono text-[12px] text-t3">{formatTime(v.at)}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </section>

        {r.grant && (
          <section className="flex flex-col gap-2">
            <SectionLabel>Grant</SectionLabel>
            <Card className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <GrantStatusBadge status={r.grant.status} />
              <span className="text-[13px] text-t2">
                {r.grant.status === 'active' || r.grant.status === 'scheduled' ? (
                  <>
                    Until <span className="text-t1">{formatTime(r.grant.expiresAt)}</span> (
                    {relative(r.grant.expiresAt)})
                  </>
                ) : (
                  <>
                    Ended {r.grant.closedAt ? formatTime(r.grant.closedAt) : ''}
                    {r.grant.closingReason ? ` · ${r.grant.closingReason}` : ''}
                  </>
                )}
              </span>
            </Card>
            <Table head={['What', 'Done by', 'Status', 'Reference']}>
              {r.grant.targets.map((t) => (
                <Row key={t.key} testId={`target-${t.key}`}>
                  <Cell>
                    <div className="text-t1">{t.label}</div>
                    <div className="font-mono text-[11px] text-t3">{t.key}</div>
                  </Cell>
                  <Cell className="text-[12px] text-t2">
                    {t.managedBy === 'flow' ? (
                      <span className="flex items-center gap-1.5">
                        <Workflow className="size-3.5" /> A Landflow flow
                      </span>
                    ) : (
                      'Landbright'
                    )}
                  </Cell>
                  <Cell>
                    <TargetStatusBadge status={t.status} />
                    {t.lastError && <div className="mt-0.5 max-w-[320px] text-[11px] text-rd">{t.lastError}</div>}
                  </Cell>
                  <Cell className="max-w-[280px] truncate font-mono text-[11px] text-t3">{t.externalRef ?? '—'}</Cell>
                </Row>
              ))}
            </Table>
          </section>
        )}

        {Object.keys(r.annotations).length > 0 && (
          <section className="flex flex-col gap-2">
            <SectionLabel>Notes from flows</SectionLabel>
            <Card className="flex flex-col gap-1.5">
              {Object.entries(r.annotations).map(([k, v]) => (
                <div key={k} className="flex gap-3 text-[12px]">
                  <span className="w-[180px] shrink-0 font-mono text-t3">{k}</span>
                  <span className="min-w-0 truncate font-mono text-t2" title={JSON.stringify(v)}>
                    {JSON.stringify(v)}
                  </span>
                </div>
              ))}
            </Card>
          </section>
        )}
      </PageBody>
      {deciding && <DecideDialog request={r} outcome={deciding} onClose={() => setDeciding(undefined)} />}
      {revoking && r.grant && <RevokeDialog request={r} grantId={r.grant.id} onClose={() => setRevoking(false)} />}
      {extending && r.grant && <ExtendDialog request={r} grantId={r.grant.id} onClose={() => setExtending(false)} />}
    </>
  );
}

function DecideDialog({
  request: r,
  outcome,
  onClose,
}: {
  request: AccessRequestView;
  outcome: 'approve' | 'deny';
  onClose: () => void;
}) {
  const [comment, setComment] = useState('');
  const decide = useWrite(() =>
    send(
      'POST',
      `/api/access/requests/${r.id}/decision`,
      { outcome, comment: comment || undefined },
      AccessRequestView,
    ),
  );
  return (
    <Dialog
      title={outcome === 'approve' ? `Approve ${r.ref}?` : `Deny ${r.ref}?`}
      subtitle={`${r.subject.displayName} · ${r.bundle.name} · ${minutes(r.durationMinutes)}`}
      onClose={onClose}
      onSubmit={() => decide.mutate(undefined, { onSuccess: onClose })}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Back
          </Button>
          <Button
            type="submit"
            variant={outcome === 'approve' ? 'primary' : 'danger'}
            loading={decide.isPending}
            data-testid="confirm-decision"
          >
            {outcome === 'approve' ? 'Approve' : 'Deny'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <p className="text-[13px] leading-snug text-t2">
          {outcome === 'approve'
            ? r.steps.length > 1 || (r.steps[r.currentStep]?.approvalsRequired ?? 1) > 1
              ? 'Your approval counts towards this step; the request is approved when every step has enough.'
              : 'Access starts as soon as you approve, and ends by itself.'
            : 'One denial ends the request.'}
        </p>
        <Field label="Comment (optional)">
          <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} autoFocus />
        </Field>
        <FormError error={decide.error} />
      </div>
    </Dialog>
  );
}

function RevokeDialog({
  request: r,
  grantId,
  onClose,
}: {
  request: AccessRequestView;
  grantId: string;
  onClose: () => void;
}) {
  const [comment, setComment] = useState('');
  const revoke = useWrite(() =>
    send('POST', `/api/access/grants/${grantId}/revoke`, { comment: comment || undefined }, AccessRequestView),
  );
  return (
    <Dialog
      title={`Revoke ${r.bundle.name} now?`}
      subtitle={`${r.subject.displayName} · ${r.ref}`}
      onClose={onClose}
      onSubmit={() => revoke.mutate(undefined, { onSuccess: onClose })}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Back
          </Button>
          <Button type="submit" variant="danger" loading={revoke.isPending} data-testid="confirm-revoke">
            Revoke
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <p className="text-[13px] leading-snug text-t2">
          Landbright removes the group memberships now; each Landflow flow removes what it provisioned and reports back.
        </p>
        <Field label="Comment (optional)">
          <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} autoFocus />
        </Field>
        <FormError error={revoke.error} />
      </div>
    </Dialog>
  );
}

function ExtendDialog({
  request: r,
  grantId,
  onClose,
}: {
  request: AccessRequestView;
  grantId: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [duration, setDuration] = useState(Math.min(60, r.durationMinutes));
  const [reason, setReason] = useState('');
  const extend = useWrite(() =>
    send(
      'POST',
      `/api/access/grants/${grantId}/extend`,
      { durationMinutes: duration, reason: reason || undefined },
      AccessRequestView,
    ),
  );
  return (
    <Dialog
      title={`More time on ${r.bundle.name}?`}
      subtitle={`${r.subject.displayName} · ${r.ref} · ends ${relative(r.grant!.expiresAt)}`}
      onClose={onClose}
      onSubmit={() =>
        extend.mutate(undefined, {
          onSuccess: (x) => {
            onClose();
            void navigate(`/access/requests/${x.ref}`);
          },
        })
      }
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Back
          </Button>
          <Button type="submit" variant="primary" loading={extend.isPending} data-testid="confirm-extend">
            Ask
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <p className="text-[13px] leading-snug text-t2">
          An extension is a request of its own, decided like the first. Approved, the grant’s end moves; nothing is
          provisioned again.
        </p>
        <Field label="Minutes more">
          <Input
            type="number"
            min={1}
            value={duration}
            onChange={(e) => setDuration(Math.max(1, Number(e.target.value)))}
          />
        </Field>
        <Field label="Why">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
        <FormError error={extend.error} />
      </div>
    </Dialog>
  );
}
