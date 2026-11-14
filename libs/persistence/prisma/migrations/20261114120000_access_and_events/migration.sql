-- Just-in-time access and events out (spec 004): bundles, requests, votes, grants and their targets, service notes,
-- and the subscriptions and deliveries that carry audit events to Landflow flows. Every table is tenant-owned and
-- isolated by row-level security like the rest.

-- CreateEnum
CREATE TYPE "access_request_status" AS ENUM ('pending', 'approved', 'denied', 'expired', 'cancelled', 'superseded');

-- CreateEnum
CREATE TYPE "grant_status" AS ENUM ('scheduled', 'active', 'expired', 'revoked');

-- AlterTable
ALTER TABLE "membership" ADD COLUMN     "grant_id" UUID;

-- identity: the last sign-in, so a scheduled Landflow flow can find inactive people (Keycloak's inactivity workflow).
ALTER TABLE "identity" ADD COLUMN     "last_sign_in_at" TIMESTAMP(3);

-- oidc_client: what an application may do as itself on the machine API (/api/v1, client credentials).
ALTER TABLE "oidc_client" ADD COLUMN     "api_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "access_bundle" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "owner_id" UUID,
    "group_ids" UUID[],
    "targets" JSONB NOT NULL DEFAULT '[]',
    "policy" JSONB NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_bundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_request" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "bundle_id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "acting_for_id" UUID,
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "ticket" JSONB,
    "duration_seconds" INTEGER NOT NULL,
    "starts_at" TIMESTAMP(3),
    "deadline" TIMESTAMP(3) NOT NULL,
    "status" "access_request_status" NOT NULL DEFAULT 'pending',
    "method" TEXT,
    "policy_snapshot" JSONB NOT NULL,
    "approvers" JSONB NOT NULL,
    "current_step" INTEGER NOT NULL DEFAULT 0,
    "auto_approval" JSONB,
    "break_glass" JSONB,
    "closing_reason" TEXT,
    "decided_at" TIMESTAMP(3),
    "superseded_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_decision" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "step_index" INTEGER NOT NULL,
    "decider_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "comment" TEXT,
    "channel" TEXT NOT NULL,
    "assurance" TEXT NOT NULL,
    "submitted_by" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_grant" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "bundle_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "status" "grant_status" NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "activated_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),
    "closing_reason" TEXT,
    "expiring_sent_at" TIMESTAMP(3),
    "overdue_sent_at" TIMESTAMP(3),
    "is_break_glass" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grant_target" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "grant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "managed_by" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "external_ref" TEXT,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grant_target_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "annotation" (
    "tenant_id" UUID NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "annotation_pkey" PRIMARY KEY ("target_id","key")
);

-- CreateTable
CREATE TABLE "event_subscription" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "description" TEXT,
    "audience" TEXT NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "cursor" BIGINT NOT NULL DEFAULT 0,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_delivery" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "audit_event_id" BIGINT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_status" INTEGER,
    "last_error" TEXT,
    "response" JSONB,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "access_bundle_tenant_id_name_key" ON "access_bundle"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "access_request_tenant_id_status_idx" ON "access_request"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "access_request_tenant_id_subject_id_idx" ON "access_request"("tenant_id", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "access_request_tenant_id_number_key" ON "access_request"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "access_decision_request_id_decider_id_key" ON "access_decision"("request_id", "decider_id");

-- CreateIndex
CREATE UNIQUE INDEX "access_grant_request_id_key" ON "access_grant"("request_id");

-- CreateIndex
CREATE INDEX "access_grant_tenant_id_status_idx" ON "access_grant"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "access_grant_tenant_id_subject_id_idx" ON "access_grant"("tenant_id", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "grant_target_grant_id_key_key" ON "grant_target"("grant_id", "key");

-- CreateIndex
CREATE INDEX "annotation_tenant_id_idx" ON "annotation"("tenant_id");

-- CreateIndex
CREATE INDEX "event_subscription_tenant_id_idx" ON "event_subscription"("tenant_id");

-- CreateIndex
CREATE INDEX "event_delivery_tenant_id_status_next_attempt_at_idx" ON "event_delivery"("tenant_id", "status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "event_delivery_subscription_id_audit_event_id_key" ON "event_delivery"("subscription_id", "audit_event_id");

-- AddForeignKey
ALTER TABLE "access_request" ADD CONSTRAINT "access_request_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "access_bundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_decision" ADD CONSTRAINT "access_decision_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "access_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "access_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant_target" ADD CONSTRAINT "grant_target_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "access_grant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_delivery" ADD CONSTRAINT "event_delivery_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "event_subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security, as for every tenant-owned table (see 20261112113500_rls_unset_tenant).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['access_bundle', 'access_request', 'access_decision', 'access_grant', 'grant_target',
                           'annotation', 'event_subscription', 'event_delivery']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
                      WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO landbright_app', t);
  END LOOP;
END
$$;
