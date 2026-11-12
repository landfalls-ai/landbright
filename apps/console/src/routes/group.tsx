import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, ShieldCheck, Trash2, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { GroupDetail } from '@landbright/contracts';
import { formatDate, StatusBadge } from '@/components/directory/bits';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge, Chip } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, FormError } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/inputs';
import { Cell, Row, Table } from '@/components/ui/table';
import { send, useAgents, useGroup, usePeople, useWrite } from '@/lib/api';
import { KIND_LABEL } from './groups';

export function GroupPage() {
  const { id = '' } = useParams();
  const group = useGroup(id);
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const removeMember = useWrite((identityId: string) =>
    send('DELETE', `/api/groups/${id}/members/${identityId}`, undefined, GroupDetail),
  );
  const remove = useWrite(() => send('DELETE', `/api/groups/${id}`));

  const g = group.data;
  if (!g) {
    return (
      <>
        <PageHeader title="Group" />
        <PageBody>
          <Card>
            {group.isLoading ? (
              <p className="py-8 text-center text-[13px] text-t3">Loading…</p>
            ) : (
              <EmptyState
                title="No such group"
                hint={
                  <Link to="/groups" className="underline">
                    Back to Groups
                  </Link>
                }
              />
            )}
          </Card>
        </PageBody>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to="/groups" aria-label="Back to Groups" className="text-t3 hover:text-t1">
              <ArrowLeft className="size-4" />
            </Link>
            {g.name}
          </span>
        }
        meta={<Badge tone={g.kind === 'static' ? 'neutral' : 'accent'}>{KIND_LABEL[g.kind]}</Badge>}
        actions={
          <>
            <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
              <UserPlus className="size-3.5" /> Add member
            </Button>
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            {!g.system && (
              <Button size="sm" variant="danger" onClick={() => setDeleting(true)} aria-label="Delete group">
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </>
        }
      />
      <PageBody className="flex max-w-[1080px] flex-col gap-4">
        {(g.description || g.system) && (
          <Card className="flex items-start gap-2.5 text-[13px] text-t2">
            {g.system && <ShieldCheck className="mt-0.5 size-4 shrink-0 text-ac" />}
            <div>
              {g.description}
              {g.system && (
                <p className="mt-1 text-[12px] text-t3">
                  Members administer Landbright through this console. It can’t be renamed or deleted, and always keeps
                  at least one active person.
                </p>
              )}
            </div>
          </Card>
        )}
        {g.members.length ? (
          <Table head={['Member', 'Kind', 'Status', 'Source', 'Added', '']}>
            {g.members.map((m) => (
              <Row key={m.id} testId={`member-${m.email ?? m.displayName}`}>
                <Cell>
                  <div className="font-medium text-t1">
                    {m.kind === 'person' ? (
                      <Link to={`/people/${m.id}`} className="hover:underline">
                        {m.displayName}
                      </Link>
                    ) : (
                      m.displayName
                    )}
                  </div>
                  {m.email && <div className="text-[12px] text-t3">{m.email}</div>}
                </Cell>
                <Cell>
                  <Chip>{m.kind}</Chip>
                </Cell>
                <Cell>
                  <StatusBadge status={m.status} />
                </Cell>
                <Cell className="text-t2">{m.source}</Cell>
                <Cell className="whitespace-nowrap text-t3">{formatDate(m.addedAt)}</Cell>
                <Cell className="text-right">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${m.displayName}`}
                    onClick={() => removeMember.mutate(m.id, { onError: (e) => toast.error(e.message) })}
                  >
                    <X className="size-3.5" />
                  </Button>
                </Cell>
              </Row>
            ))}
          </Table>
        ) : (
          <Card>
            <EmptyState
              title="No members yet"
              hint="Add people or agents; applications see this group in their roles claim at their next sign-in."
            />
          </Card>
        )}
      </PageBody>
      {adding && <AddMemberDialog group={g} onClose={() => setAdding(false)} />}
      {editing && <EditGroupDialog group={g} onClose={() => setEditing(false)} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${g.name}?`}
          action="Delete group"
          busy={remove.isPending}
          message={`Its ${g.memberCount} member${g.memberCount === 1 ? '' : 's'} lose the role at their next sign-in or token refresh. Applications that map “${g.name}” stop seeing it.`}
          onClose={() => setDeleting(false)}
          onConfirm={() =>
            remove.mutate(undefined, { onSuccess: () => navigate('/groups'), onError: (e) => toast.error(e.message) })
          }
        />
      )}
    </>
  );
}

function AddMemberDialog({ group, onClose }: { group: GroupDetail; onClose: () => void }) {
  const people = usePeople();
  const agents = useAgents();
  const [identityId, setIdentityId] = useState('');
  const add = useWrite(() => send('POST', `/api/groups/${group.id}/members`, { identityId }, GroupDetail));
  const inGroup = new Set(group.members.map((m) => m.id));
  const candidates = [
    ...(people.data?.items ?? [])
      .filter((p) => p.status === 'active')
      .map((p) => ({ id: p.id, label: `${p.displayName} (${p.email})`, kind: 'People' })),
    ...(group.system
      ? []
      : (agents.data?.items ?? [])
          .filter((a) => a.status === 'active')
          .map((a) => ({ id: a.id, label: a.displayName, kind: 'Agents' }))),
  ].filter((c) => !inGroup.has(c.id));
  return (
    <Dialog
      title={`Add to ${group.name}`}
      onClose={onClose}
      width={460}
      onSubmit={() => add.mutate(undefined, { onSuccess: onClose })}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={add.isPending} disabled={!identityId}>
            Add
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Field label="Person or agent" hint={group.system ? 'Only people can administer Landbright.' : undefined}>
          <Select value={identityId} onChange={(e) => setIdentityId(e.target.value)} required autoFocus>
            <option value="" disabled>
              {candidates.length ? 'Choose' : 'Everyone is already in this group'}
            </option>
            {['People', 'Agents'].map((kind) => {
              const list = candidates.filter((c) => c.kind === kind);
              return list.length ? (
                <optgroup key={kind} label={kind}>
                  {list.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </Select>
        </Field>
        <FormError error={add.error} />
      </div>
    </Dialog>
  );
}

function EditGroupDialog({ group, onClose }: { group: GroupDetail; onClose: () => void }) {
  const [form, setForm] = useState({ name: group.name, description: group.description ?? '' });
  const save = useWrite(() => send('PATCH', `/api/groups/${group.id}`, form, GroupDetail));
  return (
    <Dialog
      title={`Edit ${group.name}`}
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
        <Field
          label="Name"
          hint={
            group.system
              ? 'The administrators’ group keeps its name.'
              : 'Renaming changes what applications see: update their role maps too.'
          }
        >
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            disabled={group.system}
          />
        </Field>
        <Field label="Description">
          <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <FormError error={save.error} />
      </div>
    </Dialog>
  );
}
