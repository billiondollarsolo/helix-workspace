-- 0198 created assistant_routines after the tenant RLS sweeps (0091, 0185), so
-- it shipped without row-level security. Install the same contract every other
-- org_id table carries: forced RLS, the permissive tenant policy, and the
-- restrictive tenant boundary that the schema gate verifies.
alter table assistant_routines enable row level security;
alter table assistant_routines force row level security;

drop policy if exists helix_tenant_isolation on assistant_routines;
create policy helix_tenant_isolation on assistant_routines
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

drop policy if exists helix_tenant_boundary on assistant_routines;
create policy helix_tenant_boundary on assistant_routines as restrictive for all
  using (org_id = public.helix_current_org_id())
  with check (org_id = public.helix_current_org_id());
