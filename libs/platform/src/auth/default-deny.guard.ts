import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from './public.decorator';

/**
 * The global guard on every Landbright service: a route is closed unless it is marked `@Public()` or an authenticated
 * principal is on the request. Wave 0 has no authentication yet, so only public routes answer; wave 1 sets
 * `request.principal` from a session or bearer token before this guard runs.
 */
@Injectable()
export class DefaultDenyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest<{ principal?: unknown }>();
    if (request.principal) return true;
    throw new UnauthorizedException();
  }
}
