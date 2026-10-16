create function helix_agent_runtime_admin_access(tenant_id uuid, writable boolean)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with principal as (
    select actor.scopes, actor.type,
      public.helix_actor_role_bindings(actor.org_id, actor.id) as bindings
    from public.actors actor
    where actor.org_id = tenant_id and tenant_id = public.helix_current_org_id()
      and actor.id = public.helix_current_actor_id()
      and public.helix_credential_principal_is_active(actor.id, actor.org_id)
  ), org_bindings as (
    select binding from principal, jsonb_array_elements(principal.bindings) binding
    where binding->>'scopeType' = 'org'
  ), permissions(permission) as (
    values ('admin.agents'), ('admin.console.write')
    union all select 'admin.console.read' where not writable
    union all select 'admin.users' where not writable
  )
  select exists (
    select 1 from principal
    where principal.type='user' and not exists (select 1 from org_bindings where binding->'deny' ? 'admin.agents')
      and exists (
        select 1 from permissions
        where not exists (select 1 from org_bindings where binding->'deny' ? permissions.permission)
          and (
            principal.type = 'system'
            or principal.scopes && array[permissions.permission, 'admin.*', '*']
            or exists (select 1 from org_bindings where binding->'allow' ? permissions.permission)
          )
      )
  )
$$;

alter function helix_agent_runtime_admin_access(uuid, boolean) owner to helix_migration_owner;
revoke all on function helix_agent_runtime_admin_access(uuid, boolean) from public;
grant execute on function helix_agent_runtime_admin_access(uuid, boolean) to helix_app;

create table agent_runtimes (
 org_id uuid not null references orgs(id), actor_id uuid primary key,
 config jsonb not null, version integer not null default 1,
 cursor bigint not null default 0 check(cursor>=0),
 processing_cursor bigint, processing_at timestamptz,
 conversation_id uuid, last_error text, last_run_at timestamptz,
 waiting_approval boolean not null default false,
 window_started_at timestamptz not null default now(), window_turns integer not null default 0,
 updated_at timestamptz not null default now(),
 foreign key(org_id,actor_id) references actors(org_id,id)
);
alter table agent_runtimes enable row level security;
alter table agent_runtimes force row level security;
create policy tenant_boundary on agent_runtimes as restrictive for all
 using(org_id=helix_current_org_id()) with check(org_id=helix_current_org_id());
create policy actor_access on agent_runtimes for all using(actor_id=helix_current_actor_id()) with check(actor_id=helix_current_actor_id());
create policy admin_read on agent_runtimes for select using(helix_agent_runtime_admin_access(org_id,false));
create policy admin_insert on agent_runtimes for insert with check(helix_agent_runtime_admin_access(org_id,true));
create policy admin_update on agent_runtimes for update using(helix_agent_runtime_admin_access(org_id,true)) with check(helix_agent_runtime_admin_access(org_id,true));
alter table agent_runtimes owner to helix_migration_owner;
grant select,insert,update on agent_runtimes to helix_app;

-- Worker discovery returns identifiers only; all content reads re-enter actor RLS.
create function helix_hosted_agent_ids() returns table(org_id uuid, actor_id uuid)
language sql stable security definer set search_path=pg_catalog,public set row_security=off as $$
 select r.org_id,r.actor_id from agent_runtimes r join actors a on a.id=r.actor_id and a.org_id=r.org_id
 where helix_current_actor_id() is null and r.config->>'mode'='helix' and r.config->>'enabled'='true' and r.last_error is null
 and a.disabled_at is null order by r.actor_id
$$;
alter function helix_hosted_agent_ids() owner to helix_migration_owner;
revoke all on function helix_hosted_agent_ids() from public;
grant execute on function helix_hosted_agent_ids() to helix_app;

create function helix_agent_event_head(tenant uuid, target uuid) returns bigint
language sql stable security definer set search_path=pg_catalog,public set row_security=off as $$
 select coalesce((select next_sequence from actor_event_state where org_id=tenant and actor_id=target),0)
 where tenant=helix_current_org_id() and (target=helix_current_actor_id() or helix_agent_runtime_admin_access(tenant,false))
$$;
alter function helix_agent_event_head(uuid,uuid) owner to helix_migration_owner;
revoke all on function helix_agent_event_head(uuid,uuid) from public;
grant execute on function helix_agent_event_head(uuid,uuid) to helix_app;
