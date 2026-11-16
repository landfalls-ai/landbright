-- Spec 009, slice 2: an application that authenticates with a secret may be let off PKCE (Google Workspace's OIDC
-- profile doesn't say it sends PKCE). Every application keeps PKCE required unless an administrator says otherwise.
ALTER TABLE "oidc_client" ADD COLUMN "pkce_required" BOOLEAN NOT NULL DEFAULT true;
