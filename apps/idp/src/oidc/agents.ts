import type { Client } from 'oidc-provider';

/** What an agent's application carries from its agent (oidc/adapter.ts `findClient`). */
export interface AgentClientInfo {
  agentId: string;
  name: string;
  /** Its tokens live at most this long (the agent's `maxTokenTtlSeconds`). */
  ttl: number;
  actFor: 'anyone' | 'sponsor' | 'nobody';
  sponsorId: string;
}

/** The agent behind a client, when it is an agent's application. */
export function agentOf(client: Client | undefined): AgentClientInfo | undefined {
  const c = client as (Client & Record<string, unknown>) | undefined;
  if (!c?.['agent_id']) return undefined;
  return {
    agentId: String(c['agent_id']),
    name: String(c['agent_name'] ?? c.clientName ?? c.clientId),
    ttl: Number(c['agent_ttl'] ?? 900),
    actFor: (c['agent_act_for'] as AgentClientInfo['actFor']) ?? 'nobody',
    sponsorId: String(c['agent_sponsor_id'] ?? ''),
  };
}

/**
 * Whether the agent may act for this person (its `actFor`): anyone, only its sponsor, or nobody. Returns why not, or
 * undefined when it may. The person being active is checked where their account is loaded.
 */
export function whyAgentMayNotActFor(agent: AgentClientInfo, personId: string): string | undefined {
  if (agent.actFor === 'nobody') return `${agent.name} doesn’t act for people.`;
  if (agent.actFor === 'sponsor' && personId !== agent.sponsorId) return `${agent.name} acts only for its sponsor.`;
  return undefined;
}

/**
 * The `act` claim (RFC 8693 §4.1) for a token an agent holds for a person: the agent, then whoever acted before it.
 * A token the same agent already held (its own CIBA or device token, or an earlier exchange) adds no new actor.
 */
export function actClaim(
  agent: AgentClientInfo,
  clientId: string,
  prior?: Record<string, unknown>,
): Record<string, unknown> {
  if (prior?.sub === agent.agentId && prior.client_id === clientId) return prior;
  return { sub: agent.agentId, client_id: clientId, ...(prior && { act: prior }) };
}
