import { type PrismaClient, type TenantRef, withTenant } from '@landbright/persistence';
import type { Account, AccountClaims, KoaContextWithOIDC } from 'oidc-provider';

/** An account, and when the soonest just-in-time membership in its claims ends (tokens don't outlive it). */
export type LandbrightAccount = Account & { grantEndsAt?: Date };

/**
 * The claims Landbright issues. `roles` and `groups` both carry the names of the groups a person is in (expired
 * just-in-time memberships excluded): Landflow maps `roles` (LANDFLOW_OIDC_ROLE_MAP), Landfall and others read
 * `groups`. Emails are verified because an administrator or an HR source entered them.
 */
export async function loadAccount(
  prisma: PrismaClient,
  tenant: TenantRef,
  sub: string,
): Promise<LandbrightAccount | undefined> {
  const identity = await withTenant(prisma, tenant.id, (tx) =>
    tx.identity.findFirst({
      where: { id: sub, kind: 'person', status: 'active' },
      include: {
        person: true,
        memberships: {
          where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          include: { group: { select: { name: true } } },
        },
      },
    }),
  );
  if (!identity) return undefined;
  const groups = identity.memberships.map((m) => m.group.name).sort();
  const claims: AccountClaims = {
    sub: identity.id,
    email: identity.email ?? undefined,
    email_verified: Boolean(identity.email),
    name: identity.displayName,
    given_name: identity.person?.givenName || undefined,
    family_name: identity.person?.familyName || undefined,
    preferred_username: identity.email ?? undefined,
    roles: groups,
    groups,
  };
  const ends = identity.memberships
    .map((m) => m.expiresAt?.getTime())
    .filter((t): t is number => t !== undefined && t !== null);
  return {
    accountId: identity.id,
    claims: () => claims,
    ...(ends.length && { grantEndsAt: new Date(Math.min(...ends)) }),
  };
}

/**
 * A token's lifetime, cut short so it ends with the soonest just-in-time membership its claims carry: an ID token
 * that says `roles: [Payments Editors]` must not outlive the grant that made it true. At least 30 seconds.
 */
export function capToGrant(ctx: KoaContextWithOIDC, seconds: number): number {
  const ends = (ctx.oidc.account as LandbrightAccount | undefined)?.grantEndsAt;
  if (!ends) return seconds;
  return Math.max(30, Math.min(seconds, Math.floor((ends.getTime() - Date.now()) / 1000)));
}

/**
 * Scopes and the claims they release. `acr`, `auth_time`, `sid` and `iss` are oidc-provider's standalone claims (its
 * defaults, restated because this map replaces them). `amr` (how the person signed in: `pwd`, `otp`) comes with
 * `openid`, so every ID token carries it.
 */
export const CLAIMS = {
  acr: null,
  auth_time: null,
  sid: null,
  iss: null,
  openid: ['sub', 'amr'],
  email: ['email', 'email_verified'],
  profile: ['name', 'given_name', 'family_name', 'preferred_username'],
  roles: ['roles', 'groups'],
};
