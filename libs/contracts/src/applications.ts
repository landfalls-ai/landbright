import { z } from 'zod';
import { patchOf } from './patch';
import { MACHINE_API_SCOPE_NAMES } from './machine-api';
import { Acr } from './acr';

/** Applications: the OIDC clients that sign in with Landbright. */

/** The two ways an application with a secret proves itself (an agent's uses private_key_jwt, set with it). */
export const SECRET_AUTH_METHODS = ['client_secret_basic', 'client_secret_post'] as const;
export type SecretAuthMethod = (typeof SECRET_AUTH_METHODS)[number];

const RedirectUri = z.url().refine((u) => !u.includes('#'), 'A redirect URI can’t have a fragment.');

export const Application = z.object({
  id: z.uuid(),
  clientId: z.string(),
  name: z.string(),
  redirectUris: z.array(z.string()),
  postLogoutRedirectUris: z.array(z.string()),
  grantTypes: z.array(z.string()),
  /** What it may do as itself on the machine API (client credentials). */
  apiScopes: z.array(z.string()),
  /** The weakest sign-in it accepts (`acr`); null accepts any. */
  minimumAcr: Acr.nullable(),
  /** OpenID Back-Channel Logout: where Landbright posts a logout token when someone's session ends; null: not told. */
  backchannelLogoutUri: z.string().nullable(),
  /** Landbright's own console client: shown, not editable. */
  system: z.boolean(),
  /** An agent's own application: the agent it acts as (no secret; `private_key_jwt` with the agent's keys). */
  agentId: z.uuid().nullable(),
  /** How it proves itself at the token endpoint: client_secret_basic or _post, or private_key_jwt for an agent's. */
  tokenEndpointAuthMethod: z.string(),
  /** An agent's application: how many public keys it has. */
  keys: z.number().int(),
  secretVersion: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Application = z.infer<typeof Application>;

export const ApplicationList = z.object({ items: z.array(Application), issuer: z.url() });

export const CreateApplication = z.object({
  name: z.string().trim().min(1).max(100),
  /** Lowercase letters, digits and dashes; derived from the name when absent. */
  clientId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
    .optional(),
  redirectUris: z.array(RedirectUri).min(1),
  postLogoutRedirectUris: z.array(RedirectUri).default([]),
  /** client_credentials lets the app call as itself (a service identity); used by Landflow's plugin in wave 3. */
  grantTypes: z
    .array(z.enum(['authorization_code', 'refresh_token', 'client_credentials']))
    .default(['authorization_code', 'refresh_token']),
  /** Machine API scopes (needs client_credentials): requests:read, grants:record, … */
  apiScopes: z.array(z.enum(MACHINE_API_SCOPE_NAMES as [string, ...string[]])).default([]),
  /** The weakest sign-in it accepts: people who signed in more weakly are asked for more (step-up). */
  minimumAcr: Acr.nullable().default(null),
  /**
   * OpenID Back-Channel Logout 1.0: Landbright posts a `logout_token` here when someone signed in to the application
   * signs out, ends their other sessions or is deactivated.
   */
  backchannelLogoutUri: z
    .url({ protocol: /^https?$/ })
    .refine((u) => !u.includes('#'), 'A logout URI can’t have a fragment.')
    .nullable()
    .default(null),
  /** How it sends its secret to the token endpoint: an Authorization header (basic) or form fields (post). */
  tokenEndpointAuthMethod: z.enum(SECRET_AUTH_METHODS).default('client_secret_basic'),
});
export type CreateApplication = z.input<typeof CreateApplication>;

export const UpdateApplication = patchOf(CreateApplication.omit({ clientId: true }));
export type UpdateApplication = z.input<typeof UpdateApplication>;

/** Returned once, on creation and on rotation. Landbright never stores the secret and can't show it again. */
export const ApplicationWithSecret = z.object({
  application: Application,
  clientSecret: z.string(),
  issuer: z.url(),
});
export type ApplicationWithSecret = z.infer<typeof ApplicationWithSecret>;
