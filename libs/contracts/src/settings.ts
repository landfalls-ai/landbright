import { z } from 'zod';

/** The console's Settings page (GET /api/settings). */
export const SigningKey = z.object({
  kid: z.string(),
  alg: z.string(),
  createdAt: z.iso.datetime(),
  retiredAt: z.iso.datetime().nullable(),
});
export type SigningKey = z.infer<typeof SigningKey>;

export const Settings = z.object({
  tenant: z.object({ slug: z.string(), name: z.string() }),
  issuer: z.url(),
  signIn: z.object({
    /** Everyone must use a second step (an authenticator app) after their password. */
    mfaRequired: z.boolean(),
    methods: z.array(z.enum(['password', 'totp', 'passkey'])),
  }),
  signingKeys: z.array(SigningKey),
});
export type Settings = z.infer<typeof Settings>;

export const UpdateSignIn = z.object({ mfaRequired: z.boolean() });
export type UpdateSignIn = z.infer<typeof UpdateSignIn>;
