import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'landbright:public';

/**
 * Opens one route or controller to unauthenticated callers. Everything else is denied by `DefaultDenyGuard`
 * (constitution principle II). Each use is a decision: say why next to it.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
