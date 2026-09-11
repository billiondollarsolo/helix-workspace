-- Every active mailbox, alias and group shares one address namespace, including
-- mail-only domains whose addresses intentionally are not login identities.
-- Keep eligibility checks and advisory locks; normalize both sides of collisions.
create or replace function helix_assert_directory_address(
  tenant_id uuid,
  address text,
  address_kind text,
  record_id uuid
)
returns void
language plpgsql
as $$
declare
  normalized text := lower(btrim(address));
  canonical text;
  address_domain text := split_part(normalized, '@', 2);
begin
  if normalized !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception 'invalid_directory_address' using errcode = '23514';
  end if;
  canonical := coalesce(helix_canonical_login_email(tenant_id, normalized), normalized);
  perform pg_advisory_xact_lock(
    hashtextextended('directory-address:' || tenant_id::text || ':' || canonical, 0)
  );

  -- An unmanaged address can bootstrap a workspace, but a name already claimed
  -- by this workspace always follows its lifecycle and capability state.
  if (
    exists (
      select 1 from admin_domains owned
      where owned.org_id = tenant_id and owned.status = 'verified' and owned.identity_enabled
    ) or exists (
      select 1 from admin_domains claimed
      where claimed.org_id = tenant_id and claimed.domain = address_domain
        and claimed.status <> 'released'
    )
  ) and not exists (
    select 1 from admin_domains domain
    where domain.org_id = tenant_id
      and domain.domain = address_domain
      and domain.status = 'verified'
      and case address_kind
        when 'member' then domain.identity_enabled and domain.identity_mode = 'secondary'
        when 'machine' then domain.mail_enabled
        else domain.aliases_enabled and domain.mail_enabled
      end
  ) then
    raise exception 'directory_address_domain_ineligible' using errcode = '23514';
  end if;

  if exists (
    select 1 from actors actor
    where actor.org_id = tenant_id and actor.type in ('user', 'agent', 'service_account') and actor.disabled_at is null
      and (address_kind not in ('member', 'machine') or actor.id <> record_id)
      and coalesce(helix_canonical_login_email(tenant_id, actor.email), lower(btrim(actor.email))) = canonical
    union all
    select 1 from mail_aliases alias
    where alias.org_id = tenant_id and alias.enabled and alias.disabled_at is null
      and (address_kind <> 'alias' or alias.id <> record_id)
      and coalesce(helix_canonical_login_email(tenant_id, alias.email), lower(btrim(alias.email))) = canonical
    union all
    select 1 from admin_groups group_record
    where group_record.org_id = tenant_id and group_record.email is not null
      and (address_kind <> 'group' or group_record.id <> record_id)
      and coalesce(helix_canonical_login_email(tenant_id, group_record.email), lower(btrim(group_record.email))) = canonical
  ) then
    raise exception 'directory_address_collision' using errcode = '23505';
  end if;
end
$$;

create or replace function helix_validate_actor_address()
returns trigger
language plpgsql
as $$
begin
  if new.type = 'user' and new.disabled_at is null and new.email is not null and exists (
    select 1 from organization_memberships membership
    where membership.actor_id = new.id and membership.org_id = new.org_id
      and membership.status = 'active' and membership.guest_type = 'member'
  ) then
    perform helix_assert_directory_address(new.org_id, new.email, 'member', new.id);
  end if;
  if new.type in ('agent', 'service_account') and new.disabled_at is null and new.email is not null then
    perform helix_assert_directory_address(new.org_id, new.email, 'machine', new.id);
  end if;
  return new;
end
$$;

-- Namespace validation must see other users' aliases even when the caller cannot
-- read their mailbox. These no-argument trigger functions disclose no records.
alter function helix_validate_actor_address() security definer;
alter function helix_validate_actor_address() set search_path = pg_catalog, public;
alter function helix_validate_actor_address() owner to helix_migration_owner;
alter function helix_validate_group_address() security definer;
alter function helix_validate_group_address() set search_path = pg_catalog, public;
alter function helix_validate_group_address() owner to helix_migration_owner;
revoke all on function helix_validate_actor_address() from public;
revoke all on function helix_validate_group_address() from public;
