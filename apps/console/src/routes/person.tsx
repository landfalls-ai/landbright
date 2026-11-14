import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Fingerprint, ListChecks, Mail, Smartphone, UserX } from 'lucide-react';
import { toast } from 'sonner';
import { InviteResult, Person, type RequiredAction } from '@landbright/contracts';
import { Fact, formatDate, StatusBadge } from '@/components/directory/bits';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge, Chip } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, FormError } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, PickMany, Switch } from '@/components/ui/inputs';
import { SectionLabel } from '@/components/ui/section-label';
import { send, useAgents, useMe, usePerson, useWrite } from '@/lib/api';

const ACTIONS: Array<{ value: RequiredAction; label: string }> = [
  { value: 'update_password', label: 'Choose a new password' },
  { value: 'configure_second_step', label: 'Set up a second step' },
  { value: 'accept_terms', label: 'Accept the terms' },
];
const actionLabel = (a: RequiredAction) => ACTIONS.find((x) => x.value === a)?.label ?? a;

export function PersonPage() {
  const { id = '' } = useParams();
  const person = usePerson(id);
  const me = useMe();
  const agents = useAgents();
  const [confirm, setConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const deactivate = useWrite(() => send('POST', `/api/people/${id}/deactivate`, undefined, Person));
  const reactivate = useWrite(() => send('POST', `/api/people/${id}/reactivate`, undefined, Person));
  const invite = useWrite(() => send('POST', `/api/people/${id}/invite`, undefined, InviteResult));
  const resetSecondStep = useWrite(() => send('POST', `/api/people/${id}/reset-second-step`, undefined, Person));
  const [confirmReset, setConfirmReset] = useState(false);
  const [asking, setAsking] = useState(false);

  const p = person.data;
  if (!p) {
    return (
      <>
        <PageHeader title="Person" />
        <PageBody>
          <Card>
            {person.isLoading ? (
              <p className="py-8 text-center text-[13px] text-t3">Loading…</p>
            ) : (
              <EmptyState
                title="No such person"
                hint={
                  <Link to="/people" className="underline">
                    Back to People
                  </Link>
                }
              />
            )}
          </Card>
        </PageBody>
      </>
    );
  }
  const sponsored = (agents.data?.items ?? []).filter((a) => a.sponsor.id === p.id);
  const self = me.data?.id === p.id;
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to="/people" aria-label="Back to People" className="text-t3 hover:text-t1">
              <ArrowLeft className="size-4" />
            </Link>
            {p.displayName}
          </span>
        }
        meta={<StatusBadge status={p.status} />}
        actions={
          <>
            {p.status === 'active' && (
              <Button
                size="sm"
                loading={invite.isPending}
                onClick={() =>
                  invite.mutate(undefined, {
                    onSuccess: (r) => toast.success(`Invite sent to ${r.sentTo}`),
                    onError: (e) => toast.error(e.message),
                  })
                }
              >
                <Mail className="size-3.5" /> {p.hasPassword ? 'Send a password reset' : 'Send the invite again'}
              </Button>
            )}
            {p.status === 'active' && p.hasPassword && (
              <Button size="sm" onClick={() => setAsking(true)}>
                <ListChecks className="size-3.5" /> Ask them to…
              </Button>
            )}
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            {p.status === 'deactivated' ? (
              <Button
                size="sm"
                loading={reactivate.isPending}
                onClick={() => reactivate.mutate(undefined, { onError: (e) => toast.error(e.message) })}
              >
                Reactivate
              </Button>
            ) : (
              <Button
                size="sm"
                variant="danger"
                disabled={self}
                title={self ? 'You can’t deactivate yourself' : undefined}
                onClick={() => setConfirm(true)}
              >
                <UserX className="size-3.5" /> Deactivate
              </Button>
            )}
          </>
        }
      />
      <PageBody className="flex max-w-[960px] flex-col gap-4">
        <Card>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
            <Fact label="Email">{p.email}</Fact>
            <Fact label="Department">{p.department ?? '—'}</Fact>
            <Fact label="Title">{p.title ?? '—'}</Fact>
            <Fact label="Manager">
              {p.manager ? (
                <Link className="underline decoration-hair underline-offset-2" to={`/people/${p.manager.id}`}>
                  {p.manager.displayName}
                </Link>
              ) : (
                '—'
              )}
            </Fact>
            <Fact label="Start date">{formatDate(p.startDate)}</Fact>
            <Fact label="Sign-in">
              <span className="flex flex-wrap items-center gap-1.5">
                {p.hasPassword ? <Badge>Password set</Badge> : <Badge tone="warning">Invite not accepted</Badge>}
                {p.hasTotp && (
                  <Badge tone="success">
                    <Smartphone className="size-3" /> Authenticator app
                  </Badge>
                )}
                {p.passkeys > 0 && (
                  <Badge tone="success">
                    <Fingerprint className="size-3" /> {p.passkeys === 1 ? 'Passkey' : `${p.passkeys} passkeys`}
                  </Badge>
                )}
                {p.recoveryCodes > 0 && <Badge>{p.recoveryCodes} recovery codes</Badge>}
                {(p.hasTotp || p.passkeys > 0) && (
                  <button
                    type="button"
                    className="text-[12px] text-t3 underline underline-offset-2 hover:text-t1"
                    onClick={() => setConfirmReset(true)}
                  >
                    Reset
                  </button>
                )}
              </span>
            </Fact>
            {p.requiredActions.length > 0 && (
              <Fact label="At their next sign-in">
                <span className="flex flex-wrap gap-1.5" data-testid="required-actions">
                  {p.requiredActions.map((a) => (
                    <Badge key={a} tone="warning">
                      {actionLabel(a)}
                    </Badge>
                  ))}
                </span>
              </Fact>
            )}
            {p.termsAcceptedAt && <Fact label="Terms accepted">{formatDate(p.termsAcceptedAt)}</Fact>}
          </dl>
        </Card>
        <Card className="flex flex-col gap-2.5">
          <SectionLabel>Groups</SectionLabel>
          {p.groups.length ? (
            <div className="flex flex-wrap gap-1.5">
              {p.groups.map((g) => (
                <Link key={g.id} to={`/groups/${g.id}`}>
                  <Chip className="hover:border-bd hover:text-t1">{g.name}</Chip>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-t3">In no groups. Add them from a group’s page.</p>
          )}
          <p className="text-[12px] text-t3">
            Applications receive these names in the <code className="font-mono">roles</code> and{' '}
            <code className="font-mono">groups</code> claims.
          </p>
        </Card>
        <Card className="flex flex-col gap-2.5">
          <SectionLabel>Agents they sponsor</SectionLabel>
          {sponsored.length ? (
            <ul className="flex flex-col gap-1 text-[13px]">
              {sponsored.map((a) => (
                <li key={a.id} className="flex items-center gap-2">
                  <span className="text-t1">{a.displayName}</span>
                  <StatusBadge status={a.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-t3">None.</p>
          )}
        </Card>
      </PageBody>
      {confirm && (
        <ConfirmDialog
          title={`Deactivate ${p.displayName}?`}
          action="Deactivate"
          busy={deactivate.isPending}
          message={
            <>
              <p>
                They can’t sign in anymore, and every session and token they hold ends now: applications see it at their
                next token check.
              </p>
              {sponsored.length > 0 && (
                <p className="mt-2">
                  The {sponsored.length} agent{sponsored.length === 1 ? '' : 's'} they sponsor will be suspended.
                </p>
              )}
              <p className="mt-2">You can reactivate them later; their groups stay.</p>
            </>
          }
          onClose={() => setConfirm(false)}
          onConfirm={() =>
            deactivate.mutate(undefined, {
              onSuccess: () => setConfirm(false),
              onError: (e) => {
                setConfirm(false);
                toast.error(e.message);
              },
            })
          }
        />
      )}
      {editing && <EditPersonDialog person={p} onClose={() => setEditing(false)} />}
      {asking && <RequiredActionsDialog person={p} onClose={() => setAsking(false)} />}
      {confirmReset && (
        <ConfirmDialog
          title={`Reset ${p.displayName}’s second step?`}
          action="Reset"
          busy={resetSecondStep.isPending}
          message="Their authenticator app and passkeys stop working for Landbright. At their next sign-in, after their password, they set up a new second step. Use this when they lost their phone or laptop."
          onClose={() => setConfirmReset(false)}
          onConfirm={() =>
            resetSecondStep.mutate(undefined, {
              onSuccess: () => {
                setConfirmReset(false);
                toast.success('Second step reset');
              },
              onError: (e) => toast.error(e.message),
            })
          }
        />
      )}
    </>
  );
}

/** Keycloak's required actions: what they must do at their next sign-in, and optionally an email saying so. */
function RequiredActionsDialog({ person, onClose }: { person: Person; onClose: () => void }) {
  const [actions, setActions] = useState<RequiredAction[]>(person.requiredActions);
  const [notify, setNotify] = useState(true);
  const save = useWrite(() => send('POST', `/api/people/${person.id}/required-actions`, { actions, notify }, Person));
  return (
    <Dialog
      title={`Ask ${person.givenName} to…`}
      subtitle="Before they reach any application, at their next sign-in."
      onClose={onClose}
      width={520}
      onSubmit={() =>
        save.mutate(undefined, {
          onSuccess: () => {
            toast.success(
              actions.length
                ? notify
                  ? `Emailed ${person.email}`
                  : 'Saved: they’ll be asked at their next sign-in'
                : 'Nothing is asked of them now',
            );
            onClose();
          },
        })
      }
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending} data-testid="save-actions">
            {actions.length ? 'Save' : 'Clear'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <PickMany options={ACTIONS} value={actions} onChange={setActions} />
        <label className="flex items-start gap-2.5 text-[13px] text-t1">
          <Switch checked={notify} onChange={setNotify} label="Email them" />
          <span className="flex flex-col gap-0.5">
            Email them
            <span className="text-[12px] text-t3">
              {actions.includes('update_password')
                ? 'With a one-time link to choose a new password without the old one (72 hours). The rest happens when they sign in.'
                : 'A link to sign in, where they’ll be asked.'}
            </span>
          </span>
        </label>
        <FormError error={save.error} />
      </div>
    </Dialog>
  );
}

function EditPersonDialog({ person, onClose }: { person: Person; onClose: () => void }) {
  const [form, setForm] = useState({
    givenName: person.givenName,
    familyName: person.familyName,
    department: person.department ?? '',
    title: person.title ?? '',
    startDate: person.startDate ?? '',
  });
  const save = useWrite(() =>
    send(
      'PATCH',
      `/api/people/${person.id}`,
      {
        givenName: form.givenName,
        familyName: form.familyName,
        department: form.department || null,
        title: form.title || null,
        startDate: form.startDate || null,
      },
      Person,
    ),
  );
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });
  return (
    <Dialog
      title={`Edit ${person.displayName}`}
      subtitle={person.email ?? undefined}
      onClose={onClose}
      onSubmit={() => save.mutate(undefined, { onSuccess: onClose })}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">
            <Input value={form.givenName} onChange={set('givenName')} required autoFocus />
          </Field>
          <Field label="Last name">
            <Input value={form.familyName} onChange={set('familyName')} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Department">
            <Input value={form.department} onChange={set('department')} />
          </Field>
          <Field label="Title">
            <Input value={form.title} onChange={set('title')} />
          </Field>
        </div>
        <Field label="Start date">
          <Input type="date" value={form.startDate} onChange={set('startDate')} />
        </Field>
        <FormError error={save.error} />
      </div>
    </Dialog>
  );
}
