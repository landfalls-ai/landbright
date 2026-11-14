-- Spec 005, slice 2, the identity plane: required actions, accepted terms, recovery codes, password-reset links, and a
-- minimum sign-in strength per application.
ALTER TYPE "credential_kind" ADD VALUE 'recovery_code';
ALTER TABLE "identity" ADD COLUMN "required_actions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "identity" ADD COLUMN "terms_accepted_at" TIMESTAMP(3);
ALTER TABLE "invite_token" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'invite';
ALTER TABLE "oidc_client" ADD COLUMN "minimum_acr" TEXT;
