-- CreateTable
CREATE TABLE "source_link" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_values" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "source_link_tenant_id_source_source_id_key" ON "source_link"("tenant_id", "source", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_link_identity_id_source_key" ON "source_link"("identity_id", "source");

-- AddForeignKey
ALTER TABLE "source_link" ADD CONSTRAINT "source_link_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security, as for every tenant-owned table (see 20261112113500_rls_unset_tenant).
ALTER TABLE "source_link" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_link" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "source_link"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "source_link" TO landbright_app;
