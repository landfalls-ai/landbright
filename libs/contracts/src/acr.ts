import { z } from 'zod';

/**
 * How strongly someone signed in (the `acr` claim), from weakest to strongest. `pwd`: a password alone. `mfa`: a
 * password and a second step. `phr`: phishing-resistant, a passkey (bound to the origin, with user verification).
 */
export const ACR_VALUES = ['urn:landbright:acr:pwd', 'urn:landbright:acr:mfa', 'urn:landbright:acr:phr'] as const;
export const Acr = z.enum(ACR_VALUES);
export type Acr = z.infer<typeof Acr>;

export const ACR_LABELS: Record<Acr, string> = {
  'urn:landbright:acr:pwd': 'A password',
  'urn:landbright:acr:mfa': 'A password and a second step',
  'urn:landbright:acr:phr': 'A passkey',
};

/** 1, 2, 3; 0 for anything else (no sign-in, an unknown value). */
export function acrLevel(acr: string | undefined | null): number {
  return ACR_VALUES.indexOf(acr as Acr) + 1;
}

/** The `acr` a sign-in earned, from its `amr` (RFC 8176): a passkey is `phr`, any two factors `mfa`. */
export function acrOf(amr: readonly string[]): Acr {
  if (amr.includes('pop')) return 'urn:landbright:acr:phr';
  if (amr.includes('mfa')) return 'urn:landbright:acr:mfa';
  return 'urn:landbright:acr:pwd';
}

/**
 * The weakest `acr` a sign-in must reach: the application's minimum, raised by the request's `acr_values` (the
 * weakest value it lists that Landbright knows, since any of them would satisfy it). Undefined: anything goes.
 */
export function neededAcr(minimum: string | null | undefined, acrValues: string | undefined): Acr | undefined {
  const requested = (acrValues ?? '')
    .split(' ')
    .map(acrLevel)
    .filter((l) => l > 0);
  const level = Math.max(acrLevel(minimum), requested.length ? Math.min(...requested) : 0);
  return level ? ACR_VALUES[level - 1] : undefined;
}
