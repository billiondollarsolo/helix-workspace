-- Helix Agent Defender: per-agent receive policy, Held folder, and mail-loop jobs.

alter table mail_thread_state
  add column if not exists held_at timestamptz;

create index if not exists mail_thread_state_held_idx
  on mail_thread_state (org_id, actor_id, held_at)
  where held_at is not null;

create table agent_defender_policies (
  org_id uuid not null,
  actor_id uuid not null,
  owner_actor_id uuid not null,
  receive_mode text not null default 'allowlist'
    check (receive_mode in ('allowlist', 'open')),
  loop_enabled boolean not null default false,
  allowed_senders text[] not null default '{}',
  allow_send boolean not null default false,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (org_id, actor_id),
  foreign key (org_id, actor_id) references actors (org_id, id) on delete cascade,
  foreign key (org_id, owner_actor_id) references actors (org_id, id) on delete restrict
);

create index agent_defender_policies_owner_idx
  on agent_defender_policies (org_id, owner_actor_id);

create table agent_defender_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  agent_actor_id uuid not null,
  message_id uuid not null,
  thread_id uuid not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'skipped', 'failed')),
  attempts integer not null default 0,
  last_error text,
  canary text not null,
  created_at timestamptz not null default statement_timestamp(),
  processed_at timestamptz,
  unique (org_id, agent_actor_id, message_id),
  foreign key (org_id, agent_actor_id) references actors (org_id, id) on delete cascade
);

create index agent_defender_jobs_due_idx
  on agent_defender_jobs (status, created_at)
  where status = 'pending';

alter table agent_defender_policies enable row level security;
alter table agent_defender_policies force row level security;
create policy helix_tenant_isolation on agent_defender_policies
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

-- Loop jobs are claimed globally by the worker (same pattern as assistant_routines).
-- Policy rows stay tenant-RLS; jobs are keyed by org_id + agent actor FK.

create function helix_agent_defender_set_hold(
  input_org_id uuid,
  input_operator_id uuid,
  input_agent_id uuid,
  input_thread_id uuid,
  input_action text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if input_action not in ('release', 'junk') then
    raise invalid_parameter_value using message = 'Defender action must be release or junk';
  end if;
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_operator_id
  then
    raise insufficient_privilege using message = 'Defender hold requires the current actor';
  end if;
  if not exists (
    select 1 from public.agent_defender_policies policy
    where policy.org_id = input_org_id
      and policy.actor_id = input_agent_id
      and policy.owner_actor_id = input_operator_id
  ) then
    raise insufficient_privilege using message = 'Only the agent owner can decide held mail';
  end if;
  if input_action = 'release' then
    update public.mail_thread_state
    set held_at = null, updated_at = statement_timestamp()
    where org_id = input_org_id and actor_id = input_agent_id and thread_id = input_thread_id
      and held_at is not null;
  else
    update public.mail_thread_state
    set spam_at = coalesce(spam_at, statement_timestamp()),
        held_at = null,
        updated_at = statement_timestamp()
    where org_id = input_org_id and actor_id = input_agent_id and thread_id = input_thread_id
      and held_at is not null;
  end if;
  return found;
end;
$$;
alter function helix_agent_defender_set_hold(uuid, uuid, uuid, uuid, text)
  owner to helix_migration_owner;
revoke all on function helix_agent_defender_set_hold(uuid, uuid, uuid, uuid, text) from public;
grant execute on function helix_agent_defender_set_hold(uuid, uuid, uuid, uuid, text)
  to helix_app;

create function helix_agent_defender_list_holds(
  input_org_id uuid,
  input_operator_id uuid
)
returns table (
  agent_actor_id uuid,
  thread_id uuid,
  held_at timestamptz,
  subject text,
  from_address text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
#variable_conflict use_column
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_operator_id
  then
    raise insufficient_privilege using message = 'Defender holds require the current actor';
  end if;
  return query
  select
    state.actor_id,
    state.thread_id,
    state.held_at,
    coalesce(thread.subject, ''),
    coalesce(message.metadata->'from'->>'address', '')
  from public.mail_thread_state state
  join public.agent_defender_policies policy
    on policy.org_id = state.org_id and policy.actor_id = state.actor_id
  join public.threads thread
    on thread.id = state.thread_id and thread.org_id = state.org_id
  left join lateral (
    select metadata
    from public.messages
    where org_id = state.org_id and thread_id = state.thread_id and kind = 'mail'
    order by sent_at desc
    limit 1
  ) message on true
  where state.org_id = input_org_id
    and policy.owner_actor_id = input_operator_id
    and state.held_at is not null
    and state.deleted_at is null
  order by state.held_at desc;
end;
$$;
alter function helix_agent_defender_list_holds(uuid, uuid)
  owner to helix_migration_owner;
revoke all on function helix_agent_defender_list_holds(uuid, uuid) from public;
grant execute on function helix_agent_defender_list_holds(uuid, uuid) to helix_app;
