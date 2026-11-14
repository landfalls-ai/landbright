-- Spec 005, access follow-ups: extensions, subscriptions an application manages itself.
ALTER TABLE "access_request" ADD COLUMN "extends_grant_id" UUID;
CREATE INDEX "access_request_extends_grant_id_idx" ON "access_request"("extends_grant_id");
ALTER TABLE "access_grant" ADD COLUMN "extensions" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "event_subscription" ADD COLUMN "owner_client_id" TEXT;
