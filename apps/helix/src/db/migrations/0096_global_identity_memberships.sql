-- A human identity is global; its authority is an organization membership.
-- Product data continues to refer to the tenant-local actor row, keeping the
-- hot authorization path small while allowing one login to enter many orgs.

create table if not exists identity_subjects (
  id uuid primary key default gen_random_uuid(),
  canonical_email text,
  display_name text not null default '',
  status text not null default 'active'
    check (status in ('active', 'suspended', 'deleted')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint identity_subjects_email_normalized check (
    canonical_email is null
    or (
      canonical_email = lower(btrim(canonical_email))
      and char_length(canonical_email) between 3 and 320
      and position('@' in canonical_email) > 1
      and position('@' in canonical_email) < char_length(canonical_email)
    )
  )
);

create unique index if not exists identity_subjects_email_idx
  on identity_subjects (lower(canonical_email))
  where canonical_email is not null;

create table if not exists identity_provider_subjects (
  provider text not null check (provider ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  provider_subject text not null check (char_length(provider_subject) between 1 and 512),
  subject_id uuid not null references identity_subjects(id) on delete cascade,
  email_at_link text,
  last_authenticated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, provider_subject)
);

create index if not exists identity_provider_subjects_subject_idx
  on identity_provider_subjects (subject_id);

create unique index if not exists actors_org_id_id_unique_idx
  on actors (org_id, id);
create unique index if not exists admin_org_units_org_id_id_unique_idx
  on admin_org_units (org_id, id);

create table if not exists organization_memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  subject_id uuid not null references identity_subjects(id) on delete cascade,
  actor_id uuid not null,
  status text not null default 'active'
    check (status in ('active', 'suspended', 'deprovisioned')),
  roles text[] not null default '{}',
  org_unit_id uuid,
  guest_type text not null default 'member'
    check (guest_type in ('member', 'external', 'partner')),
  joined_at timestamptz not null default now(),
  suspended_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_memberships_subject_org_unique unique (subject_id, org_id),
  constraint organization_memberships_actor_unique unique (actor_id),
  constraint organization_memberships_actor_org_fk
    foreign key (org_id, actor_id) references actors(org_id, id) on delete cascade,
  constraint organization_memberships_org_unit_org_fk
    foreign key (org_id, org_unit_id) references admin_org_units(org_id, id)
    on delete set null (org_unit_id),
  constraint organization_memberships_lifecycle check (
    (status = 'active' and suspended_at is null and ended_at is null)
    or (status = 'suspended' and suspended_at is not null and ended_at is null)
    or (status = 'deprovisioned' and ended_at is not null)
  )
);

create index if not exists organization_memberships_org_status_idx
  on organization_memberships (org_id, status, subject_id);
create index if not exists organization_memberships_subject_idx
  on organization_memberships (subject_id, status);

-- Backfill one canonical subject per normalized verified/login email. Actors
-- without an email still receive a private subject so every existing human
-- principal has an explicit membership.
insert into identity_subjects (canonical_email, display_name)
select source.email, min(source.display_name)
from (
  select lower(btrim(email)) as email, display_name
  from actors
  where type = 'user' and email is not null and btrim(email) <> ''
  union all
  select lower(btrim(email)), name
  from "user"
  where btrim(email) <> ''
) source
group by source.email
on conflict ((lower(canonical_email))) where canonical_email is not null do nothing;

insert into identity_subjects (id, canonical_email, display_name, metadata)
select a.id, null, a.display_name, jsonb_build_object('sourceActorId', a.id)
from actors a
where a.type = 'user'
  and (a.email is null or btrim(a.email) = '')
on conflict (id) do nothing;

insert into organization_memberships (
  org_id, subject_id, actor_id, status, roles, guest_type,
  suspended_at, joined_at, created_at, updated_at
)
select
  a.org_id,
  s.id,
  a.id,
  case when a.disabled_at is null then 'active' else 'suspended' end,
  a.scopes,
  case
    when a.metadata->>'guestType' in ('external', 'partner') then a.metadata->>'guestType'
    else 'member'
  end,
  a.disabled_at,
  a.created_at,
  a.created_at,
  a.updated_at
from actors a
join identity_subjects s
  on (a.email is not null and s.canonical_email = lower(btrim(a.email)))
  or ((a.email is null or btrim(a.email) = '') and s.id = a.id)
where a.type = 'user'
on conflict (actor_id) do nothing;

-- The Better Auth user id is the stable local provider subject. Import the
-- canonical user row first, then any historical metadata links.
insert into identity_provider_subjects (
  provider, provider_subject, subject_id, email_at_link, last_authenticated_at
)
select 'better-auth', u.id, s.id, lower(btrim(u.email)), null
from "user" u
join identity_subjects s on s.canonical_email = lower(btrim(u.email))
on conflict (provider, provider_subject) do nothing;

-- The old user.actor_id pointer could represent only one organization and is
-- no longer read by authentication, MFA, SCIM, seeds, or verification.
alter table "user" drop column if exists actor_id;

insert into identity_provider_subjects (
  provider, provider_subject, subject_id, email_at_link, last_authenticated_at
)
select distinct on (a.metadata->'betterAuth'->>'userId')
  'better-auth',
  a.metadata->'betterAuth'->>'userId',
  m.subject_id,
  lower(btrim(a.email)),
  null
from actors a
join organization_memberships m on m.actor_id = a.id and m.org_id = a.org_id
where a.type = 'user'
  and a.email is not null
  and coalesce(a.metadata->'betterAuth'->>'userId', '') <> ''
order by a.metadata->'betterAuth'->>'userId', a.created_at, a.id
on conflict (provider, provider_subject) do nothing;

alter table organization_memberships enable row level security;
alter table organization_memberships force row level security;
drop policy if exists helix_tenant_isolation on organization_memberships;
create policy helix_tenant_isolation on organization_memberships
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

-- Every newly provisioned human actor receives its membership immediately;
-- callers cannot forget the new identity boundary. The trigger is the only
-- definer path and can insert only the row derived from NEW.
create or replace function helix_create_human_membership()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  normalized_email text := nullif(lower(btrim(new.email)), '');
  new_subject_id uuid;
begin
  if new.type <> 'user' then
    return new;
  end if;

  perform set_config('helix.org_id', new.org_id::text, true);
  if normalized_email is null then
    insert into identity_subjects (id, display_name, metadata)
    values (new.id, new.display_name, jsonb_build_object('sourceActorId', new.id))
    on conflict (id) do nothing
    returning id into new_subject_id;
    new_subject_id := coalesce(new_subject_id, new.id);
  else
    perform pg_advisory_xact_lock(hashtextextended('email:' || normalized_email, 0));
    insert into identity_subjects (canonical_email, display_name)
    values (normalized_email, new.display_name)
    on conflict ((lower(canonical_email))) where canonical_email is not null
    do update set updated_at = identity_subjects.updated_at
    returning id into new_subject_id;
  end if;

  insert into organization_memberships (
    org_id, subject_id, actor_id, status, roles, guest_type, suspended_at
  ) values (
    new.org_id,
    new_subject_id,
    new.id,
    case when new.disabled_at is null then 'active' else 'suspended' end,
    new.scopes,
    case
      when new.metadata->>'guestType' in ('external', 'partner') then new.metadata->>'guestType'
      else 'member'
    end,
    new.disabled_at
  );
  return new;
end
$$;

drop trigger if exists actors_create_human_membership on actors;
create trigger actors_create_human_membership
after insert on actors
for each row execute function helix_create_human_membership();

-- Resolve or activate a membership as one concurrency-safe operation. The two
-- advisory locks serialize both provider-subject and verified-email races;
-- unique constraints remain the final database boundary.
create or replace function helix_activate_identity_membership(
  target_provider text,
  target_provider_subject text,
  target_org_id uuid,
  verified_email text,
  verified_display_name text default ''
)
returns uuid
language plpgsql
volatile
strict
security invoker
set search_path = pg_catalog, public
as $$
declare
  normalized_email text := lower(btrim(verified_email));
  resolved_subject_id uuid;
  resolved_actor_id uuid;
begin
  if target_provider !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
     or char_length(target_provider_subject) not between 1 and 512
     or char_length(normalized_email) not between 3 and 320
     or position('@' in normalized_email) <= 1
     or position('@' in normalized_email) >= char_length(normalized_email) then
    return null;
  end if;

  perform set_config('helix.org_id', target_org_id::text, true);
  perform pg_advisory_xact_lock(hashtextextended(target_provider || ':' || target_provider_subject, 0));
  perform pg_advisory_xact_lock(hashtextextended('email:' || normalized_email, 0));

  select link.subject_id
  into resolved_subject_id
  from identity_provider_subjects link
  where link.provider = target_provider
    and link.provider_subject = target_provider_subject
  for update;

  if resolved_subject_id is null then
    -- Prefer the identity already attached to the matching tenant actor. This
    -- preserves SCIM/admin renames without allowing the tenant to rewrite the
    -- global subject's canonical address.
    select membership.subject_id
    into resolved_subject_id
    from actors actor
    join organization_memberships membership
      on membership.org_id = actor.org_id and membership.actor_id = actor.id
    where actor.org_id = target_org_id
      and actor.type = 'user'
      and lower(btrim(actor.email)) = normalized_email
    for update of membership;

    if resolved_subject_id is null then
      insert into identity_subjects (canonical_email, display_name)
      values (normalized_email, coalesce(verified_display_name, ''))
      on conflict ((lower(canonical_email))) where canonical_email is not null
      do update set updated_at = identity_subjects.updated_at
      returning id into resolved_subject_id;
    end if;

    insert into identity_provider_subjects (
      provider, provider_subject, subject_id, email_at_link, last_authenticated_at
    ) values (
      target_provider, target_provider_subject, resolved_subject_id, normalized_email, now()
    );
  end if;

  perform 1
  from identity_subjects subject
  where subject.id = resolved_subject_id and subject.status = 'active';
  if not found then
    return null;
  end if;

  select membership.actor_id
  into resolved_actor_id
  from organization_memberships membership
  join actors actor
    on actor.org_id = membership.org_id and actor.id = membership.actor_id
  join orgs organization on organization.id = membership.org_id
  where membership.org_id = target_org_id
    and membership.subject_id = resolved_subject_id
    and membership.status = 'active'
    and actor.type = 'user'
    and actor.disabled_at is null
    and organization.status = 'active'
  for update of membership;

  if resolved_actor_id is null then
    -- A suspended/deprovisioned membership is never implicitly reactivated.
    if exists (
      select 1 from organization_memberships membership
      where membership.org_id = target_org_id
        and membership.subject_id = resolved_subject_id
    ) then
      return null;
    end if;

    select actor.id
    into resolved_actor_id
    from actors actor
    join orgs organization on organization.id = actor.org_id
    where actor.org_id = target_org_id
      and actor.type = 'user'
      and actor.disabled_at is null
      and lower(btrim(actor.email)) = normalized_email
      and organization.status = 'active'
    for update of actor;

    if resolved_actor_id is null then
      return null;
    end if;

    insert into organization_memberships (
      org_id, subject_id, actor_id, roles, guest_type
    )
    select actor.org_id, resolved_subject_id, actor.id, actor.scopes,
      case
        when actor.metadata->>'guestType' in ('external', 'partner')
          then actor.metadata->>'guestType'
        else 'member'
      end
    from actors actor
    where actor.id = resolved_actor_id and actor.org_id = target_org_id;
  end if;

  update identity_provider_subjects
  set last_authenticated_at = now(),
      email_at_link = normalized_email,
      updated_at = now()
  where provider = target_provider and provider_subject = target_provider_subject;

  return resolved_actor_id;
end
$$;

-- Every durable credential now requires an active global subject and active
-- tenant membership in addition to the tenant-local actor and organization.
create or replace function helix_credential_principal_is_active(
  principal_actor_id uuid,
  tenant_org_id uuid
)
returns boolean
language sql
stable
parallel safe
security invoker
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.actors actor
    join public.orgs organization on organization.id = actor.org_id
    where actor.id = principal_actor_id
      and actor.org_id = tenant_org_id
      and actor.disabled_at is null
      and organization.status = 'active'
      and (
        actor.type <> 'user'
        or exists (
          select 1
          from public.organization_memberships membership
          join public.identity_subjects subject on subject.id = membership.subject_id
          where membership.actor_id = actor.id
            and membership.org_id = actor.org_id
            and membership.status = 'active'
            and subject.status = 'active'
        )
      )
  )
$$;
