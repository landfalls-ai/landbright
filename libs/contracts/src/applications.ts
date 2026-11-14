import { z } from 'zod';
import { patchOf } from './patch';
import { MACHINE_API_SCOPE_NAMES } from './machine-api';

/** Applications: the OIDC clients that sign in with Landbright. */

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
  /** Landbright's own console client: shown, not editable. */
  system: z.boolean(),
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
