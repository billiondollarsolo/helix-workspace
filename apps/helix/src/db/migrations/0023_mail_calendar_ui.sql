-- 0021_mail_calendar_ui.sql
-- Backs the redesigned Mail and Calendar UI surfaces with real data:
--   * Mail: category-tab classification + org-defined labels with colours.
--   * Calendar: per-actor calendar subscriptions (My calendars / Team) with a
--     visibility flag and optional colour override.
-- Forward-only, idempotent. Existing mail/calendar tables are left intact.

-- --------------------------------------------------------------------------
-- Mail: category-tab classification
-- --------------------------------------------------------------------------
-- The Mail UI groups inbox threads into Primary / Updates / Promotions / Social
-- tabs. Classification is derived per-thread on ingest (best-effort) and cached
-- on the per-actor thread-state row so the list projection stays a single
-- indexed query. `null` means "not yet classified" and is treated as Primary.
do $$ begin
  create type mail_category_tab as enum ('primary', 'updates', 'promotions', 'social');
exception when duplicate_object then null; end $$;

alter table mail_thread_state
  add column if not exists category mail_category_tab;

create index if not exists mail_thread_state_category_idx
  on mail_thread_state (org_id, actor_id, category);

-- --------------------------------------------------------------------------
-- Mail: org-defined labels with display colours
-- --------------------------------------------------------------------------
-- `mail_thread_state.labels` stores free-form label ids per thread. The UI's
-- label list additionally needs a stable display name + colour per label, which
-- this table provides. Labels are org-scoped and optionally owned by an actor
-- (a `null` owner is a shared/org label).
create table if not exists mail_labels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  owner_actor_id uuid references actors(id),
  slug text not null,
  name text not null,
  color text not null default '#6b7280',
  sort_order integer not null default 100,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists mail_labels_org_owner_slug_active_idx
  on mail_labels (org_id, coalesce(owner_actor_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(slug))
  where deleted_at is null;
create index if not exists mail_labels_org_idx on mail_labels (org_id, deleted_at);
create index if not exists mail_labels_owner_idx on mail_labels (owner_actor_id);

-- --------------------------------------------------------------------------
-- Calendar: per-actor calendar subscriptions
-- --------------------------------------------------------------------------
-- `cal_calendars` records the calendars themselves; this table records which
-- calendars a given actor sees in their sidebar, whether each is currently
-- toggled visible, an optional per-actor colour override, and the actor's
-- relationship to the calendar (owner / writer / reader). The owner of a
-- calendar always has an implicit "owner" membership materialised here.
do $$ begin
  create type cal_membership_role as enum ('owner', 'writer', 'reader');
exception when duplicate_object then null; end $$;

create table if not exists cal_calendar_memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  calendar_id uuid not null references cal_calendars(id) on delete cascade,
  actor_id uuid not null references actors(id),
  role cal_membership_role not null default 'reader',
  visible boolean not null default true,
  color_override text,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists cal_calendar_memberships_actor_calendar_idx
  on cal_calendar_memberships (actor_id, calendar_id);
create index if not exists cal_calendar_memberships_calendar_idx
  on cal_calendar_memberships (calendar_id);
create index if not exists cal_calendar_memberships_org_actor_idx
  on cal_calendar_memberships (org_id, actor_id);

-- Materialise an "owner" membership for every existing calendar so the
-- calendar-list projection has a uniform source of truth from day one.
insert into cal_calendar_memberships (org_id, calendar_id, actor_id, role, visible, sort_order)
select c.org_id, c.id, c.owner_actor_id, 'owner', true, 0
from cal_calendars c
where c.deleted_at is null
on conflict (actor_id, calendar_id) do nothing;
