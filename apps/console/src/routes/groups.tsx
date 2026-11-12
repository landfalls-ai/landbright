import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Plus, ShieldCheck, UsersRound } from 'lucide-react';
import { GroupDetail, type GroupKind } from '@landbright/contracts';
import { ListState } from '@/components/directory/bits';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, FormError } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/inputs';
import { Cell, Row, Table } from '@/components/ui/table';
import { send, useGroups, useWrite } from '@/lib/api';

export const KIND_LABEL: Record<GroupKind, string> = {
  static: 'Static',
  birthright: 'Birthright',
  jit: 'Just in time',
};

/** Groups: what applications see as roles. Landflow maps their names with LANDFLOW_OIDC_ROLE_MAP. */
export function GroupsPage() {
  const groups = useGroups();
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();
  const items = groups.data?.items ?? [];
  const add = (
    <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
      <Plus className="size-3.5" /> New group
    </Button>
  );
  return (
    <>
      <PageHeader
        title="Groups"
        meta={
          groups.data && (
            <span>
              {items.length} {items.length === 1 ? 'group' : 'groups'}
            </span>
          )
        }
        actions={add}
      />
      <PageBody className="max-w-[1080px]">
        {items.length ? (
          <Table head={['Group', 'Kind', 'Members']}>
            {items.map((g) => (
              <Row key={g.id} onClick={() => navigate(`/groups/${g.id}`)} testId={`group-${g.name}`}>
                <Cell>
                  <div className="flex items-center gap-2 font-medium text-t1">
                    {g.system && <ShieldCheck className="size-3.5 text-ac" aria-label="Landbright’s administrators" />}
                    {g.name}
                  </div>
                  {g.description && <div className="text-[12px] text-t3">{g.description}</div>}
                </Cell>
                <Cell>
                  <Badge tone={g.kind === 'static' ? 'neutral' : 'accent'}>{KIND_LABEL[g.kind]}</Badge>
                </Cell>
                <Cell className="font-mono text-[12px] text-t2">{g.memberCount}</Cell>
              </Row>
            ))}
          </Table>
        ) : (
          <ListState
            loading={groups.isLoading}
            error={groups.error}
            icon={<UsersRound className="size-5" strokeWidth={1.7} />}
            empty="No groups yet"
            action={add}
          />
        )}
      </PageBody>
      {adding && <NewGroupDialog onClose={() => setAdding(false)} onCreated={(g) => navigate(`/groups/${g.id}`)} />}
    </>
  );
}

function NewGroupDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (g: GroupDetail) => void }) {
  const [form, setForm] = useState({ name: '', description: '', kind: 'static' });
  const create = useWrite(() =>
    send('POST', '/api/groups', { ...form, description: form.description || undefined }, GroupDetail),
  );
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });
  return (
    <Dialog
      title="New group"
      onClose={onClose}
      onSubmit={() => create.mutate(undefined, { onSuccess: onCreated })}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create group
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Field label="Name" hint="Applications see this name. Keep it stable: Landflow’s role map refers to it.">
          <Input value={form.name} onChange={set('name')} required autoFocus placeholder="Landflow Editors" />
        </Field>
        <Field label="Description">
          <Input value={form.description} onChange={set('description')} placeholder="Optional" />
        </Field>
        <Field
          label="Kind"
          hint="Birthright groups are given by HR rules (wave 3); just-in-time groups hold time-boxed grants (wave 4)."
        >
          <Select value={form.kind} onChange={set('kind')}>
            {Object.entries(KIND_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <FormError error={create.error} />
      </div>
    </Dialog>
  );
}
