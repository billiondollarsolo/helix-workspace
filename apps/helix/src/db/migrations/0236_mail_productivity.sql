alter table mail_thread_state
  add column follow_up_state text not null default 'automatic'
    check (follow_up_state in ('automatic','needs_reply','waiting_on','done')),
  add column follow_up_message_id uuid;

create table mail_productivity_preferences (
  org_id uuid not null,
  actor_id uuid not null,
  settings jsonb not null default '{}'::jsonb,
  next_run_at timestamptz not null default now(),
  filing_cursor_at timestamptz,
  filing_cursor_id uuid,
  updated_at timestamptz not null default now(),
  primary key(org_id,actor_id),
  foreign key(org_id,actor_id) references actors(org_id,id) on delete cascade
);
create table mail_productivity_artifacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  actor_id uuid not null,
  kind text not null check(kind in ('reply','brief','digest','filing')),
  source_key text not null check(length(source_key) <= 300),
  thread_id uuid references threads(id) on delete cascade,
  message_id uuid references messages(id) on delete cascade,
  event_id uuid references cal_events(id) on delete cascade,
  status text not null default 'working' check(status in ('working','ready','failed')),
  body text not null default '' check(length(body) <= 32000),
  object_id uuid references objects(id) on delete set null,
  error text,
  lease_token uuid not null default gen_random_uuid(),
  lease_until timestamptz not null default now() + interval '5 minutes',
  attempts integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  unique(org_id,actor_id,kind,source_key),
  foreign key(org_id,actor_id) references actors(org_id,id) on delete cascade
);
create index mail_productivity_due on mail_productivity_preferences(next_run_at);
create index mail_productivity_expiry on mail_productivity_artifacts(org_id,actor_id,expires_at);
alter table mail_productivity_preferences enable row level security;
alter table mail_productivity_preferences force row level security;
alter table mail_productivity_artifacts enable row level security;
alter table mail_productivity_artifacts force row level security;
create policy mail_productivity_owner on mail_productivity_preferences
  using(org_id=helix_current_org_id() and actor_id=helix_current_actor_id())
  with check(org_id=helix_current_org_id() and actor_id=helix_current_actor_id());
create policy mail_productivity_owner on mail_productivity_artifacts
  using(org_id=helix_current_org_id() and actor_id=helix_current_actor_id())
  with check(org_id=helix_current_org_id() and actor_id=helix_current_actor_id());
revoke all on mail_productivity_preferences,mail_productivity_artifacts from public,helix_readonly;
grant select,insert,update,delete on mail_productivity_preferences,mail_productivity_artifacts to helix_app,helix_worker;

create function helix_mail_productivity_work(batch_limit integer)
returns table(org_id uuid,actor_id uuid)
language plpgsql security definer set search_path=pg_catalog,public set row_security=off as $$
begin
  if batch_limit not between 1 and 100 then raise exception 'Invalid productivity batch'; end if;
  if nullif(current_setting('helix.org_id',true),'') is not null or nullif(current_setting('helix.actor_id',true),'') is not null then
    raise exception 'Productivity discovery is restricted to the worker';
  end if;
  return query select p.org_id,p.actor_id from mail_productivity_preferences p
    join actors a on a.org_id=p.org_id and a.id=p.actor_id
    where p.next_run_at<=now() and a.type='user' and a.disabled_at is null
    order by p.next_run_at limit batch_limit;
end $$;
revoke all on function helix_mail_productivity_work(integer) from public,helix_app,helix_readonly;
grant execute on function helix_mail_productivity_work(integer) to helix_worker;
