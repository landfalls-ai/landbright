-- AlterTable
ALTER TABLE "oidc_client" ADD COLUMN     "backchannel_logout_uri" TEXT;

-- CreateTable
CREATE TABLE "logout_delivery" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "sid" TEXT,
    "reason" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),

    CONSTRAINT "logout_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "logout_delivery_tenant_id_delivered_at_failed_at_next_attem_idx" ON "logout_delivery"("tenant_id", "delivered_at", "failed_at", "next_attempt_at");

-- CreateIndex
CREATE INDEX "logout_delivery_tenant_id_subject_idx" ON "logout_delivery"("tenant_id", "subject");


-- Row-level security, as for every tenant-owned table (see 20261112113500_rls_unset_tenant).
ALTER TABLE "logout_delivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "logout_delivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "logout_delivery"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "logout_delivery" TO landbright_app;
