import type { INestApplication } from '@nestjs/common';
import type { HelmetOptions } from 'helmet';
import { urlencoded, type Express } from 'express';
import { loadConfig } from '@landbright/platform';
import type { OidcProviderRef } from './oidc/provider-ref';
import { OIDC_PROVIDER, VALKEY } from './valkey';
import type { Redis } from 'ioredis';

/**
 * Helmet for the identity plane: one script (passkeys) and styles from this origin only, nothing inline, never framed. No `form-action`:
 * browsers apply it to the redirects after the sign-in form, which go to each application's own origin.
 */
export const IDP_HELMET: HelmetOptions = {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'none'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'base-uri': ["'none'"],
      'frame-ancestors': ["'none'"],
    },
  },
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'no-referrer' },
};

/** Form bodies for Landbright's own pages, and oidc-provider under /oidc (it parses its own bodies). */
export function configureIdp(app: INestApplication): void {
  // Behind a TLS proxy (LANDBRIGHT_TRUST_PROXY), the client address is the one the proxy saw, for lockout and audit.
  if (loadConfig().LANDBRIGHT_TRUST_PROXY) (app.getHttpAdapter().getInstance() as Express).set('trust proxy', 1);
  app.use(
    ['/interaction', '/invite', '/forgot', '/reset', '/account', '/ciba'],
    urlencoded({ extended: false, limit: '16kb' }),
  );
  app.use('/oidc', app.get<OidcProviderRef>(OIDC_PROVIDER).middleware);
  // Close Valkey with the app (the Nest provider has no lifecycle hook of its own).
  const valkey = app.get<Redis>(VALKEY);
  const close = app.close.bind(app);
  app.close = async () => {
    valkey.disconnect();
    await close();
  };
}
