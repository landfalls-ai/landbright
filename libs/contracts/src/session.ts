import { z } from 'zod';

/** Who is signed in to the console (GET /api/auth/me). */
export const Me = z.object({
  id: z.uuid(),
  displayName: z.string(),
  email: z.string(),
  admin: z.boolean(),
  tenant: z.object({ slug: z.string(), name: z.string() }),
});
export type Me = z.infer<typeof Me>;

export const Logout = z.object({ redirect: z.string() });
export type Logout = z.infer<typeof Logout>;
