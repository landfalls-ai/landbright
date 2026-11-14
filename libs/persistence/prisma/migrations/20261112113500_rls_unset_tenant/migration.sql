-- Outside a withTenant() transaction app.tenant_id is unset, or '' on a pooled connection that once ran SET LOCAL
-- (the setting reverts to the empty string, not to NULL). '' cast to uuid raises an error; NULLIF turns both cases
-- into NULL, so nothing matches and the table simply looks empty.
--
-- FORCE (in the first migration) makes the policy bind a table owner that is not a superuser. Superusers bypass
-- row-level security whatever the table says, so only migrations and the bootstrap connect as one.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['identity', 'person_profile', 'agent_profile', 'group', 'membership', 'credential',
                           'invite_token', 'oidc_client', 'audit_event']
  LOOP
    EXECUTE format('DROP POLICY tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
                      WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END
$$;
