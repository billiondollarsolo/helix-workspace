-- 0163 gave agent_credentials an org_id after the permissive tenant sweep (0033),
-- and 0185 then added only the restrictive tenant boundary. With forced RLS and no
-- permissive policy, the constrained API role could read no credential rows at all,
-- so OAuth client lookups failed with "Unknown OAuth client". Install the same
-- permissive tenant policy every other org_id table carries.
drop policy if exists helix_tenant_isolation on agent_credentials;
create policy helix_tenant_isolation on agent_credentials
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
