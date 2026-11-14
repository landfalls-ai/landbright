import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, KeyRound, Plus, RefreshCcw, RotateCw, Stethoscope } from 'lucide-react';
import { toast } from 'sonner';
import {
  GROUPS_MODES,
  type GroupsMode,
  ScimTargetDetail,
  type ScimTarget,
  type ScimTargetState,
  ScimTestResult,
} from '@landbright/contracts';
import { EmptyState } from '@/components/ui/empty-state';
import { Fact, formatTime, ListState } from '@/components/directory/bits';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge, Chip, type Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, FormError } from '@/components/ui/dialog';
import { Field, Input, PickMany, Select, Switch } from '@/components/ui/inputs';
import { SectionLabel } from '@/components/ui/section-label';
import { Cell, Row, Table } from '@/components/ui/table';
import { send, useApplications, useGroups, useScimTarget, useScimTargets, useWrite } from '@/lib/api';

const STATE: Record<ScimTargetState, { label: string; tone: Tone }> = {
  in_sync: { label: 'In sync', tone: 'success' },
  pushing: { label: 'Pushing', tone: 'accent' },
  failing: { label: 'Failing', tone: 'danger' },
  disabled: { label: 'Off', tone: 'muted' },
};
const MODE: Record<GroupsMode, { label: string; hint: string }> = {
  groups: {
    label: 'As SCIM groups',
    hint: 'The assigned groups are pushed with their members (Landflow, Clickland). The application maps them to roles.',
  },
  user_attribute: {
    label: 'On each person',
    hint: 'Each person’s assigned groups go as their `groups`; no groups are pushed (Landfall: it picks a role from them).',
  },
};

/**
 * Provisioning out (spec 006): the SCIM servers Landbright keeps in step. Every change in the directory reaches them
 * within seconds through the worker's loop, retried until it lands; deactivating a person sets them inactive there,
 * which signs them out.
 */
export function ProvisioningPage() {
  const targets = useScimTargets();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const items = targets.data?.items ?? [];
  const add = (
    <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
      <Plus className="size-3.5" /> Add target
    </Button>
  );
  return (
    <>
      <PageHeader
        title="Provisioning"
        meta={targets.data && <span>{items.length === 1 ? '1 target' : `${items.length} targets`}</span>}
        actions={add}
      />
      <PageBody className="flex max-w-[1180px] flex-col gap-4">
        {items.length ? (
          <Table head={['Application', 'Groups assigned', 'Pushed', 'State', 'Last push']}>
            {items.map((t) => (
              <Row key={t.id} onClick={() => navigate(`/provisioning/${t.id}`)} testId={`target-${t.name}`}>
                <Cell>
                  <div className="font-medium text-t1">{t.name}</div>
                  <div className="max-w-[320px] truncate font-mono text-[11px] text-t3" title={t.baseUrl}>
                    {t.baseUrl}
                  </div>
                </Cell>
                <Cell>
                  <div className="flex max-w-[280px] flex-wrap gap-1">
                    {t.groups.map((g) => (
                      <Chip key={g.id}>{g.name}</Chip>
                    ))}
                    {!t.groups.length && <span className="text-[12px] text-t3">None: nobody is pushed</span>}
                  </div>
                  <div className="mt-0.5 text-[11px] text-t3">{MODE[t.groupsMode].label}</div>
                </Cell>
                <Cell className="whitespace-nowrap text-[12px] text-t2">
                  {t.counts.active} active
                  {t.counts.inactive > 0 && <span className="text-t3"> · {t.counts.inactive} inactive</span>}
                  {t.groupsMode === 'groups' && <span className="text-t3"> · {t.counts.groups} groups</span>}
                </Cell>
                <Cell>
                  <TargetState target={t} />
                </Cell>
                <Cell className="whitespace-nowrap font-mono text-[12px] text-t3">
                  {t.lastSuccessAt ? formatTime(t.lastSuccessAt) : 'Not yet'}
                </Cell>
              </Row>
            ))}
          </Table>
        ) : (
          <ListState
            loading={targets.isLoading}
            error={targets.error}
            icon={<RefreshCcw className="size-5" strokeWidth={1.7} />}
            empty="No provisioning targets"
            emptyHint="Connect an application’s SCIM server (Landflow: Settings → Security → SCIM) and assign the groups whose people it should hold."
            action={add}
          />
        )}
      </PageBody>
      {adding && <TargetDialog onClose={() => setAdding(false)} />}
    </>
  );
}

function TargetState({ target }: { target: ScimTarget }) {
  const s = STATE[target.state];
  return (
    <div className="flex flex-col gap-0.5">
      <span>
        <Badge tone={s.tone}>{s.label}</Badge>
        {target.queued > 0 && target.state !== 'failing' && (
          <span className="ml-1.5 text-[11px] text-t3">{target.queued} queued</span>
        )}
      </span>
      {target.state === 'failing' && (
        <span className="max-w-[260px] truncate text-[11px] text-rd" title={target.lastError ?? undefined}>
          {target.failing} failing: {target.lastError}
        </span>
      )}
    </div>
  );
}

export function ProvisioningTargetPage() {
  const { id = '' } = useParams();
  const target = useScimTarget(id);
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tested, setTested] = useState<ScimTestResult>();
  const sync = useWrite(() => send('POST', `/api/provisioning/targets/${id}/sync`, {}, ScimTargetDetail));
  const test = useWrite(() => send('POST', `/api/provisioning/targets/${id}/test`, {}, ScimTestResult));
  const remove = useWrite(() => send('DELETE', `/api/provisioning/targets/${id}`));
  const toggle = useWrite((disabled: boolean) =>
    send('PATCH', `/api/provisioning/targets/${id}`, { disabled }, ScimTargetDetail),
  );
  const t = target.data;
  if (!t)
    return (
      <>
        <PageHeader title="Provisioning target" />
        <PageBody>
          <Card>
            {target.isLoading ? (
              <p className="py-8 text-center text-[13px] text-t3">Loading…</p>
            ) : (
              <EmptyState
                title="No such target"
                hint={
                  <Link to="/provisioning" className="underline">
                    Back to Provisioning
                  </Link>
                }
              />
            )}
          </Card>
        </PageBody>
      </>
    );
  const people = t.links.filter((l) => l.kind === 'user');
  const groups = t.links.filter((l) => l.kind === 'group');
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to="/provisioning" aria-label="Back to Provisioning" className="text-t3 hover:text-t1">
              <ArrowLeft className="size-4" />
            </Link>
            {t.name}
          </span>
        }
        meta={<TargetState target={t} />}
        actions={
          <>
            <Switch checked={!t.disabled} onChange={(on) => toggle.mutate(!on)} label="Push" />
            <Button
              size="sm"
              loading={test.isPending}
              onClick={() => test.mutate(undefined, { onSuccess: setTested, onError: (e) => toast.error(e.message) })}
            >
              <Stethoscope className="size-3.5" /> Test
            </Button>
            <Button
              size="sm"
              loading={sync.isPending}
              onClick={() =>
                sync.mutate(undefined, {
                  onSuccess: () => toast.success('Comparing everything with the application now.'),
                  onError: (e) => toast.error(e.message),
                })
              }
            >
              <RotateCw className="size-3.5" /> Sync now
            </Button>
            <Button size="sm" onClick={() => setToken(true)}>
              <KeyRound className="size-3.5" /> Token
            </Button>
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </>
        }
      />
      <PageBody className="flex max-w-[1180px] flex-col gap-5">
        {tested && (
          <Card className={tested.ok ? 'border-gn/40' : 'border-rd/40'}>
            <p className="text-[13px] text-t1" data-testid="scim-test">
              <Badge tone={tested.ok ? 'success' : 'danger'}>{tested.ok ? 'Works' : 'Doesn’t work'}</Badge>{' '}
              {tested.detail}
              {tested.status !== null && (
                <span className="ml-1 font-mono text-[12px] text-t3">HTTP {tested.status}</span>
              )}
            </p>
          </Card>
        )}
        <Card>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
            <Fact label="SCIM base">
              <span className="break-all font-mono text-[12px]">{t.baseUrl}</span>
            </Fact>
            <Fact label="Groups">{MODE[t.groupsMode].label}</Fact>
            <Fact label="Application">{t.application ? t.application.name : '—'}</Fact>
            <Fact label="Compared">{t.lastReconciledAt ? formatTime(t.lastReconciledAt) : 'Due now'}</Fact>
            <div className="col-span-2 md:col-span-4">
              <Fact label="Assigned groups">
                <span className="flex flex-wrap gap-1">
                  {t.groups.map((g) => (
                    <Link key={g.id} to={`/groups/${g.id}`}>
                      <Chip>{g.name}</Chip>
                    </Link>
                  ))}
                  {!t.groups.length && <span className="text-t3">None</span>}
                </span>
              </Fact>
            </div>
          </dl>
        </Card>

        {t.jobs.length > 0 && (
          <section className="flex flex-col gap-2">
            <SectionLabel>Queued</SectionLabel>
            <Table head={['', 'Kind', 'Tries', 'Next try', 'Last error']}>
              {t.jobs.map((j) => (
                <Row key={`${j.kind}:${j.localId}`}>
                  <Cell className="text-t1">
                    {j.name ?? <span className="font-mono text-[12px]">{j.localId}</span>}
                  </Cell>
                  <Cell>
                    <Chip>{j.kind === 'user' ? 'person' : 'group'}</Chip>
                    {j.verify && <span className="ml-1.5 text-[11px] text-t3">compare</span>}
                  </Cell>
                  <Cell className="text-[12px] text-t2">{j.attempts}</Cell>
                  <Cell className="whitespace-nowrap font-mono text-[12px] text-t3">{formatTime(j.nextAttemptAt)}</Cell>
                  <Cell className="max-w-[420px] text-[12px] text-rd">
                    <div className="truncate" title={j.lastError ?? undefined}>
                      {j.lastError}
                    </div>
                  </Cell>
                </Row>
              ))}
            </Table>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <SectionLabel>People there ({people.length})</SectionLabel>
          {people.length ? (
            <Table head={['Person', 'Their id there', 'There', 'Pushed']}>
              {people.map((l) => (
                <Row key={l.localId} testId={`pushed-${l.email}`}>
                  <Cell>
                    <Link to={`/people/${l.localId}`} className="text-t1 hover:underline">
                      {l.name ?? l.email}
                    </Link>
                    <div className="text-[12px] text-t3">{l.email}</div>
                  </Cell>
                  <Cell className="font-mono text-[12px] text-t2">{l.remoteId}</Cell>
                  <Cell>
                    <Badge tone={l.active ? 'success' : 'muted'}>{l.active ? 'Active' : 'Inactive'}</Badge>
                  </Cell>
                  <Cell className="whitespace-nowrap font-mono text-[12px] text-t3">{formatTime(l.syncedAt)}</Cell>
                </Row>
              ))}
            </Table>
          ) : (
            <Card>
              <p className="py-4 text-center text-[13px] text-t3">Nobody pushed yet.</p>
            </Card>
          )}
        </section>

        {t.groupsMode === 'groups' && (
          <section className="flex flex-col gap-2">
            <SectionLabel>Groups there ({groups.length})</SectionLabel>
            {groups.length ? (
              <Table head={['Group', 'Its id there', 'Members there', 'Pushed']}>
                {groups.map((l) => (
                  <Row key={l.localId}>
                    <Cell className="text-t1">{l.name}</Cell>
                    <Cell className="font-mono text-[12px] text-t2">{l.remoteId}</Cell>
                    <Cell className="text-[12px] text-t2">{l.members}</Cell>
                    <Cell className="whitespace-nowrap font-mono text-[12px] text-t3">{formatTime(l.syncedAt)}</Cell>
                  </Row>
                ))}
              </Table>
            ) : (
              <Card>
                <p className="py-4 text-center text-[13px] text-t3">No groups pushed yet.</p>
              </Card>
            )}
          </section>
        )}
      </PageBody>
      {editing && <TargetDialog target={t} onClose={() => setEditing(false)} />}
      {token && <TokenDialog target={t} onClose={() => setToken(false)} />}
      {confirmDelete && (
        <Dialog
          title={`Delete ${t.name}?`}
          subtitle="The application keeps its people and groups as they are; Landbright stops keeping them in step."
          onClose={() => setConfirmDelete(false)}
          onSubmit={() => remove.mutate(undefined, { onSuccess: () => navigate('/provisioning') })}
          footer={
            <>
              <Button type="button" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="danger" loading={remove.isPending}>
                Delete target
              </Button>
            </>
          }
        >
          <FormError error={remove.error} />
        </Dialog>
      )}
    </>
  );
}

function TargetDialog({ target, onClose }: { target?: ScimTargetDetail; onClose: () => void }) {
  const groups = useGroups();
  const applications = useApplications();
  const navigate = useNavigate();
  const [f, setF] = useState({
    name: target?.name ?? '',
    baseUrl: target?.baseUrl ?? '',
    token: '',
    groupsMode: (target?.groupsMode ?? 'groups') as GroupsMode,
    groupIds: target?.groups.map((g) => g.id) ?? ([] as string[]),
    applicationId: target?.application?.id ?? '',
  });
  const save = useWrite(() =>
    target
      ? send(
          'PATCH',
          `/api/provisioning/targets/${target.id}`,
          {
            name: f.name,
            baseUrl: f.baseUrl,
            groupsMode: f.groupsMode,
            groupIds: f.groupIds,
            applicationId: f.applicationId || null,
          },
          ScimTargetDetail,
        )
      : send(
          'POST',
          '/api/provisioning/targets',
          { ...f, applicationId: f.applicationId || undefined },
          ScimTargetDetail,
        ),
  );
  return (
    <Dialog
      title={target ? `Edit ${target.name}` : 'Add a provisioning target'}
      subtitle="An application’s SCIM 2.0 server. Landbright pushes the active people in the groups you assign."
      width={640}
      onClose={onClose}
      onSubmit={() =>
        save.mutate(undefined, {
          onSuccess: (saved) => {
            onClose();
            if (!target) navigate(`/provisioning/${saved.id}`);
          },
        })
      }
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {target ? 'Save' : 'Add target'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <Input
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
              required
              autoFocus
              placeholder="Landflow"
            />
          </Field>
          <Field label="Application" hint="The OIDC application it belongs to.">
            <Select value={f.applicationId} onChange={(e) => setF({ ...f, applicationId: e.target.value })}>
              <option value="">None</option>
              {(applications.data?.items ?? [])
                .filter((a) => !a.system && !a.agentId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <Field label="SCIM base URL" hint="Users and Groups are under it.">
          <Input
            value={f.baseUrl}
            onChange={(e) => setF({ ...f, baseUrl: e.target.value })}
            required
            className="font-mono text-[12px]"
            placeholder="http://localhost:57300/scim/v2"
          />
        </Field>
        {!target && (
          <Field
            label="Bearer token"
            hint="The token the application gave Landbright. Kept encrypted; never shown again."
          >
            <Input
              type="password"
              value={f.token}
              onChange={(e) => setF({ ...f, token: e.target.value })}
              required
              autoComplete="off"
              className="font-mono text-[12px]"
            />
          </Field>
        )}
        <Field label="Assigned groups" hint="Their active members are pushed. Everyone else there is set inactive.">
          <PickMany
            options={(groups.data?.items ?? []).map((g) => ({ value: g.id, label: g.name }))}
            value={f.groupIds}
            onChange={(v) => setF({ ...f, groupIds: v })}
            empty="No groups yet."
          />
        </Field>
        <Field label="Groups go" hint={MODE[f.groupsMode].hint}>
          <Select value={f.groupsMode} onChange={(e) => setF({ ...f, groupsMode: e.target.value as GroupsMode })}>
            {GROUPS_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE[m].label}
              </option>
            ))}
          </Select>
        </Field>
        <FormError error={save.error} />
      </div>
    </Dialog>
  );
}

function TokenDialog({ target, onClose }: { target: ScimTargetDetail; onClose: () => void }) {
  const [token, setToken] = useState('');
  const save = useWrite(() => send('PUT', `/api/provisioning/targets/${target.id}/token`, { token }, ScimTargetDetail));
  return (
    <Dialog
      title={`${target.name}: token`}
      subtitle="The new token replaces the old one at once. What was failing is tried again."
      onClose={onClose}
      onSubmit={() => save.mutate(undefined, { onSuccess: () => (toast.success('Token replaced.'), onClose()) })}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Replace token
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Field label="Bearer token">
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            autoFocus
            autoComplete="off"
            className="font-mono text-[12px]"
          />
        </Field>
        <FormError error={save.error} />
      </div>
    </Dialog>
  );
}
