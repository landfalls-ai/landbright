-- A second sign-in step (TOTP), and room for passkeys.

-- credential: the TOTP replay guard / passkey signature counter, the passkey's id and transports, a label.
ALTER TABLE "credential" ADD COLUMN     "counter" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "external_id" TEXT,
ADD COLUMN     "label" TEXT,
ADD COLUMN     "transports" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE UNIQUE INDEX "credential_external_id_key" ON "credential"("external_id");

-- tenant: whether everyone must use a second step. The app may change this one column (Settings) and nothing else in
-- the tenant table; it still can't create or rename tenants.
ALTER TABLE "tenant" ADD COLUMN     "mfa_required" BOOLEAN NOT NULL DEFAULT false;

GRANT UPDATE ("mfa_required") ON "tenant" TO landbright_app;
