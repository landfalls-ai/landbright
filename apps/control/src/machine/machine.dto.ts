import { IdentityStatus } from '@landbright/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const InactivePerson = z.object({
  id: z.uuid(),
  displayName: z.string(),
  email: z.string().nullable(),
  status: IdentityStatus,
  lastSignInAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  manager: z.object({ id: z.uuid(), displayName: z.string(), email: z.string().nullable() }).nullable(),
  admin: z.boolean(),
});
export class InactivePeopleDto extends createZodDto(z.object({ items: z.array(InactivePerson) })) {}
