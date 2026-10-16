create table agent_source_context (
  org_id uuid not null references orgs(id) on delete cascade,
  actor_id uuid not null,
  source_ids text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (org_id, actor_id),
  foreign key (org_id, actor_id) references actors(org_id, id) on delete cascade,
  check (cardinality(source_ids) <= 128)
);
alter table agent_source_context enable row level security;
alter table agent_source_context force row level security;
create policy agent_source_actor on agent_source_context
  using (org_id=public.helix_current_org_id() and actor_id=public.helix_current_actor_id())
  with check (org_id=public.helix_current_org_id() and actor_id=public.helix_current_actor_id());
create policy helix_tenant_boundary on agent_source_context as restrictive for all
  using (org_id=public.helix_current_org_id()) with check (org_id=public.helix_current_org_id());
grant select, insert, update on agent_source_context to helix_app;
