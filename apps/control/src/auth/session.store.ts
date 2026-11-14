import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { VALKEY } from '../common/tokens';

export const SESSION_COOKIE = 'lb_session';
/** Idle timeout: each request pushes the expiry back. */
export const SESSION_TTL_SECONDS = 8 * 3600;

export interface ConsoleSession {
  identityId: string;
  /** For RP-initiated logout at the identity plane. */
  idToken: string;
  createdAt: string;
}

/** A sign-in in flight: what the callback must check. Lives 10 minutes. */
export interface PendingLogin {
  codeVerifier: string;
  nonce: string;
  returnTo: string;
}

/** Console sessions and sign-ins in flight, in Valkey, so any control replica serves any request. */
@Injectable()
export class SessionStore {
  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  async create(session: ConsoleSession): Promise<string> {
    const id = randomBytes(32).toString('base64url');
    await this.valkey.set(this.key(id), JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
    return id;
  }

  async get(id: string): Promise<ConsoleSession | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return undefined;
    const raw = await this.valkey.getex(this.key(id), 'EX', SESSION_TTL_SECONDS);
    return raw ? (JSON.parse(raw) as ConsoleSession) : undefined;
  }

  async destroy(id: string): Promise<void> {
    await this.valkey.del(this.key(id));
  }

  async savePending(state: string, pending: PendingLogin): Promise<void> {
    await this.valkey.set(`lb:login:${state}`, JSON.stringify(pending), 'EX', 600);
  }

  /** Reads and deletes in one step: a state works once. */
  async takePending(state: string): Promise<PendingLogin | undefined> {
    const raw = await this.valkey.getdel(`lb:login:${state}`);
    return raw ? (JSON.parse(raw) as PendingLogin) : undefined;
  }

  private key(id: string): string {
    return `lb:session:${id}`;
  }
}
