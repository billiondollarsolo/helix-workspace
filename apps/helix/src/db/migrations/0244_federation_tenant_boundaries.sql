create policy helix_tenant_boundary on installation_admin_bootstrap as restrictive for all
  using(org_id=helix_current_org_id()) with check(org_id=helix_current_org_id());
create policy helix_tenant_boundary on federation_applications as restrictive for all
  using(org_id=helix_current_org_id()) with check(org_id=helix_current_org_id());
create policy helix_tenant_boundary on federation_app_assignments as restrictive for all
  using(org_id=helix_current_org_id()) with check(org_id=helix_current_org_id());
