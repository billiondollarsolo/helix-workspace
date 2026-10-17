create table installation_admin_bootstrap (
  org_id uuid primary key references orgs(id) on delete cascade,
  user_id text references "user"(id) on delete set null,
  initial_password_hash text,
  created_at timestamptz not null default now()
);
alter table installation_admin_bootstrap enable row level security;
alter table installation_admin_bootstrap force row level security;
create policy helix_tenant_isolation on installation_admin_bootstrap
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());
revoke all on installation_admin_bootstrap from public, helix_readonly;
grant select, insert on installation_admin_bootstrap to helix_app;
