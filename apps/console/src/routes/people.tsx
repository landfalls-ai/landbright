import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Plus, Users } from 'lucide-react';
import { Person } from '@landbright/contracts';
import { formatDate, ListState, StatusBadge } from '@/components/directory/bits';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge, Chip } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, FormError } from '@/components/ui/dialog';
import { Field, Input, PickMany, Select, Switch } from '@/components/ui/inputs';
import { Cell, Row, Table } from '@/components/ui/table';
import { send, useGroups, usePeople, useWrite } from '@/lib/api';

/** Everyone in the directory. Wave 3 fills it from HiBob and Shapes; until then administrators add people here. */
export function PeoplePage() {
  const people = usePeople();
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();
  const items = people.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="People"
        meta={people.data && <span>{items.length} in the directory</span>}
        actions={
          <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" /> Add person
          </Button>
        }
      />
      <PageBody className="max-w-[1180px]">
        {items.length ? (
          <Table head={['Name', 'Department', 'Groups', 'Sign-in', 'Status', 'Added']}>
            {items.map((p) => (
              <Row key={p.id} onClick={() => navigate(`/people/${p.id}`)} testId={`person-${p.email}`}>
                <Cell>
                  <div className="font-medium text-t1">{p.displayName}</div>
                  <div className="text-[12px] text-t3">{p.email}</div>
                </Cell>
                <Cell className="text-t2">{[p.department, p.title].filter(Boolean).join(' · ') || '—'}</Cell>
                <Cell>
                  <div className="flex max-w-[320px] flex-wrap gap-1">
                    {p.groups.length ? (
                      p.groups.map((g) => <Chip key={g.id}>{g.name}</Chip>)
                    ) : (
                      <span className="text-t3">—</span>
                    )}
                  </div>
                </Cell>
                <Cell>
                  {p.hasPassword ? <Badge tone="neutral">Password</Badge> : <Badge tone="warning">Invited</Badge>}
                </Cell>
                <Cell>
                  <StatusBadge status={p.status} />
                </Cell>
                <Cell className="whitespace-nowrap text-t3">{formatDate(p.createdAt)}</Cell>
              </Row>
            ))}
          </Table>
        ) : (
          <ListState
            loading={people.isLoading}
            error={people.error}
            icon={<Users className="size-5" strokeWidth={1.7} />}
            empty="No one here yet"
            emptyHint="Add a person and they get an email to set a password. In wave 3 HiBob and Shapes add joiners for you."
            action={
              <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
                <Plus className="size-3.5" /> Add person
              </Button>
            }
          />
        )}
      </PageBody>
      {adding && <AddPersonDialog onClose={() => setAdding(false)} onAdded={(p) => navigate(`/people/${p.id}`)} />}
    </>
  );
}

function AddPersonDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (p: Person) => void }) {
  const groups = useGroups();
  const people = usePeople();
  const [form, setForm] = useState({
    givenName: '',
    familyName: '',
    email: '',
    department: '',
    title: '',
    managerId: '',
  });
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [sendInvite, setSendInvite] = useState(true);
  const create = useWrite(() =>
    send(
      'POST',
      '/api/people',
      {
        givenName: form.givenName,
        familyName: form.familyName,
        email: form.email,
        department: form.department || undefined,
        title: form.title || undefined,
        managerId: form.managerId || undefined,
        groupIds,
        sendInvite,
      },
      Person,
    ),
  );
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });
  return (
    <Dialog
      title="Add a person"
      subtitle="They get an email with a link to set their password."
      onClose={onClose}
      onSubmit={() => create.mutate(undefined, { onSuccess: onAdded })}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Add person
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
        <Field label="Work email">
          <Input type="email" value={form.email} onChange={set('email')} required placeholder="maya@example.com" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Department">
            <Input value={form.department} onChange={set('department')} />
          </Field>
          <Field label="Title">
            <Input value={form.title} onChange={set('title')} />
          </Field>
        </div>
        <Field label="Manager">
          <Select value={form.managerId} onChange={set('managerId')}>
            <option value="">No manager</option>
            {people.data?.items
              .filter((p) => p.status === 'active')
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName} ({p.email})
                </option>
              ))}
          </Select>
        </Field>
        <div>
          <div className="mb-[5px] text-[12px] font-semibold text-t2">Groups</div>
          <PickMany
            options={(groups.data?.items ?? []).map((g) => ({ value: g.id, label: g.name }))}
            value={groupIds}
            onChange={setGroupIds}
            empty="No groups yet. Create them on the Groups page."
          />
          <p className="mt-1 text-[12px] text-t3">
            Applications see group names in the roles claim (Landflow maps them to roles).
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Switch checked={sendInvite} onChange={setSendInvite} label="Email an invite" />
          <span className="text-[13px] text-t2">Email an invite to set a password</span>
        </div>
        <FormError error={create.error} />
      </div>
    </Dialog>
  );
}
