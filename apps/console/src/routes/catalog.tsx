import { useState } from 'react';
import { Boxes, Plus, Trash2, Workflow } from 'lucide-react';
import { AccessPolicy, ApprovalStep, AutoApproveRule, Bundle, BundleTarget, TimeWindow } from '@landbright/contracts';
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

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
type Option = { value: string; label: string };

/**
 * A bundle and its whole policy: what it gives, who may ask, each approval step, auto-approve rules (with hours),
 * escalation, extensions, agents, break-glass.
 */
function BundleDialog({ bundle, onClose }: { bundle?: Bundle; onClose: () => void }) {
  const me = useMe();
  const groups = useGroups();
  const people = usePeople();
  const [f, setF] = useState({
    name: bundle?.name ?? '',
    description: bundle?.description ?? '',
    ownerId: bundle?.owner?.id ?? me.data?.id ?? '',
    groupIds: bundle?.groups.map((g) => g.id) ?? [],
    targets: bundle?.targets.length ? JSON.stringify(bundle.targets, null, 2) : '',
    disabled: bundle?.disabled ?? false,
  });
  const [p, setP] = useState<AccessPolicy>(bundle?.policy ?? AccessPolicy.parse({}));
  const [targetError, setTargetError] = useState<string>();
  const groupOptions: Option[] = (groups.data?.items ?? []).map((g) => ({ value: g.id, label: g.name }));
  const peopleOptions: Option[] = (people.data?.items ?? []).map((x) => ({ value: x.id, label: x.displayName }));
  const set = <K extends keyof AccessPolicy>(key: K, value: AccessPolicy[K]) => setP({ ...p, [key]: value });
  const setStep = (i: number, step: ApprovalStep) =>
    set(
      'steps',
      p.steps.map((s, j) => (j === i ? step : s)),
    );
  const setRule = (i: number, rule: AutoApproveRule) =>
    set(
      'autoApprove',
      p.autoApprove.map((r, j) => (j === i ? rule : r)),
    );
  const n = (v: string) => Math.max(1, Number(v) || 1);

  const save = useWrite(async () => {
    let targets: BundleTarget[] = [];
    if (f.targets.trim()) {
      const parsed = BundleTarget.array().safeParse(JSON.parse(f.targets));
      if (!parsed.success) throw new Error(`Targets: ${parsed.error.issues[0]?.message ?? 'not valid'}`);
      targets = parsed.data;
    }
    const policy = AccessPolicy.safeParse(p);
    if (!policy.success) {
      const issue = policy.error.issues[0];
      throw new Error(`Policy: ${issue?.path.join('.')} ${issue?.message ?? 'not valid'}`);
    }
    const body = {
      name: f.name,
      description: f.description || undefined,
      ownerId: f.ownerId || null,
      groupIds: f.groupIds,
      targets,
      disabled: f.disabled,
      policy: policy.data,
    };
    return bundle
      ? send('PATCH', `/api/bundles/${bundle.id}`, body, Bundle)
      : send('POST', '/api/bundles', body, Bundle);
  });

  return (
    <Dialog
      title={bundle ? bundle.name : 'New bundle'}
      subtitle={bundle ? 'Changes apply to requests made from now on.' : undefined}
      onClose={onClose}
      width={760}
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
          <Field label="Owner" hint="Approves when a step names nobody else.">
            <Select value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })}>
              <option value="">Nobody</option>
              {peopleOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
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
          <PickMany options={groupOptions} value={p.eligibleGroupIds} onChange={(v) => set('eligibleGroupIds', v)} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Reason">
            <Select
              value={p.reason.mode}
              onChange={(e) => set('reason', { ...p.reason, mode: e.target.value as AccessPolicy['reason']['mode'] })}
            >
              <option value="required">Required</option>
              <option value="optional">Optional</option>
            </Select>
          </Field>
          <Field label="Ticket">
            <Select
              value={p.ticket.mode}
              onChange={(e) => set('ticket', { ...p.ticket, mode: e.target.value as AccessPolicy['ticket']['mode'] })}
            >
              <option value="off">Not asked</option>
              <option value="optional">Optional</option>
              <option value="required">Required</option>
            </Select>
          </Field>
          <Field label="Ticket pattern">
            <Input
              value={p.ticket.pattern ?? ''}
              onChange={(e) => set('ticket', { ...p.ticket, pattern: e.target.value || undefined })}
              placeholder="^OPS-\d+$"
              disabled={p.ticket.mode === 'off'}
            />
          </Field>
        </div>

        <SectionLabel className="mt-1">Who approves</SectionLabel>
        <p className="-mt-2 text-[12px] text-t3">
          Steps run in order; each needs its number of approvals. Nobody approves their own request, and a membership a
          grant gave doesn’t make anyone an approver.
        </p>
        {p.steps.map((step, i) => (
          <StepEditor
            key={i}
            index={i}
            step={step}
            groups={groupOptions}
            people={peopleOptions}
            onChange={(s) => setStep(i, s)}
            onRemove={
              p.steps.length > 1
                ? () =>
                    set(
                      'steps',
                      p.steps.filter((_, j) => j !== i),
                    )
                : undefined
            }
          />
        ))}
        {p.steps.length < 3 && (
          <div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="add-step"
              onClick={() => set('steps', [...p.steps, ApprovalStep.parse({ name: `Step ${p.steps.length + 1}` })])}
            >
              <Plus className="size-3.5" /> Add a step
            </Button>
          </div>
        )}
        <Toggle
          checked={!!p.escalation}
          onChange={(on) =>
            set(
              'escalation',
              on ? { afterMinutes: 60, toGroupIds: groupOptions[0] ? [groupOptions[0].value] : [] } : null,
            )
          }
          label="Escalate when nobody decides"
        />
        {p.escalation && (
          <div className="grid grid-cols-[140px_1fr] gap-3 rounded-lg border border-hair px-3 py-2.5">
            <Field label="After (minutes)">
              <Input
                type="number"
                min={1}
                value={p.escalation.afterMinutes}
                onChange={(e) => set('escalation', { ...p.escalation!, afterMinutes: n(e.target.value) })}
              />
            </Field>
            <Field label="Add as approvers the standing members of">
              <PickMany
                options={groupOptions}
                value={p.escalation.toGroupIds}
                onChange={(v) => set('escalation', { ...p.escalation!, toGroupIds: v })}
              />
            </Field>
          </div>
        )}

        <SectionLabel className="mt-1">Approved at once</SectionLabel>
        <p className="-mt-2 text-[12px] text-t3">
          An auto-approve rule only approves, never denies, and its evidence is kept on the request. A request a service
          files for a person always waits for a person.
        </p>
        {p.autoApprove.map((rule, i) => (
          <RuleEditor
            key={i}
            index={i}
            rule={rule}
            groups={groupOptions}
            onChange={(r) => setRule(i, r)}
            onRemove={() =>
              set(
                'autoApprove',
                p.autoApprove.filter((_, j) => j !== i),
              )
            }
          />
        ))}
        {p.autoApprove.length < 10 && (
          <div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="add-rule"
              onClick={() =>
                set('autoApprove', [
                  ...p.autoApprove,
                  AutoApproveRule.parse({ name: `Rule ${p.autoApprove.length + 1}`, maxDurationMinutes: 30 }),
                ])
              }
            >
              <Plus className="size-3.5" /> Add an auto-approve rule
            </Button>
          </div>
        )}

        <SectionLabel className="mt-1">How long (minutes)</SectionLabel>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Default">
            <Input
              type="number"
              min={1}
              value={p.defaultDurationMinutes}
              onChange={(e) => set('defaultDurationMinutes', n(e.target.value))}
            />
          </Field>
          <Field label="At most">
            <Input
              type="number"
              min={1}
              value={p.maxDurationMinutes}
              onChange={(e) => set('maxDurationMinutes', n(e.target.value))}
            />
          </Field>
          <Field label="Decide within">
            <Input
              type="number"
              min={1}
              value={p.decisionDeadlineMinutes}
              onChange={(e) => set('decisionDeadlineMinutes', n(e.target.value))}
            />
          </Field>
        </div>
        <div className="grid grid-cols-3 items-end gap-3">
          <Toggle
            checked={p.extensions.allowed}
            onChange={(v) => set('extensions', { ...p.extensions, allowed: v })}
            label="Holders may ask for more time"
          />
          <Field label="Extensions per grant">
            <Input
              type="number"
              min={0}
              max={10}
              disabled={!p.extensions.allowed}
              value={p.extensions.maxCount}
              onChange={(e) => set('extensions', { ...p.extensions, maxCount: Math.max(0, Number(e.target.value)) })}
            />
          </Field>
          <Field label="Warn before the end">
            <Input
              type="number"
              min={1}
              max={1440}
              value={p.expiringNoticeMinutes}
              onChange={(e) => set('expiringNoticeMinutes', n(e.target.value))}
            />
          </Field>
        </div>

        <SectionLabel className="mt-1">Agents and break-glass</SectionLabel>
        <div className="grid grid-cols-3 items-end gap-3">
          <Toggle
            checked={p.agentsAllowed}
            onChange={(v) => set('agentsAllowed', v)}
            label="Agents may have it (their sponsor, or the agent, asks)"
          />
          <Field label="Agents get at most">
            <Input
              type="number"
              min={1}
              disabled={!p.agentsAllowed}
              value={p.agentMaxDurationMinutes}
              onChange={(e) => set('agentMaxDurationMinutes', n(e.target.value))}
            />
          </Field>
          <div />
        </div>
        <Toggle
          checked={p.breakGlass.allowed}
          onChange={(v) => set('breakGlass', { ...p.breakGlass, allowed: v })}
          label="Break-glass: granted at once, reviewed afterwards"
        />
        {p.breakGlass.allowed && (
          <div className="grid grid-cols-[1fr_120px_120px] gap-3 rounded-lg border border-hair px-3 py-2.5">
            <Field label="Standing members of" hint="None picked: whoever may ask.">
              <PickMany
                options={groupOptions}
                value={p.breakGlass.eligibleGroupIds}
                onChange={(v) => set('breakGlass', { ...p.breakGlass, eligibleGroupIds: v })}
              />
            </Field>
            <Field label="At most (min)">
              <Input
                type="number"
                min={1}
                value={p.breakGlass.maxDurationMinutes}
                onChange={(e) => set('breakGlass', { ...p.breakGlass, maxDurationMinutes: n(e.target.value) })}
              />
            </Field>
            <Field label="Review within (h)">
              <Input
                type="number"
                min={1}
                max={168}
                value={p.breakGlass.reviewWithinHours}
                onChange={(e) => set('breakGlass', { ...p.breakGlass, reviewWithinHours: n(e.target.value) })}
              />
            </Field>
          </div>
        )}
        <Toggle checked={f.disabled} onChange={(v) => setF({ ...f, disabled: v })} label="Off (no new requests)" />
        <FormError error={targetError ? new Error(targetError) : null} />
      </div>
    </Dialog>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 text-[13px] text-t2">
      <Switch checked={checked} onChange={onChange} label={label} /> {label}
    </label>
  );
}

function StepEditor({
  index,
  step,
  groups,
  people,
  onChange,
  onRemove,
}: {
  index: number;
  step: ApprovalStep;
  groups: Option[];
  people: Option[];
  onChange: (s: ApprovalStep) => void;
  onRemove?: () => void;
}) {
  const who = (patch: Partial<ApprovalStep['approvers']>) =>
    onChange({ ...step, approvers: { ...step.approvers, ...patch } });
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-hair px-3 py-2.5" data-testid={`step-${index}`}>
      <div className="grid grid-cols-[1fr_130px_auto] items-end gap-3">
        <Field label={`Step ${index + 1}`}>
          <Input value={step.name} onChange={(e) => onChange({ ...step, name: e.target.value })} required />
        </Field>
        <Field label="Approvals needed">
          <Input
            type="number"
            min={1}
            max={5}
            value={step.approvalsRequired}
            onChange={(e) => onChange({ ...step, approvalsRequired: Math.min(5, Math.max(1, Number(e.target.value))) })}
          />
        </Field>
        {onRemove ? (
          <Button type="button" size="sm" variant="ghost" onClick={onRemove} aria-label={`Remove step ${index + 1}`}>
            <Trash2 className="size-3.5" />
          </Button>
        ) : (
          <span />
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Standing members of">
          <PickMany options={groups} value={step.approvers.groupIds} onChange={(v) => who({ groupIds: v })} />
        </Field>
        <Field label="These people">
          <PickMany options={people} value={step.approvers.identityIds} onChange={(v) => who({ identityIds: v })} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-5">
        <Toggle checked={step.approvers.manager} onChange={(v) => who({ manager: v })} label="Their manager" />
        <Toggle checked={step.approvers.bundleOwner} onChange={(v) => who({ bundleOwner: v })} label="The owner" />
        <Toggle checked={step.approvers.sponsor} onChange={(v) => who({ sponsor: v })} label="An agent’s sponsor" />
        <Toggle
          checked={step.allowRelayed}
          onChange={(v) => onChange({ ...step, allowRelayed: v })}
          label="Votes from chat (Slack)"
        />
      </div>
    </div>
  );
}

function RuleEditor({
  index,
  rule,
  groups,
  onChange,
  onRemove,
}: {
  index: number;
  rule: AutoApproveRule;
  groups: Option[];
  onChange: (r: AutoApproveRule) => void;
  onRemove: () => void;
}) {
  const window = rule.window;
  const setWindow = (patch: Partial<TimeWindow>) => onChange({ ...rule, window: { ...window!, ...patch } });
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-hair px-3 py-2.5" data-testid={`rule-${index}`}>
      <div className="grid grid-cols-[1fr_150px_auto] items-end gap-3">
        <Field label="Rule">
          <Input value={rule.name} onChange={(e) => onChange({ ...rule, name: e.target.value })} required />
        </Field>
        <Field label="For at most (min)">
          <Input
            type="number"
            min={1}
            value={rule.maxDurationMinutes ?? ''}
            placeholder="Any"
            onChange={(e) =>
              onChange({
                ...rule,
                maxDurationMinutes: e.target.value ? Math.max(1, Number(e.target.value)) : undefined,
              })
            }
          />
        </Field>
        <Button type="button" size="sm" variant="ghost" onClick={onRemove} aria-label={`Remove rule ${index + 1}`}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <Field label="When who gets it is a standing member of" hint="None picked: anyone who may ask.">
        <PickMany
          options={groups}
          value={rule.subjectInGroupIds}
          onChange={(v) => onChange({ ...rule, subjectInGroupIds: v })}
        />
      </Field>
      <Toggle
        checked={!!window}
        onChange={(on) => onChange({ ...rule, window: on ? TimeWindow.parse({}) : undefined })}
        label="Only during set hours"
      />
      {window && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex gap-1" role="group" aria-label="Days">
            {DAYS.map((d, i) => {
              const on = window.days.includes(i);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  className={`h-7 rounded-md border px-2 text-[12px] ${on ? 'border-acbd bg-acdim text-ac' : 'border-hair text-t3'}`}
                  onClick={() =>
                    setWindow({
                      days: on ? window.days.filter((x) => x !== i) : [...window.days, i].sort(),
                    })
                  }
                >
                  {d}
                </button>
              );
            })}
          </div>
          <Field label="From">
            <Input type="time" value={window.from} onChange={(e) => setWindow({ from: e.target.value })} />
          </Field>
          <Field label="To">
            <Input type="time" value={window.to} onChange={(e) => setWindow({ to: e.target.value })} />
          </Field>
          <Field label="Time zone">
            <Input value={window.timeZone} onChange={(e) => setWindow({ timeZone: e.target.value })} className="w-44" />
          </Field>
        </div>
      )}
    </div>
  );
}
