import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { type Config, createValkey } from '@landbright/platform';
import { CONFIG } from '@landbright/persistence';
import type { Redis } from 'ioredis';
import { VALKEY } from './tokens';

/** Valkey for control: console sessions and sign-in state. */
@Global()
@Module({
  providers: [
    {
      provide: VALKEY,
      inject: [CONFIG],
      useFactory: (config: Config) => createValkey(config.LANDBRIGHT_VALKEY_URL, 'landbright-control'),
    },
  ],
  exports: [VALKEY],
})
export class InfraModule implements OnApplicationShutdown {
  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  onApplicationShutdown(): void {
    this.valkey.disconnect();
  }
}
