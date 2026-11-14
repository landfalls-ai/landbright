import { useState } from 'react';
import { Bot, KeyRound, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Agent, type AgentRuntime, Application, PublicJwks, type RiskTier } from '@landbright/contracts';
import { ListState, StatusBadge } from '@/components/directory/bits';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge, Chip, type Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, FormError } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/inputs';
import { Cell, Row, Table } from '@/components/ui/table';
import { send, useAgents, usePeople, useWrite } from '@/lib/api';

const RISK: Record<RiskTier, Tone> = { low: 'neutral', elevated: 'warning', privileged: 'danger' };
const RUNTIME: Record<AgentRuntime, string> = {
  landflow: 'Landflow',
  kagent: 'kagent',
  claude_code: 'Claude Code',
  external: 'External',
};
const ACT_FOR = { sponsor: 'Its sponsor', anyone: 'Anyone who asks', nobody: 'Only itself' } as const;

/**
 * Agent identities. Every agent has a sponsor, the person accountable for it; deactivating the sponsor suspends the
 * agent. An agent's application holds its public keys (private_key_jwt): with it the agent gets tokens as itself,
 * exchanges a person's token, asks a person (CIBA) or uses the device grant.
 */
export function AgentsPage() {
  const agents = useAgents();
  const [adding, setAdding] = useState(false);
  const [keysFor, setKeysFor] = useState<Agent | undefined>();
  const status = useWrite(({ id, action }: { id: string; action: 'suspend' | 'resume' }) =>
    send('POST', `/api/agents/${id}/${action}`, undefined, Agent),
  );
  const items = agents.data?.items ?? [];
  const add = (
    <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
      <Plus className="size-3.5" /> Add agent
    </Button>
  );
  return (
    <>
      <PageHeader title="Agents" meta={agents.data && <span>{items.length} registered</span>} actions={add} />
      <PageBody className="max-w-[1400px]">
        {items.length ? (
          <Table head={['Agent', 'Sponsor', 'Runtime', 'Risk', 'Acts for', 'Application', 'Status', '']}>
            {items.map((a) => (
              <Row key={a.id} testId={`agent-${a.displayName}`}>
                <Cell>
                  <div className="font-medium text-t1">{a.displayName}</div>
                  <div className="max-w-[240px] truncate text-[12px] text-t3" title={a.purpose}>
                    {a.purpose}
                  </div>
                </Cell>
                <Cell>
                  <div className="text-t1">{a.sponsor.displayName}</div>
                  {a.sponsor.status !== 'active' && <StatusBadge status={a.sponsor.status} />}
                </Cell>
                <Cell>
                  <Chip>{RUNTIME[a.runtime]}</Chip>
                  {a.homeProject && <div className="mt-0.5 font-mono text-[11px] text-t3">{a.homeProject}</div>}
                </Cell>
                <Cell>
                  <Badge tone={RISK[a.riskTier]}>{a.riskTier}</Badge>
                </Cell>
                <Cell>
                  <div className="whitespace-nowrap text-t2">{ACT_FOR[a.actFor]}</div>
                  <div className="whitespace-nowrap font-mono text-[11px] text-t3" title="Longest token it gets">
                    tokens {Math.round(a.maxTokenTtlSeconds / 60)} min
                  </div>
                </Cell>
                <Cell>
                  {a.application ? (
                    <span title={a.application.clientId} data-testid={`agent-app-${a.displayName}`}>
                      <Badge tone="neutral">Connected</Badge>
                    </span>
                  ) : (
                    <span className="text-[12px] text-t3">None</span>
                  )}
                </Cell>
                <Cell>
                  <StatusBadge status={a.status} />
                </Cell>
                <Cell className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={() => setKeysFor(a)} data-testid={`keys-${a.displayName}`}>
                    <KeyRound className="size-3.5" /> {a.application ? 'Keys' : 'Connect'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      status.mutate(
                        { id: a.id, action: a.status === 'active' ? 'suspend' : 'resume' },
                        { onError: (e) => toast.error(e.message) },
                      )
                    }
                  >
                    {a.status === 'active' ? 'Suspend' : 'Resume'}
                  </Button>
                </Cell>
              </Row>
            ))}
          </Table>
        ) : (
          <ListState
            loading={agents.isLoading}
            error={agents.error}
            icon={<Bot className="size-5" strokeWidth={1.7} />}
            empty="No agents yet"
            emptyHint="Register an agent with the person accountable for it. In wave 5 Landflow’s agents appear here on their own and get short-lived tokens."
            action={add}
          />
        )}
      </PageBody>
      {adding && <AddAgentDialog onClose={() => setAdding(false)} />}
      {keysFor && <AgentKeysDialog agent={keysFor} onClose={() => setKeysFor(undefined)} />}
    </>
  );
}

function AddAgentDialog({ onClose }: { onClose: () => void }) {
  const people = usePeople();
  const [form, setForm] = useState({
    displayName: '',
    sponsorId: '',
    purpose: '',
    riskTier: 'low',
    runtime: 'landflow',
    homeProject: '',
    maxTokenTtlSeconds: '900',
    actFor: 'sponsor',
  });
  const create = useWrite(() =>
    send(
      'POST',
      '/api/agents',
      { ...form, homeProject: form.homeProject || undefined, maxTokenTtlSeconds: Number(form.maxTokenTtlSeconds) },
      Agent,
    ),
  );
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });
  const sponsors = (people.data?.items ?? []).filter((p) => p.status === 'active');
  return (
    <Dialog
      title="Add an agent"
      subtitle="An agent acts for people; its sponsor answers for it."
      onClose={onClose}
      onSubmit={() => create.mutate(undefined, { onSuccess: onClose })}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Add agent
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Field label="Name">
          <Input
            value={form.displayName}
            onChange={set('displayName')}
            required
            autoFocus
            placeholder="Release notes writer"
          />
        </Field>
        <Field label="Sponsor" hint="The accountable person. If they leave, the agent is suspended.">
          <Select value={form.sponsorId} onChange={set('sponsorId')} required>
            <option value="" disabled>
              Choose a person
            </option>
            {sponsors.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName} ({p.email})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Purpose">
          <Textarea
            rows={2}
            value={form.purpose}
            onChange={set('purpose')}
            required
            placeholder="What it does, and why it needs access"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Runtime">
            <Select value={form.runtime} onChange={set('runtime')}>
              {Object.entries(RUNTIME).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Home project">
            <Input value={form.homeProject} onChange={set('homeProject')} placeholder="Optional" />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Risk tier">
            <Select value={form.riskTier} onChange={set('riskTier')}>
              <option value="low">Low</option>
              <option value="elevated">Elevated</option>
              <option value="privileged">Privileged</option>
            </Select>
          </Field>
          <Field label="Acts for">
            <Select value={form.actFor} onChange={set('actFor')}>
              {Object.entries(ACT_FOR).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Token TTL (s)">
            <Input
              type="number"
              min={60}
              max={3600}
              step={60}
              value={form.maxTokenTtlSeconds}
              onChange={set('maxTokenTtlSeconds')}
            />
          </Field>
        </div>
        <FormError error={create.error} />
      </div>
    </Dialog>
  );
}

/**
 * The agent's application: paste its public keys (a JWKS). The private key stays with the agent; Landbright refuses
 * one. Creating it the first time also chooses what the agent may ask the machine API for.
 */
function AgentKeysDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [jwks, setJwks] = useState('');
  const [parseError, setParseError] = useState<string>();
  const existing = agent.application;
  const save = useWrite((body: { jwks: unknown }) =>
    existing
      ? send('PUT', `/api/agents/${agent.id}/application/keys`, body, Application)
      : send('POST', `/api/agents/${agent.id}/application`, body, Application),
  );
  const [saved, setSaved] = useState<Application>();
  const submit = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jwks);
    } catch {
      return setParseError('That isn’t JSON. Paste the agent’s JWKS: {"keys": [ … ]}.');
    }
    const checked = PublicJwks.safeParse(parsed);
    if (!checked.success) return setParseError(checked.error.issues[0]?.message ?? 'That isn’t a public JWKS.');
    setParseError(undefined);
    save.mutate(
      { jwks: checked.data },
      {
        onSuccess: (app) => {
          setSaved(app);
          toast.success(
            existing ? 'Keys replaced: the old ones no longer work.' : `${agent.displayName} is connected.`,
          );
        },
      },
    );
  };
  return (
    <Dialog
      title={existing ? `${agent.displayName}: keys` : `Connect ${agent.displayName}`}
      subtitle={
        existing ? 'New public keys replace the old ones at once.' : 'No secret: it signs in with a key only it holds.'
      }
      onClose={onClose}
      onSubmit={saved ? onClose : submit}
      footer={
        saved ? (
          <Button type="submit" variant="primary">
            Done
          </Button>
        ) : (
          <>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={save.isPending} data-testid="save-keys">
              {existing ? 'Replace keys' : 'Connect'}
            </Button>
          </>
        )
      }
    >
      {saved ? (
        <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-2 text-[13px]" data-testid="agent-app">
          <dt className="text-t3">Client id</dt>
          <dd className="font-mono text-t1">{saved.clientId}</dd>
          <dt className="text-t3">Signs in with</dt>
          <dd className="text-t1">private_key_jwt · {saved.keys === 1 ? '1 key' : `${saved.keys} keys`}</dd>
          <dt className="text-t3">Can use</dt>
          <dd className="text-t1">Client credentials, token exchange, CIBA, the device grant</dd>
          <dt className="text-t3">Machine API</dt>
          <dd className="font-mono text-[12px] text-t2">{saved.apiScopes.join(' ')}</dd>
        </dl>
      ) : (
        <div className="flex flex-col gap-3.5">
          {existing && (
            <p className="text-[13px] text-t2">
              Client id <span className="font-mono text-t1">{existing.clientId}</span>
            </p>
          )}
          <Field label="Public keys (JWKS)" hint="RSA, P-256 or Ed25519. Paste the public part only.">
            <Textarea
              rows={7}
              className="font-mono text-[12px]"
              value={jwks}
              onChange={(e) => setJwks(e.target.value)}
              required
              autoFocus
              placeholder={'{"keys": [{"kty": "EC", "crv": "P-256", "x": "…", "y": "…", "kid": "bot-1"}]}'}
              data-testid="jwks"
            />
          </Field>
          <FormError error={parseError ? new Error(parseError) : save.error} />
        </div>
      )}
    </Dialog>
  );
}
