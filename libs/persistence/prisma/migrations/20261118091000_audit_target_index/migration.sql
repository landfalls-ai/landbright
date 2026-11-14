-- CreateIndex
CREATE INDEX "audit_event_tenant_id_target_id_id_idx" ON "audit_event"("tenant_id", "target_id", "id");

