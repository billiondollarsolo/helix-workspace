-- Personal, client-encrypted KDBX files. Never ordinary Drive objects or agent secrets.
create table password_vaults (
  org_id uuid not null references orgs(id) on delete cascade,
  actor_id uuid not null,
  version bigint not null check (version between 1 and 9007199254740991),
  ciphertext bytea not null check (octet_length(ciphertext) between 64 and 1048576),
  previous_ciphertext bytea,
  previous_updated_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (org_id, actor_id),
  foreign key (org_id, actor_id) references actors(org_id, id) on delete cascade,
  check ((previous_ciphertext is null) = (previous_updated_at is null)),
  check (previous_ciphertext is null or octet_length(previous_ciphertext) between 64 and 1048576)
);
alter table password_vaults enable row level security;
alter table password_vaults force row level security;
create policy password_vault_owner on password_vaults
  using (org_id = public.helix_current_org_id() and actor_id = public.helix_current_actor_id())
  with check (org_id = public.helix_current_org_id() and actor_id = public.helix_current_actor_id());
create policy helix_tenant_boundary on password_vaults as restrictive for all
  using (org_id = public.helix_current_org_id())
  with check (org_id = public.helix_current_org_id());
grant select, insert, update on password_vaults to helix_app;
