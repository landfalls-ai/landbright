import { z } from 'zod';

/** The console's Settings page (GET /api/settings). */
export const SigningKey = z.object({
  kid: z.string(),
  alg: z.string(),
  /** `signing`: the newest key, signing ID tokens now. `verifying`: published so tokens it signed still verify. */
  status: z.enum(['signing', 'verifying', 'retired']),
  createdAt: z.iso.datetime(),
  retiredAt: z.iso.datetime().nullable(),
});
export type SigningKey = z.infer<typeof SigningKey>;

export const Settings = z.object({
  tenant: z.object({ slug: z.string(), name: z.string() }),
  issuer: z.url(),
  signIn: z.object({
    /** Everyone must use a second step (an authenticator app or a passkey). A passkey alone counts as both. */
    mfaRequired: z.boolean(),
    methods: z.array(z.enum(['password', 'totp', 'passkey'])),
  }),
  signingKeys: z.array(SigningKey),
  /** How long an ID token lives; a rotation keeps the replaced key published at least this long. */
  idTokenTtlSeconds: z.number().int().positive(),
  /** When the next rotation may happen (the previous key still verifies tokens until then); null for now. */
  rotateAfter: z.iso.datetime().nullable(),
});
export type Settings = z.infer<typeof Settings>;

export const UpdateSignIn = z.object({ mfaRequired: z.boolean() });
export type UpdateSignIn = z.infer<typeof UpdateSignIn>;

/** POST /api/settings/signing-keys/rotate */
export const RotationResult = z.object({ kid: z.string(), retired: z.array(z.string()), settings: Settings });
export type RotationResult = z.infer<typeof RotationResult>;
