import { type PrismaClient, type TenantRef, withTenant } from '@landbright/persistence';
import type { Account, AccountClaims } from 'oidc-provider';

/**
 * The claims Landbright issues. `roles` and `groups` both carry the names of the groups a person is in (expired
 * just-in-time memberships excluded): Landflow maps `roles` (LANDFLOW_OIDC_ROLE_MAP), Landfall and others read
 * `groups`. Emails are verified because an administrator or an HR source entered them.
 */
export async function loadAccount(prisma: PrismaClient, tenant: TenantRef, sub: string): Promise<Account | undefined> {
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
  return { accountId: identity.id, claims: () => claims };
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
