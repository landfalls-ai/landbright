-- Spec 005, slice 3: an agent's own application (private_key_jwt with the agent's public keys; one per agent).
ALTER TABLE "oidc_client" ADD COLUMN "agent_id" UUID;
ALTER TABLE "oidc_client" ADD COLUMN "jwks" JSONB;
CREATE UNIQUE INDEX "oidc_client_agent_id_key" ON "oidc_client"("agent_id");
ALTER TABLE "oidc_client" ADD CONSTRAINT "oidc_client_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
