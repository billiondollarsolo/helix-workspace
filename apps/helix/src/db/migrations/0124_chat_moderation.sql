alter table chat_room_settings
  add column slow_mode_seconds integer not null default 0
    check (slow_mode_seconds between 0 and 86400),
  add column blocked_terms text[] not null default '{}',
  add column allowed_body_formats text[] not null default array['plain', 'markdown'],
  add column allow_external_guests boolean not null default true;

create table chat_moderation_cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  room_id uuid not null,
  reported_message_id uuid,
  reporter_actor_id uuid not null,
  subject_actor_id uuid not null,
  category text not null check (category in (
    'harassment', 'spam', 'compromised_account', 'malicious_attachment', 'guest_abuse', 'other'
  )),
  description text not null check (char_length(btrim(description)) between 1 and 4000),
  status text not null default 'queued'
    check (status in ('queued', 'actioned', 'dismissed', 'appealed', 'resolved')),
  resolution text check (resolution in ('remove_message', 'ban_actor', 'dismiss', 'uphold', 'reinstate')),
  assigned_moderator_actor_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, room_id) references threads(org_id, id) on delete cascade,
  foreign key (org_id, reported_message_id) references messages(org_id, id),
  foreign key (org_id, reporter_actor_id) references actors(org_id, id),
  foreign key (org_id, subject_actor_id) references actors(org_id, id),
  foreign key (org_id, assigned_moderator_actor_id) references actors(org_id, id),
  constraint chat_moderation_case_resolution_shape check (
    (status in ('queued', 'appealed') and resolution is null)
    or (status in ('actioned', 'dismissed', 'resolved') and resolution is not null)
  )
);

create index chat_moderation_cases_queue_idx
  on chat_moderation_cases (org_id, room_id, status, created_at, id);

create table chat_moderation_case_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  case_id uuid not null,
  actor_id uuid not null,
  event_type text not null check (event_type in ('report', 'evidence', 'action', 'appeal', 'decision')),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (org_id, case_id) references chat_moderation_cases(org_id, id) on delete cascade,
  foreign key (org_id, actor_id) references actors(org_id, id)
);

create index chat_moderation_case_events_case_idx
  on chat_moderation_case_events (org_id, case_id, created_at, id);

create table chat_user_blocks (
  org_id uuid not null,
  blocker_actor_id uuid not null,
  blocked_actor_id uuid not null,
  reason text not null default '' check (char_length(reason) <= 1000),
  created_at timestamptz not null default now(),
  primary key (org_id, blocker_actor_id, blocked_actor_id),
  foreign key (org_id, blocker_actor_id) references actors(org_id, id) on delete cascade,
  foreign key (org_id, blocked_actor_id) references actors(org_id, id) on delete cascade,
  check (blocker_actor_id <> blocked_actor_id)
);

create table chat_room_bans (
  org_id uuid not null,
  room_id uuid not null,
  actor_id uuid not null,
  case_id uuid not null,
  banned_by_actor_id uuid not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 2000),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (org_id, room_id, actor_id),
  foreign key (org_id, room_id) references threads(org_id, id) on delete cascade,
  foreign key (org_id, actor_id) references actors(org_id, id) on delete cascade,
  foreign key (org_id, case_id) references chat_moderation_cases(org_id, id),
  foreign key (org_id, banned_by_actor_id) references actors(org_id, id),
  check (expires_at is null or expires_at > created_at)
);

create table chat_abuse_signals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  room_id uuid not null,
  actor_id uuid not null,
  source_message_id uuid,
  signal_type text not null check (signal_type in (
    'harassment', 'spam', 'message_rate', 'compromised_account',
    'malicious_attachment', 'guest_abuse', 'content_control'
  )),
  score integer not null check (score between 1 and 100),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (org_id, room_id) references threads(org_id, id) on delete cascade,
  foreign key (org_id, actor_id) references actors(org_id, id) on delete cascade,
  foreign key (org_id, source_message_id) references messages(org_id, id) on delete cascade
);

create unique index chat_abuse_signals_message_type_idx
  on chat_abuse_signals (org_id, source_message_id, signal_type)
  where source_message_id is not null;
create index chat_abuse_signals_queue_idx
  on chat_abuse_signals (org_id, room_id, created_at desc, id);

create function helix_chat_is_room_member(input_org_id uuid, input_actor_id uuid, input_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from permissions permission
    where chat_permission_is_valid(permission, input_org_id, input_actor_id, input_room_id)
  )
$$;

create function helix_chat_is_room_moderator(
  input_org_id uuid, input_actor_id uuid, input_room_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from permissions permission
    where chat_permission_is_valid(permission, input_org_id, input_actor_id, input_room_id)
      and permission.role in ('owner', 'moderator')
  )
$$;

alter table chat_moderation_cases enable row level security;
alter table chat_moderation_cases force row level security;
create policy chat_moderation_cases_visible on chat_moderation_cases for select
  using (
    org_id = helix_current_org_id()
    and (
      reporter_actor_id = helix_current_actor_id()
      or subject_actor_id = helix_current_actor_id()
      or helix_chat_is_room_moderator(org_id, helix_current_actor_id(), room_id)
    )
  );

alter table chat_moderation_case_events enable row level security;
alter table chat_moderation_case_events force row level security;
create policy chat_moderation_case_events_visible on chat_moderation_case_events for select
  using (
    org_id = helix_current_org_id()
    and exists (
      select 1 from chat_moderation_cases moderation_case
      where moderation_case.org_id = chat_moderation_case_events.org_id
        and moderation_case.id = chat_moderation_case_events.case_id
    )
  );

alter table chat_user_blocks enable row level security;
alter table chat_user_blocks force row level security;
create policy chat_user_blocks_owner on chat_user_blocks for select
  using (org_id = helix_current_org_id() and blocker_actor_id = helix_current_actor_id());

alter table chat_room_bans enable row level security;
alter table chat_room_bans force row level security;
create policy chat_room_bans_visible on chat_room_bans for select
  using (
    org_id = helix_current_org_id()
    and (
      actor_id = helix_current_actor_id()
      or helix_chat_is_room_moderator(org_id, helix_current_actor_id(), room_id)
    )
  );

alter table chat_abuse_signals enable row level security;
alter table chat_abuse_signals force row level security;
create policy chat_abuse_signals_moderator on chat_abuse_signals for select
  using (
    org_id = helix_current_org_id()
    and helix_chat_is_room_moderator(org_id, helix_current_actor_id(), room_id)
  );

create function helix_chat_moderation_outbox(
  input_verb text,
  input_org_id uuid,
  input_actor_id uuid,
  input_room_id uuid,
  input_case_id uuid,
  input_details jsonb default '{}'::jsonb
)
returns void
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  insert into outbox (subject, payload)
  values (
    'activity.chat.moderation.' || input_verb,
    jsonb_build_object(
      'version', 1,
      'orgId', input_org_id,
      'actorId', input_actor_id,
      'roomId', input_room_id,
      'caseId', input_case_id
    ) || input_details
  )
$$;

create function helix_report_chat_abuse(
  input_org_id uuid,
  input_actor_id uuid,
  input_room_id uuid,
  input_message_id uuid,
  input_subject_actor_id uuid,
  input_category text,
  input_description text,
  input_evidence jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  new_case_id uuid;
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
    or not helix_chat_is_room_member(input_org_id, input_actor_id, input_room_id)
    or not exists (
      select 1 from actors subject
      where subject.org_id = input_org_id and subject.id = input_subject_actor_id
    )
    or not helix_chat_is_room_member(input_org_id, input_subject_actor_id, input_room_id)
    or (
      input_message_id is not null and not exists (
        select 1 from messages message
        where message.org_id = input_org_id
          and message.id = input_message_id
          and message.thread_id = input_room_id
          and message.actor_id = input_subject_actor_id
          and message.kind = 'chat'
      )
    )
  then
    raise insufficient_privilege using message = 'chat report is outside the actor room boundary';
  end if;

  insert into chat_moderation_cases (
    org_id, room_id, reported_message_id, reporter_actor_id,
    subject_actor_id, category, description
  ) values (
    input_org_id, input_room_id, input_message_id, input_actor_id,
    input_subject_actor_id, input_category, input_description
  ) returning id into new_case_id;

  insert into chat_moderation_case_events (org_id, case_id, actor_id, event_type, evidence)
  values (input_org_id, new_case_id, input_actor_id, 'report', coalesce(input_evidence, '{}'::jsonb));
  insert into chat_abuse_signals (
    org_id, room_id, actor_id, source_message_id, signal_type, score, evidence
  ) values (
    input_org_id, input_room_id, input_subject_actor_id, input_message_id,
    case when input_category = 'other' then 'content_control' else input_category end,
    50, jsonb_build_object('caseId', new_case_id)
  );
  perform helix_chat_moderation_outbox(
    'reported', input_org_id, input_actor_id, input_room_id, new_case_id,
    jsonb_build_object('category', input_category)
  );
  return new_case_id;
end
$$;

create function helix_set_chat_block(
  input_org_id uuid,
  input_actor_id uuid,
  input_blocked_actor_id uuid,
  input_blocked boolean,
  input_reason text default ''
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
    or input_actor_id = input_blocked_actor_id
    or not exists (
      select 1 from actors target
      where target.org_id = input_org_id and target.id = input_blocked_actor_id
    )
  then
    raise insufficient_privilege using message = 'chat block boundary rejected';
  end if;
  if input_blocked then
    insert into chat_user_blocks (org_id, blocker_actor_id, blocked_actor_id, reason)
    values (input_org_id, input_actor_id, input_blocked_actor_id, input_reason)
    on conflict (org_id, blocker_actor_id, blocked_actor_id) do update
      set reason = excluded.reason, created_at = now();
  else
    delete from chat_user_blocks
    where org_id = input_org_id
      and blocker_actor_id = input_actor_id
      and blocked_actor_id = input_blocked_actor_id;
  end if;
  perform helix_chat_moderation_outbox(
    case when input_blocked then 'blocked' else 'unblocked' end,
    input_org_id, input_actor_id, null, null,
    jsonb_build_object('blockedActorId', input_blocked_actor_id)
  );
  return true;
end
$$;

create function helix_configure_chat_moderation(
  input_org_id uuid,
  input_actor_id uuid,
  input_room_id uuid,
  input_slow_mode_seconds integer,
  input_blocked_terms text[],
  input_allowed_body_formats text[],
  input_allow_external_guests boolean
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
    or not helix_chat_is_room_moderator(input_org_id, input_actor_id, input_room_id)
    or input_slow_mode_seconds not between 0 and 86400
    or cardinality(input_blocked_terms) > 100
    or exists (select 1 from unnest(input_blocked_terms) term where char_length(btrim(term)) not between 1 and 100)
    or cardinality(input_allowed_body_formats) = 0
    or not input_allowed_body_formats <@ array['plain', 'markdown']::text[]
  then
    raise insufficient_privilege using message = 'chat moderation controls rejected';
  end if;
  update chat_room_settings
  set slow_mode_seconds = input_slow_mode_seconds,
      blocked_terms = input_blocked_terms,
      allowed_body_formats = input_allowed_body_formats,
      allow_external_guests = input_allow_external_guests,
      updated_at = now()
  where org_id = input_org_id and thread_id = input_room_id;
  perform helix_chat_moderation_outbox(
    'controls.updated', input_org_id, input_actor_id, input_room_id, null,
    jsonb_build_object('slowModeSeconds', input_slow_mode_seconds)
  );
  return true;
end
$$;

create function helix_moderate_chat_case(
  input_org_id uuid,
  input_actor_id uuid,
  input_case_id uuid,
  input_action text,
  input_reason text,
  input_ban_expires_at timestamptz,
  input_evidence jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  moderation_case chat_moderation_cases%rowtype;
  moderator_role text;
  subject_role text;
  case_found boolean;
  message_revision bigint;
  message_deleted_at timestamptz;
begin
  select * into moderation_case
  from chat_moderation_cases where org_id = input_org_id and id = input_case_id
  for update;
  case_found := found;
  select permission.role into moderator_role
  from permissions permission
  where chat_permission_is_valid(permission, input_org_id, input_actor_id, moderation_case.room_id)
    and permission.role in ('owner', 'moderator')
  order by case permission.role when 'owner' then 0 else 1 end limit 1;
  select permission.role into subject_role
  from permissions permission
  where chat_permission_is_valid(
    permission, input_org_id, moderation_case.subject_actor_id, moderation_case.room_id
  ) order by case permission.role when 'owner' then 0 when 'moderator' then 1 else 2 end limit 1;

  if not case_found
    or helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
    or moderator_role is null
    or input_actor_id = moderation_case.subject_actor_id
    or (
      moderation_case.status = 'queued'
      and input_action not in ('remove_message', 'ban_actor', 'dismiss')
    )
    or (
      moderation_case.status = 'appealed'
      and input_action not in ('uphold', 'reinstate')
    )
    or moderation_case.status not in ('queued', 'appealed')
    or subject_role = 'owner'
    or (
      moderation_case.status = 'queued'
      and moderator_role = 'moderator'
      and subject_role is distinct from 'member'
    )
  then
    raise insufficient_privilege using message = 'chat moderation action rejected';
  end if;

  if input_action = 'remove_message' then
    if moderation_case.reported_message_id is null then
      raise check_violation using message = 'remove action requires a reported message';
    end if;
    update messages
    set deleted_at = now(), updated_at = now()
    where org_id = input_org_id
      and id = moderation_case.reported_message_id
      and thread_id = moderation_case.room_id
      and deleted_at is null
    returning chat_revision, deleted_at into message_revision, message_deleted_at;
    if not found then
      raise check_violation using message = 'reported message is already removed';
    end if;
    perform append_chat_room_event(
      input_org_id,
      moderation_case.room_id,
      jsonb_build_object(
        'version', 1,
        'type', 'message.deleted',
        'actorId', input_actor_id,
        'messageId', moderation_case.reported_message_id,
        'revision', message_revision,
        'deletedAt', message_deleted_at
      )
    );
  elsif input_action = 'ban_actor' then
    insert into chat_room_bans (
      org_id, room_id, actor_id, case_id, banned_by_actor_id, reason, expires_at
    ) values (
      input_org_id, moderation_case.room_id, moderation_case.subject_actor_id,
      input_case_id, input_actor_id, input_reason, input_ban_expires_at
    ) on conflict (org_id, room_id, actor_id) do update
      set case_id = excluded.case_id,
          banned_by_actor_id = excluded.banned_by_actor_id,
          reason = excluded.reason,
          expires_at = excluded.expires_at,
          revoked_at = null,
          created_at = now();
    update permissions
    set status = 'revoked', revoked_at = now(), revocation_epoch = revocation_epoch + 1
    where org_id = input_org_id
      and resource_type = 'thread'
      and resource_id = moderation_case.room_id
      and actor_id = moderation_case.subject_actor_id
      and status = 'active';
  elsif input_action = 'reinstate' then
    update chat_room_bans set revoked_at = now()
    where org_id = input_org_id
      and room_id = moderation_case.room_id
      and actor_id = moderation_case.subject_actor_id
      and revoked_at is null;
  end if;

  update chat_moderation_cases
  set status = case
        when input_action = 'dismiss' then 'dismissed'
        when input_action in ('uphold', 'reinstate') then 'resolved'
        else 'actioned'
      end,
      resolution = input_action,
      assigned_moderator_actor_id = input_actor_id,
      updated_at = now()
  where id = input_case_id and org_id = input_org_id;
  insert into chat_moderation_case_events (org_id, case_id, actor_id, event_type, evidence)
  values (
    input_org_id, input_case_id, input_actor_id,
    case when input_action in ('uphold', 'reinstate') then 'decision' else 'action' end,
    coalesce(input_evidence, '{}'::jsonb) || jsonb_build_object('action', input_action, 'reason', input_reason)
  );
  perform helix_chat_moderation_outbox(
    'actioned', input_org_id, input_actor_id, moderation_case.room_id, input_case_id,
    jsonb_build_object('action', input_action, 'subjectActorId', moderation_case.subject_actor_id)
  );
  return true;
end
$$;

create function helix_appeal_chat_case(
  input_org_id uuid,
  input_actor_id uuid,
  input_case_id uuid,
  input_reason text,
  input_evidence jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  room_id uuid;
begin
  update chat_moderation_cases
  set status = 'appealed', resolution = null, updated_at = now()
  where org_id = input_org_id
    and id = input_case_id
    and subject_actor_id = input_actor_id
    and status = 'actioned'
  returning chat_moderation_cases.room_id into room_id;
  if not found
    or helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
  then
    raise insufficient_privilege using message = 'chat moderation appeal rejected';
  end if;
  insert into chat_moderation_case_events (org_id, case_id, actor_id, event_type, evidence)
  values (
    input_org_id, input_case_id, input_actor_id, 'appeal',
    coalesce(input_evidence, '{}'::jsonb) || jsonb_build_object('reason', input_reason)
  );
  perform helix_chat_moderation_outbox(
    'appealed', input_org_id, input_actor_id, room_id, input_case_id
  );
  return true;
end
$$;

create function helix_add_chat_case_evidence(
  input_org_id uuid,
  input_actor_id uuid,
  input_case_id uuid,
  input_evidence jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  moderation_case chat_moderation_cases%rowtype;
begin
  select * into moderation_case from chat_moderation_cases
  where org_id = input_org_id and id = input_case_id;
  if not found
    or helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
    or (
      input_actor_id not in (moderation_case.reporter_actor_id, moderation_case.subject_actor_id)
      and not helix_chat_is_room_moderator(input_org_id, input_actor_id, moderation_case.room_id)
    )
  then
    raise insufficient_privilege using message = 'chat moderation evidence rejected';
  end if;
  insert into chat_moderation_case_events (org_id, case_id, actor_id, event_type, evidence)
  values (input_org_id, input_case_id, input_actor_id, 'evidence', input_evidence);
  perform helix_chat_moderation_outbox(
    'evidence.added', input_org_id, input_actor_id, moderation_case.room_id, input_case_id
  );
  return true;
end
$$;

create function helix_enforce_chat_moderation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  controls chat_room_settings%rowtype;
begin
  if new.kind <> 'chat' or new.actor_id is null then return new; end if;
  select * into controls from chat_room_settings
  where org_id = new.org_id and thread_id = new.thread_id;
  if not found then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    new.org_id::text || ':' || new.thread_id::text || ':' || new.actor_id::text, 1313
  ));
  if exists (
    select 1 from chat_room_bans ban
    where ban.org_id = new.org_id and ban.room_id = new.thread_id and ban.actor_id = new.actor_id
      and ban.revoked_at is null and (ban.expires_at is null or ban.expires_at > now())
  ) then raise insufficient_privilege using message = 'chat actor is banned'; end if;
  if exists (
    select 1
    from threads room
    join permissions other_member
      on other_member.org_id = room.org_id and other_member.resource_id = room.id
    join chat_user_blocks block
      on block.org_id = room.org_id
     and ((block.blocker_actor_id = new.actor_id and block.blocked_actor_id = other_member.actor_id)
       or (block.blocked_actor_id = new.actor_id and block.blocker_actor_id = other_member.actor_id))
    where room.org_id = new.org_id and room.id = new.thread_id and room.kind = 'chat_dm'
      and other_member.actor_id <> new.actor_id
      and chat_permission_is_valid(other_member, new.org_id, other_member.actor_id, new.thread_id)
  ) then raise insufficient_privilege using message = 'chat direct message is blocked'; end if;
  if not controls.allow_external_guests and exists (
    select 1 from organization_memberships membership
    where membership.org_id = new.org_id and membership.actor_id = new.actor_id
      and membership.guest_type <> 'member'
  ) then raise insufficient_privilege using message = 'external guest posting disabled'; end if;
  if controls.slow_mode_seconds > 0 and exists (
    select 1 from messages prior
    where prior.org_id = new.org_id and prior.thread_id = new.thread_id
      and prior.actor_id = new.actor_id and prior.kind = 'chat'
      and prior.sent_at > new.sent_at - make_interval(secs => controls.slow_mode_seconds)
  ) then raise check_violation using message = 'chat slow mode active'; end if;
  if not new.body_format = any(controls.allowed_body_formats)
    or exists (
      select 1 from unnest(controls.blocked_terms) term
      where position(lower(term) in lower(new.body)) > 0
    )
  then raise check_violation using message = 'chat content control rejected message'; end if;
  return new;
end
$$;

create trigger messages_enforce_chat_moderation
before insert on messages
for each row execute function helix_enforce_chat_moderation();

create function helix_record_chat_rate_signal()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  recent_count integer;
begin
  if new.kind <> 'chat' or new.actor_id is null then return new; end if;
  select count(*)::integer into recent_count from messages message
  where message.org_id = new.org_id and message.thread_id = new.thread_id
    and message.actor_id = new.actor_id and message.kind = 'chat'
    and message.sent_at >= new.sent_at - interval '1 minute';
  if recent_count >= 5 then
    insert into chat_abuse_signals (
      org_id, room_id, actor_id, source_message_id, signal_type, score, evidence
    ) values (
      new.org_id, new.thread_id, new.actor_id, new.id, 'message_rate',
      least(100, recent_count * 10), jsonb_build_object('messagesPerMinute', recent_count)
    ) on conflict (org_id, source_message_id, signal_type) where source_message_id is not null
      do nothing;
  end if;
  return new;
end
$$;

create trigger messages_record_chat_rate_signal
after insert on messages
for each row execute function helix_record_chat_rate_signal();

create function helix_chat_abuse_signal_outbox()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform helix_chat_moderation_outbox(
    'signal.detected', new.org_id, new.actor_id, new.room_id, null,
    jsonb_build_object('signalId', new.id, 'signalType', new.signal_type, 'score', new.score)
  );
  return new;
end
$$;

create trigger chat_abuse_signals_emit_outbox
after insert on chat_abuse_signals
for each row execute function helix_chat_abuse_signal_outbox();

create function helix_block_chat_case_event_mutation()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin raise integrity_constraint_violation using message = 'chat moderation evidence is append-only'; end
$$;
create trigger chat_moderation_case_events_no_update_or_delete
before update or delete on chat_moderation_case_events
for each row execute function helix_block_chat_case_event_mutation();
create trigger chat_moderation_case_events_no_truncate
before truncate on chat_moderation_case_events
for each statement execute function helix_block_chat_case_event_mutation();

revoke all on chat_moderation_cases, chat_moderation_case_events, chat_user_blocks,
  chat_room_bans, chat_abuse_signals from public, helix_readonly;
revoke insert, update, delete, truncate on chat_moderation_cases, chat_moderation_case_events,
  chat_user_blocks, chat_room_bans, chat_abuse_signals from helix_app, helix_worker;
grant select on chat_moderation_cases, chat_moderation_case_events, chat_user_blocks,
  chat_room_bans, chat_abuse_signals to helix_app;
revoke execute on function helix_chat_is_room_member(uuid, uuid, uuid),
  helix_chat_is_room_moderator(uuid, uuid, uuid),
  helix_chat_moderation_outbox(text, uuid, uuid, uuid, uuid, jsonb)
from public;
grant execute on function helix_chat_is_room_member(uuid, uuid, uuid),
  helix_chat_is_room_moderator(uuid, uuid, uuid)
to helix_app;
revoke execute on function helix_report_chat_abuse(uuid, uuid, uuid, uuid, uuid, text, text, jsonb),
  helix_set_chat_block(uuid, uuid, uuid, boolean, text),
  helix_configure_chat_moderation(uuid, uuid, uuid, integer, text[], text[], boolean),
  helix_moderate_chat_case(uuid, uuid, uuid, text, text, timestamptz, jsonb),
  helix_appeal_chat_case(uuid, uuid, uuid, text, jsonb),
  helix_add_chat_case_evidence(uuid, uuid, uuid, jsonb)
from public;
grant execute on function helix_report_chat_abuse(uuid, uuid, uuid, uuid, uuid, text, text, jsonb),
  helix_set_chat_block(uuid, uuid, uuid, boolean, text),
  helix_configure_chat_moderation(uuid, uuid, uuid, integer, text[], text[], boolean),
  helix_moderate_chat_case(uuid, uuid, uuid, text, text, timestamptz, jsonb),
  helix_appeal_chat_case(uuid, uuid, uuid, text, jsonb),
  helix_add_chat_case_evidence(uuid, uuid, uuid, jsonb)
to helix_app;
