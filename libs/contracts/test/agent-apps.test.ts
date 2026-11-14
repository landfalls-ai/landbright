import { describe, expect, it } from 'vitest';
import { AGENT_GRANT_TYPES, CreateAgentApplication, PublicJwks } from '../src/agent-apps';

const ec = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
};

describe('agent applications', () => {
  it('takes public keys and refuses private ones or incomplete ones', () => {
    expect(PublicJwks.safeParse({ keys: [ec] }).success).toBe(true);
    expect(PublicJwks.safeParse({ keys: [{ kty: 'RSA', n: 'abc', e: 'AQAB' }] }).success).toBe(true);
    expect(PublicJwks.safeParse({ keys: [{ ...ec, d: 'secret' }] }).success).toBe(false);
    expect(PublicJwks.safeParse({ keys: [{ kty: 'EC', crv: 'P-256', x: 'only-x' }] }).success).toBe(false);
    expect(PublicJwks.safeParse({ keys: [] }).success).toBe(false);
  });

  it('defaults to every agent grant and to asking for itself', () => {
    const parsed = CreateAgentApplication.parse({ jwks: { keys: [ec] } });
    expect(parsed.grantTypes).toEqual([...AGENT_GRANT_TYPES]);
    expect(parsed.apiScopes).toEqual(['requests:read', 'requests:create']);
  });
});
