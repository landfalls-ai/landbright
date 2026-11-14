import { z } from 'zod';

/**
 * An update schema from a create schema: every field optional, and no defaults. `.partial()` alone keeps the create
 * schema's defaults, so a PATCH that names one field would reset the others to them (renaming an application would
 * empty its machine API scopes). A field left out of a PATCH is left as it is.
 */
export function patchOf<T extends z.ZodRawShape>(schema: z.ZodObject<T>): ReturnType<z.ZodObject<T>['partial']> {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => {
      const bare = field instanceof z.ZodDefault ? (field.removeDefault() as z.ZodType) : (field as z.ZodType);
      return [key, bare.optional()];
    }),
  );
  return z.object(shape) as unknown as ReturnType<z.ZodObject<T>['partial']>;
}
