import { createParamDecorator, type ExecutionContext, ForbiddenException } from '@nestjs/common';

/** Who is calling: set by SessionMiddleware from the console session cookie. */
export interface Principal {
  id: string;
  displayName: string;
  email: string;
  admin: boolean;
  sessionId: string;
}

export type WithPrincipal = { principal?: Principal };

/** The signed-in administrator. Wave 1's console API is for administrators only. */
export const Actor = createParamDecorator((_: unknown, context: ExecutionContext): Principal => {
  const principal = context.switchToHttp().getRequest<WithPrincipal>().principal;
  if (!principal?.admin) throw new ForbiddenException('The console is for administrators.');
  return principal;
});

/** How an actor reads in the audit log. */
export const audited = (p: Principal) => ({ actorId: p.id, actorLabel: p.displayName });
