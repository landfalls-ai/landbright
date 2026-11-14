-- Spec 006: provisioning out. Landbright as the SCIM 2.0 client: targets, what each holds, and what is queued.
-- CreateTable
CREATE TABLE "scim_target" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "token_sealed" TEXT NOT NULL,
    "groups_mode" TEXT NOT NULL DEFAULT 'groups',
    "group_ids" UUID[],
    "client_id" UUID,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "cursor" BIGINT NOT NULL DEFAULT 0,
    "last_reconciled_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scim_target_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_link" (
    "tenant_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "local_id" UUID NOT NULL,
    "remote_id" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scim_link_pkey" PRIMARY KEY ("target_id","kind","local_id")
);

-- CreateTable
CREATE TABLE "scim_job" (
    "tenant_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "local_id" UUID NOT NULL,
    "verify" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scim_job_pkey" PRIMARY KEY ("target_id","kind","local_id")
);

-- CreateIndex
CREATE INDEX "scim_target_tenant_id_idx" ON "scim_target"("tenant_id");

-- CreateIndex
CREATE INDEX "scim_link_tenant_id_idx" ON "scim_link"("tenant_id");

-- CreateIndex
CREATE INDEX "scim_job_tenant_id_next_attempt_at_idx" ON "scim_job"("tenant_id", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "scim_target" ADD CONSTRAINT "scim_target_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oidc_client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_link" ADD CONSTRAINT "scim_link_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "scim_target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_job" ADD CONSTRAINT "scim_job_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "scim_target"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security, as for every tenant-owned table (see 20261112113500_rls_unset_tenant).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['scim_target', 'scim_link', 'scim_job']
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
