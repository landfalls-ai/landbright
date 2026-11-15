-- Spec 007, slice 2: start and last days in the person's zone. A person's zone is their site's, else the tenant's.
ALTER TABLE "tenant" ADD COLUMN "time_zone" TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE "tenant" ADD COLUMN "site_time_zones" JSONB NOT NULL DEFAULT '{}';
