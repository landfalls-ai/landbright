import { useState } from 'react';
import { Boxes, Plus, Workflow } from 'lucide-react';
import { AccessPolicy, Bundle, BundleTarget } from '@landbright/contracts';
import { minutes } from '@/components/access/bits';
import { ListState } from '@/components/directory/bits';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, FormError } from '@/components/ui/dialog';
import { Field, Input, PickMany, Select, Switch, Textarea } from '@/components/ui/inputs';
import { SectionLabel } from '@/components/ui/section-label';
import { Cell, Row, Table } from '@/components/ui/table';
import { send, useBundles, useGroups, useMe, usePeople, useWrite } from '@/lib/api';

/**
 * The catalog: bundles people and agents can request. A bundle gives group memberships (Landbright does that) and
 * targets (a Landflow flow provisions each and reports back); its policy says who may ask, who approves, for how long.
 */
export function CatalogPage() {
  const bundles = useBundles();
  const [editing, setEditing] = useState<Bundle | 'new'>();
  const items = bundles.data?.items ?? [];
  const add = (
    <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
      <Plus className="size-3.5" /> New bundle
    </Button>
  );
  return (
    <>
      <PageHeader
        title="Catalog"
        meta={
          bundles.data && (
            <span>
              {items.length} {items.length === 1 ? 'bundle' : 'bundles'}
            </span>
          )
        }
        actions={add}
      />
      <PageBody className="max-w-[1180px]">
        {items.length ? (
          <Table head={['Bundle', 'Gives', 'Approved by', 'How long', '']}>
            {items.map((b) => (
              <Row key={b.id} onClick={() => setEditing(b)} testId={`bundle-${b.name}`}>
                <Cell>
                  <div className="font-medium text-t1">{b.name}</div>
                  {b.description && <div className="max-w-[340px] truncate text-[12px] text-t3">{b.description}</div>}
                </Cell>
                <Cell>
                  <div className="flex flex-wrap gap-1">
                    {b.groups.map((g) => (
                      <Badge key={g.id} tone="accent">
                        {g.name}
                      </Badge>
                    ))}
                    {b.targets.map((t) => (
                      <Badge key={t.key} title={`${t.type} · ${t.key}`}>
                        <Workflow className="size-3" /> {t.label}
                      </Badge>
                    ))}
                  </div>
                </Cell>
                <Cell className="text-[12px] text-t2">
                  {b.policy.steps.map((s) => s.name).join(' → ')}
                  {b.policy.autoApprove.length > 0 && (
                    <div className="text-t3">or {b.policy.autoApprove.length} auto-approve rule(s)</div>
                  )}
                </Cell>
                <Cell className="whitespace-nowrap text-[12px] text-t2">
                  {minutes(b.policy.defaultDurationMinutes)}, at most {minutes(b.policy.maxDurationMinutes)}
                </Cell>
                <Cell>
                  {b.disabled ? (
                    <Badge tone="muted">Off</Badge>
                  ) : b.policy.breakGlass.allowed ? (
                    <Badge tone="danger">Break-glass</Badge>
                  ) : null}
                </Cell>
              </Row>
            ))}
          </Table>
        ) : (
          <ListState
            loading={bundles.isLoading}
            error={bundles.error}
            icon={<Boxes className="size-5" strokeWidth={1.7} />}
            empty="No bundles yet"
            emptyHint="A bundle is what people ask for: groups, and targets a Landflow flow provisions."
            action={add}
          />
        )}
      </PageBody>
      {editing && (
        <BundleDialog bundle={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} />
      )}
    </>
  );
}

const EXAMPLE_TARGETS = `[
  {
    "key": "landflow:payments-editor",
    "type": "landflow-project-role",
    "label": "Landflow project Payments, editor",
    "config": { "project": "prj_…", "role": "editor" }
  }
]`;

function BundleDialog({ bundle, onClose }: { bundle?: Bundle; onClose: () => void }) {
  const me = useMe();
  const groups = useGroups();
  const people = usePeople();
  const policy = bundle?.policy ?? AccessPolicy.parse({});
  const step = policy.steps[0]!;
  const [f, setF] = useState({
    name: bundle?.name ?? '',
    description: bundle?.description ?? '',
    ownerId: bundle?.owner?.id ?? me.data?.id ?? '',
    groupIds: bundle?.groups.map((g) => g.id) ?? [],
    targets: bundle?.targets.length ? JSON.stringify(bundle.targets, null, 2) : '',
    approverGroupIds: step.approvers.groupIds,
    manager: step.approvers.manager,
    bundleOwner: step.approvers.bundleOwner,
    approvalsRequired: step.approvalsRequired,
    eligibleGroupIds: policy.eligibleGroupIds,
    defaultDuration: policy.defaultDurationMinutes,
    maxDuration: policy.maxDurationMinutes,
    deadline: policy.decisionDeadlineMinutes,
    reason: policy.reason.mode,
    ticket: policy.ticket.mode,
    ticketPattern: policy.ticket.pattern ?? '',
    agentsAllowed: policy.agentsAllowed,
    breakGlass: policy.breakGlass.allowed,
    disabled: bundle?.disabled ?? false,
  });
  const [targetError, setTargetError] = useState<string>();
  const groupNames = (ids: string[]) =>
    ids
      .map((id) => groups.data?.items.find((g) => g.id === id)?.name)
      .filter(Boolean)
      .join(', ');
  const save = useWrite(async () => {
    let targets: BundleTarget[] = [];
    if (f.targets.trim()) {
      const parsed = BundleTarget.array().safeParse(JSON.parse(f.targets));
      if (!parsed.success) throw new Error(`Targets: ${parsed.error.issues[0]?.message ?? 'not valid'}`);
      targets = parsed.data;
    }
    const body = {
      name: f.name,
      description: f.description || undefined,
      ownerId: f.ownerId || null,
      groupIds: f.groupIds,
      targets,
      disabled: f.disabled,
      policy: {
        ...policy,
        eligibleGroupIds: f.eligibleGroupIds,
        agentsAllowed: f.agentsAllowed,
        steps: [
          {
            ...step,
            name: step.name === 'Approval' && f.approverGroupIds.length ? groupNames(f.approverGroupIds) : step.name,
            approvers: {
              ...step.approvers,
              groupIds: f.approverGroupIds,
              manager: f.manager,
              bundleOwner: f.bundleOwner,
            },
            approvalsRequired: f.approvalsRequired,
          },
          ...policy.steps.slice(1),
        ],
        defaultDurationMinutes: f.defaultDuration,
        maxDurationMinutes: f.maxDuration,
        decisionDeadlineMinutes: f.deadline,
        reason: { ...policy.reason, mode: f.reason },
        ticket: { ...policy.ticket, mode: f.ticket, pattern: f.ticketPattern || undefined },
        breakGlass: { ...policy.breakGlass, allowed: f.breakGlass },
      },
    };
    return bundle
      ? send('PATCH', `/api/bundles/${bundle.id}`, body, Bundle)
      : send('POST', '/api/bundles', body, Bundle);
  });
  const groupOptions = (groups.data?.items ?? []).map((g) => ({ value: g.id, label: g.name }));
  const num =
    (key: 'defaultDuration' | 'maxDuration' | 'deadline' | 'approvalsRequired') => (e: { target: { value: string } }) =>
      setF({ ...f, [key]: Number(e.target.value) });
  return (
    <Dialog
      title={bundle ? bundle.name : 'New bundle'}
      subtitle={bundle ? 'Changes apply to requests made from now on.' : undefined}
      onClose={onClose}
      width={680}
      onSubmit={() => {
        setTargetError(undefined);
        save.mutate(undefined, { onSuccess: onClose, onError: (e) => setTargetError(e.message) });
      }}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {bundle ? 'Save' : 'Create bundle'}
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
              placeholder="Landflow Editors (JIT)"
            />
          </Field>
          <Field label="Owner" hint="Approves when the step names nobody else.">
            <Select value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })}>
              <option value="">Nobody</option>
              {people.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Description">
          <Input
            value={f.description}
            onChange={(e) => setF({ ...f, description: e.target.value })}
            placeholder="What it lets you do"
          />
        </Field>

        <SectionLabel className="mt-1">What it gives</SectionLabel>
        <Field
          label="Groups"
          hint="Landbright adds the holder to these groups for the grant, and removes them at the end."
        >
          <PickMany
            options={groupOptions}
            value={f.groupIds}
            onChange={(v) => setF({ ...f, groupIds: v })}
            empty="No groups yet."
          />
        </Field>
        <Field
          label="Targets (JSON)"
          hint="Each is provisioned by a Landflow flow subscribed to grant.activated, which reports back on /api/v1/grants/{id}/targets/{key}."
        >
          <Textarea
            rows={5}
            className="font-mono text-[12px]"
            value={f.targets}
            onChange={(e) => setF({ ...f, targets: e.target.value })}
            placeholder={EXAMPLE_TARGETS}
          />
        </Field>

        <SectionLabel className="mt-1">Who may ask</SectionLabel>
        <Field label="Standing members of" hint="None picked: every active person.">
          <PickMany
            options={groupOptions}
            value={f.eligibleGroupIds}
            onChange={(v) => setF({ ...f, eligibleGroupIds: v })}
          />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Reason">
            <Select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value as typeof f.reason })}>
              <option value="required">Required</option>
              <option value="optional">Optional</option>
            </Select>
          </Field>
          <Field label="Ticket">
            <Select value={f.ticket} onChange={(e) => setF({ ...f, ticket: e.target.value as typeof f.ticket })}>
              <option value="off">Not asked</option>
              <option value="optional">Optional</option>
              <option value="required">Required</option>
            </Select>
          </Field>
          <Field label="Ticket pattern">
            <Input
              value={f.ticketPattern}
              onChange={(e) => setF({ ...f, ticketPattern: e.target.value })}
              placeholder="^OPS-\d+$"
              disabled={f.ticket === 'off'}
            />
          </Field>
        </div>

        <SectionLabel className="mt-1">Who approves</SectionLabel>
        <Field
          label="Standing members of"
          hint="Nobody approves their own request; a membership a grant gave doesn’t count."
        >
          <PickMany
            options={groupOptions}
            value={f.approverGroupIds}
            onChange={(v) => setF({ ...f, approverGroupIds: v })}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-5 text-[13px] text-t2">
          <label className="flex items-center gap-2">
            <Switch checked={f.manager} onChange={(v) => setF({ ...f, manager: v })} label="Their manager" /> Their
            manager
          </label>
          <label className="flex items-center gap-2">
            <Switch
              checked={f.bundleOwner}
              onChange={(v) => setF({ ...f, bundleOwner: v })}
              label="The bundle’s owner"
            />{' '}
            The bundle’s owner
          </label>
          <label className="flex items-center gap-2">
            Approvals needed
            <Input
              type="number"
              min={1}
              max={5}
              className="w-16"
              value={f.approvalsRequired}
              onChange={num('approvalsRequired')}
            />
          </label>
        </div>

        <SectionLabel className="mt-1">How long (minutes)</SectionLabel>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Default">
            <Input type="number" min={1} value={f.defaultDuration} onChange={num('defaultDuration')} />
          </Field>
          <Field label="At most">
            <Input type="number" min={1} value={f.maxDuration} onChange={num('maxDuration')} />
          </Field>
          <Field label="Decide within">
            <Input type="number" min={1} value={f.deadline} onChange={num('deadline')} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-5 text-[13px] text-t2">
          <label className="flex items-center gap-2">
            <Switch checked={f.agentsAllowed} onChange={(v) => setF({ ...f, agentsAllowed: v })} label="Agents" />{' '}
            Sponsors may ask for their agents
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={f.breakGlass} onChange={(v) => setF({ ...f, breakGlass: v })} label="Break-glass" />{' '}
            Break-glass
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={f.disabled} onChange={(v) => setF({ ...f, disabled: v })} label="Off" /> Off
          </label>
        </div>
        <p className="text-[12px] text-t3">
          More steps, auto-approve rules and escalation: PATCH /api/bundles/{'{id}'} (docs/access.md). This form keeps
          them.
        </p>
        <FormError error={targetError ? new Error(targetError) : null} />
      </div>
    </Dialog>
  );
}
