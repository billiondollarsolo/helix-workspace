do $$ begin
  create type mail_outbound_status as enum ('queued', 'cancelled', 'sending', 'sent', 'failed');
exception when duplicate_object then null; end $$;

create table if not exists mail_filters (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  actor_id uuid not null references actors(id),
  name text not null,
  enabled boolean not null default true,
  priority integer not null default 100,
  criteria jsonb not null default '{}',
  actions jsonb not null default '{}',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mail_filters_actor_enabled_idx on mail_filters (actor_id, enabled);
create index if not exists mail_filters_org_priority_idx on mail_filters (org_id, priority);

create table if not exists mail_aliases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  actor_id uuid not null references actors(id),
  email text not null,
  display_name text,
  enabled boolean not null default true,
  is_primary boolean not null default false,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mail_aliases_actor_idx on mail_aliases (actor_id);
create unique index if not exists mail_aliases_org_email_active_idx
  on mail_aliases (org_id, lower(email))
  where disabled_at is null;

create table if not exists mail_vacation (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  actor_id uuid not null references actors(id),
  enabled boolean not null default false,
  subject text not null,
  body text not null,
  starts_at timestamptz,
  ends_at timestamptz,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists mail_vacation_actor_idx on mail_vacation (actor_id);
create index if not exists mail_vacation_org_enabled_idx on mail_vacation (org_id, enabled);

create table if not exists mail_vacation_responses (
  id uuid primary key default gen_random_uuid(),
  vacation_id uuid not null references mail_vacation(id) on delete cascade,
  org_id uuid not null,
  actor_id uuid not null references actors(id),
  sender_email text not null,
  message_id uuid references messages(id),
  thread_id uuid references threads(id),
  sent_at timestamptz not null default now()
);

create unique index if not exists mail_vacation_responses_sender_idx
  on mail_vacation_responses (vacation_id, lower(sender_email));
create index if not exists mail_vacation_responses_actor_idx on mail_vacation_responses (actor_id);

create table if not exists mail_thread_state (
  actor_id uuid not null references actors(id),
  thread_id uuid not null references threads(id) on delete cascade,
  org_id uuid not null,
  labels text[] not null default '{}',
  archived_at timestamptz,
  deleted_at timestamptz,
  snoozed_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (actor_id, thread_id)
);

create index if not exists mail_thread_state_org_labels_idx on mail_thread_state (org_id);
create index if not exists mail_thread_state_snooze_idx on mail_thread_state (snoozed_until);

create table if not exists mail_outbound_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  actor_id uuid not null references actors(id),
  message_id uuid not null references messages(id),
  thread_id uuid not null references threads(id),
  outbox_id uuid references outbox(id),
  status mail_outbound_status not null default 'queued',
  envelope jsonb not null,
  undo_until timestamptz not null,
  sent_at timestamptz,
  cancelled_at timestamptz,
  failed_at timestamptz,
  last_error text,
  provider_message_id text,
  delivery_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mail_outbound_actor_status_idx on mail_outbound_messages (actor_id, status);
create index if not exists mail_outbound_outbox_idx on mail_outbound_messages (outbox_id);
create index if not exists mail_outbound_provider_message_idx
  on mail_outbound_messages (provider_message_id)
  where provider_message_id is not null;
