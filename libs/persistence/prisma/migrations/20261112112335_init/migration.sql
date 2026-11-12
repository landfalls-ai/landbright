-- CreateEnum
CREATE TYPE "identity_kind" AS ENUM ('person', 'agent', 'service');

-- CreateEnum
CREATE TYPE "identity_status" AS ENUM ('pre_hire', 'active', 'suspended', 'deactivated');

-- CreateEnum
CREATE TYPE "risk_tier" AS ENUM ('low', 'elevated', 'privileged');

-- CreateEnum
CREATE TYPE "agent_runtime" AS ENUM ('landflow', 'kagent', 'claude_code', 'external');

-- CreateEnum
CREATE TYPE "act_for" AS ENUM ('anyone', 'sponsor', 'nobody');

-- CreateEnum
CREATE TYPE "group_kind" AS ENUM ('static', 'birthright', 'jit');

-- CreateEnum
CREATE TYPE "membership_source" AS ENUM ('manual', 'hr', 'grant');

-- CreateEnum
CREATE TYPE "credential_kind" AS ENUM ('password', 'totp', 'passkey');

-- CreateTable
CREATE TABLE "tenant" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "identity_kind" NOT NULL,
    "status" "identity_status" NOT NULL DEFAULT 'active',
    "display_name" TEXT NOT NULL,
    "email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person_profile" (
    "identity_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "given_name" TEXT NOT NULL,
    "family_name" TEXT NOT NULL,
    "department" TEXT,
    "title" TEXT,
    "site" TEXT,
    "manager_id" UUID,
    "start_date" DATE,
    "end_date" DATE,

    CONSTRAINT "person_profile_pkey" PRIMARY KEY ("identity_id")
);

-- CreateTable
CREATE TABLE "agent_profile" (
    "identity_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sponsor_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "risk_tier" "risk_tier" NOT NULL DEFAULT 'low',
    "runtime" "agent_runtime" NOT NULL DEFAULT 'landflow',
    "home_project" TEXT,
    "max_token_ttl_seconds" INTEGER NOT NULL DEFAULT 900,
    "act_for" "act_for" NOT NULL DEFAULT 'sponsor',

    CONSTRAINT "agent_profile_pkey" PRIMARY KEY ("identity_id")
);

-- CreateTable
CREATE TABLE "group" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "group_kind" NOT NULL DEFAULT 'static',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership" (
    "tenant_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "source" "membership_source" NOT NULL DEFAULT 'manual',
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("group_id","identity_id")
);

-- CreateTable
CREATE TABLE "credential" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "kind" "credential_kind" NOT NULL,
    "secret" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_token" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oidc_client" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirect_uris" TEXT[],
    "post_logout_redirect_uris" TEXT[],
    "grant_types" TEXT[],
    "token_endpoint_auth_method" TEXT NOT NULL DEFAULT 'client_secret_basic',
    "secret_version" INTEGER NOT NULL DEFAULT 1,
    "system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oidc_client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "actor_label" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "prev_hash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signing_key" (
    "kid" TEXT NOT NULL,
    "alg" TEXT NOT NULL,
    "public_jwk" JSONB NOT NULL,
    "sealed_private_jwk" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "signing_key_pkey" PRIMARY KEY ("kid")
);

-- CreateTable
CREATE TABLE "oidc_payload" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "grant_id" TEXT,
    "user_code" TEXT,
    "uid" TEXT,
    "expires_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "oidc_payload_pkey" PRIMARY KEY ("id","type")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- CreateIndex
CREATE INDEX "identity_tenant_id_kind_idx" ON "identity"("tenant_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "identity_tenant_id_email_key" ON "identity"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "agent_profile_tenant_id_sponsor_id_idx" ON "agent_profile"("tenant_id", "sponsor_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_tenant_id_name_key" ON "group"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "membership_tenant_id_identity_id_idx" ON "membership"("tenant_id", "identity_id");

-- CreateIndex
CREATE INDEX "credential_tenant_id_identity_id_idx" ON "credential"("tenant_id", "identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "invite_token_token_hash_key" ON "invite_token"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "oidc_client_client_id_key" ON "oidc_client"("client_id");

-- CreateIndex
CREATE INDEX "oidc_client_tenant_id_idx" ON "oidc_client"("tenant_id");

-- CreateIndex
CREATE INDEX "audit_event_tenant_id_id_idx" ON "audit_event"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "oidc_payload_grant_id_idx" ON "oidc_payload"("grant_id");

-- CreateIndex
CREATE INDEX "oidc_payload_uid_idx" ON "oidc_payload"("uid");

-- CreateIndex
CREATE INDEX "oidc_payload_user_code_idx" ON "oidc_payload"("user_code");

-- CreateIndex
CREATE INDEX "oidc_payload_expires_at_idx" ON "oidc_payload"("expires_at");

-- AddForeignKey
ALTER TABLE "person_profile" ADD CONSTRAINT "person_profile_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_profile" ADD CONSTRAINT "agent_profile_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_profile" ADD CONSTRAINT "agent_profile_sponsor_id_fkey" FOREIGN KEY ("sponsor_id") REFERENCES "identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential" ADD CONSTRAINT "credential_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_token" ADD CONSTRAINT "invite_token_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------- the app role and row-level security
--
-- The services connect as landbright_app: not a superuser, not the owner, no BYPASSRLS. A real deployment gives it a
-- login and password of its own; development does it in prisma/dev-roles.sql.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'landbright_app') THEN
    CREATE ROLE landbright_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO landbright_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO landbright_app;

-- The tenant table is read before a tenant is known; the app may only read it.
GRANT SELECT ON "tenant" TO landbright_app;

-- Deployment-wide protocol storage: no tenant, no row-level security.
GRANT SELECT, INSERT, UPDATE, DELETE ON "signing_key", "oidc_payload" TO landbright_app;

-- The audit log is append-only for the app.
GRANT SELECT, INSERT ON "audit_event" TO landbright_app;

-- Tenant-owned tables: every statement sees only the tenant set by withTenant() (app.tenant_id, transaction-local).
-- FORCE makes the policy apply to the owner too.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['identity', 'person_profile', 'agent_profile', 'group', 'membership', 'credential',
                           'invite_token', 'oidc_client', 'audit_event']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)
                      WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
    IF t <> 'audit_event' THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO landbright_app', t);
    END IF;
  END LOOP;
END
$$;

-- Nobody rewrites history: not even the owner can update or delete an audit row.
CREATE FUNCTION audit_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only';
END
$$;
CREATE TRIGGER audit_event_no_update BEFORE UPDATE OR DELETE ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION audit_event_immutable();
