import { createParamDecorator, type ExecutionContext, ForbiddenException } from '@nestjs/common';

/** A person signed in to the console: set by SessionMiddleware from the session cookie. */
export interface Principal {
  kind: 'person';
  id: string;
  displayName: string;
  email: string;
  admin: boolean;
  sessionId: string;
}

/**
 * A service calling the machine API (/api/v1) with an access token from Landbright's own issuer (client credentials):
 * set by ServiceTokenMiddleware. Landflow is one. A service never decides a request and is never an administrator.
 */
export interface ServicePrincipal {
  kind: 'service';
  clientId: string;
  /** The application's name, as the audit log shows it ("Landflow (service)"). */
  name: string;
  scopes: string[];
}

export type WithPrincipal = { principal?: Principal | ServicePrincipal };

/** The signed-in administrator. */
export const Actor = createParamDecorator((_: unknown, context: ExecutionContext): Principal => {
  const principal = context.switchToHttp().getRequest<WithPrincipal>().principal;
  if (principal?.kind !== 'person' || !principal.admin)
    throw new ForbiddenException('The console is for administrators.');
  return principal;
});

/** Any signed-in person: the access portal (ask, decide, see your own requests). */
export const Person = createParamDecorator((_: unknown, context: ExecutionContext): Principal => {
  const principal = context.switchToHttp().getRequest<WithPrincipal>().principal;
  if (principal?.kind !== 'person') throw new ForbiddenException('Sign in as a person to use the access portal.');
  return principal;
});

/** A service whose token carries `scope`. */
export const Service = createParamDecorator((scope: string, context: ExecutionContext): ServicePrincipal => {
  const principal = context.switchToHttp().getRequest<WithPrincipal>().principal;
  if (principal?.kind !== 'service') throw new ForbiddenException('This route takes a service access token.');
  if (!principal.scopes.includes(scope)) throw new ForbiddenException(`The token lacks the ${scope} scope.`);
  return principal;
});

/** How an actor reads in the audit log. */
export const audited = (p: Principal | ServicePrincipal) =>
  p.kind === 'person'
    ? { actorId: p.id, actorLabel: p.displayName }
    : { actorId: null, actorLabel: `${p.name} (service)` };
