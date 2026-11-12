import { hash, verify } from '@node-rs/argon2';

/** argon2id with OWASP's 2024 parameters: 19 MiB, 2 iterations, 1 lane. */
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const MIN_PASSWORD_LENGTH = 12;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

/** A hash of nothing, verified when the account doesn't exist so a wrong email takes as long as a wrong password. */
let decoy: Promise<string> | undefined;
export function decoyHash(): Promise<string> {
  decoy ??= hashPassword('decoy password, never valid');
  return decoy;
}
