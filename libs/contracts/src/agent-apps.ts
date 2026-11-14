import { z } from 'zod';
import { MACHINE_API_SCOPE_NAMES } from './machine-api';

/**
 * An agent's own application (spec 005, slice 3): an OAuth client bound to one agent, with no secret. It proves itself
 * with a JWT signed by one of the agent's keys (`private_key_jwt`, RFC 7523) and acts as that agent only.
 */

/** RFC 8693 token exchange: a person's token for one that says the agent acts for them (`act`). */
export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
/** OpenID CIBA: the agent asks a person to approve, and polls for the answer. */
export const CIBA_GRANT = 'urn:openid:params:grant-type:ciba';
/** RFC 8628: a person signs in on another device (a CLI agent shows a code). */
export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

export const AGENT_GRANT_TYPES = ['client_credentials', TOKEN_EXCHANGE_GRANT, CIBA_GRANT, DEVICE_CODE_GRANT] as const;
export const AgentGrantType = z.enum(AGENT_GRANT_TYPES);
export type AgentGrantType = z.infer<typeof AgentGrantType>;

/** A public key, as a JWK: RSA, EC (P-256) or OKP (Ed25519). Private parts are refused. */
export const PublicJwk = z
  .object({
    kty: z.enum(['RSA', 'EC', 'OKP']),
    kid: z.string().max(200).optional(),
    alg: z.string().max(20).optional(),
    use: z.literal('sig').optional(),
    n: z.string().optional(),
    e: z.string().optional(),
    crv: z.string().optional(),
    x: z.string().optional(),
    y: z.string().optional(),
  })
  .loose()
  .refine(
    (k) => !('d' in k) && !('p' in k) && !('q' in k),
    'Send the public key only: a private key never leaves the agent.',
  )
  .refine(
    (k) => (k.kty === 'RSA' ? Boolean(k.n && k.e) : Boolean(k.crv && k.x && (k.kty === 'OKP' || k.y))),
    'The key is incomplete.',
  );
export type PublicJwk = z.infer<typeof PublicJwk>;

export const PublicJwks = z.object({ keys: z.array(PublicJwk).min(1).max(5) });
export type PublicJwks = z.infer<typeof PublicJwks>;

export const CreateAgentApplication = z.object({
  jwks: PublicJwks,
  grantTypes: z
    .array(AgentGrantType)
    .min(1)
    .default([...AGENT_GRANT_TYPES]),
  /** Machine API scopes it may get, as the agent (client credentials) or for a person (token exchange). */
  apiScopes: z
    .array(z.enum(MACHINE_API_SCOPE_NAMES as [string, ...string[]]))
    .default(['requests:read', 'requests:create']),
});
export type CreateAgentApplication = z.input<typeof CreateAgentApplication>;

export const ReplaceAgentKeys = z.object({ jwks: PublicJwks });
export type ReplaceAgentKeys = z.input<typeof ReplaceAgentKeys>;
