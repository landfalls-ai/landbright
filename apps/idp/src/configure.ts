import type { INestApplication } from '@nestjs/common';
import type { HelmetOptions } from 'helmet';
import { urlencoded } from 'express';
import type Provider from 'oidc-provider';
import { OIDC_PROVIDER, VALKEY } from './valkey';
import type { Redis } from 'ioredis';

/**
 * Helmet for the identity plane: no script at all, styles from this origin only, never framed. No `form-action`:
 * browsers apply it to the redirects after the sign-in form, which go to each application's own origin.
 */
export const IDP_HELMET: HelmetOptions = {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'none'"],
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
  app.use(['/interaction', '/invite'], urlencoded({ extended: false, limit: '16kb' }));
  const provider = app.get<Provider>(OIDC_PROVIDER);
  app.use('/oidc', provider.callback());
  // Close Valkey with the app (the Nest provider has no lifecycle hook of its own).
  const valkey = app.get<Redis>(VALKEY);
  const close = app.close.bind(app);
  app.close = async () => {
    valkey.disconnect();
    await close();
  };
}
