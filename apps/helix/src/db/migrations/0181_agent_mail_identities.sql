-- Mail authority belongs to the authenticated principal. Human memberships
-- retain their lifecycle/guest checks; agent and service identities own only
-- explicitly assigned addresses within a verified tenant mail domain.
-- Refuse ambiguous case variants instead of delivering one principal's mail to another.
create unique index actors_org_active_email_canonical_idx
  on actors (org_id, lower(email)) where email is not null and disabled_at is null;

create function helix_mailbox_principal_is_active(tenant_id uuid, principal_id uuid)
returns boolean language sql stable security invoker set search_path = pg_catalog, public as $$
  select exists (
    select 1 from public.actors actor
    join public.orgs org on org.id = actor.org_id
    where actor.org_id = tenant_id and actor.id = principal_id
      and public.helix_credential_principal_is_active(actor.id, actor.org_id)
      and org.suspended_at is null and org.soft_deleted_at is null and org.hard_deleted_at is null
      and (actor.type in ('agent', 'service_account') or
        (actor.type = 'user' and exists (
          select 1 from public.organization_memberships membership
          where membership.org_id = actor.org_id and membership.actor_id = actor.id
            and membership.status = 'active' and membership.guest_type = 'member'
        )))
  );
$$;
alter function helix_mailbox_principal_is_active(uuid, uuid) owner to helix_migration_owner;
revoke all on function helix_mailbox_principal_is_active(uuid, uuid) from public;
grant execute on function helix_mailbox_principal_is_active(uuid, uuid) to helix_app, helix_worker;

create or replace function helix_resolve_inbound_mailboxes(
  requested_address text, requested_domain text, max_recipient_count integer default 100
)
returns table (org_id uuid, actor_id uuid, address text, quota_exceeded boolean)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  return query select * from public.helix_resolve_exact_inbound_mailboxes(
    requested_address, requested_domain, max_recipient_count
  );
  if found then return; end if;

  -- Machine identities own their primary mailbox without a human membership.
  return query
  select actor.org_id, actor.id, lower(actor.email),
    coalesce(public.helix_authoritative_storage_usage_bytes(actor.org_id)
      >= public.helix_storage_limit_bytes(actor.org_id), false)
  from public.actors actor
  join public.admin_domains domain on domain.org_id = actor.org_id
  where domain.domain = lower(btrim(requested_domain))
    and domain.domain = split_part(lower(btrim(requested_address)), '@', 2)
    and domain.status = 'verified' and domain.mail_enabled and domain.verified_at is not null
    and actor.type in ('agent', 'service_account')
    and lower(actor.email) = lower(btrim(requested_address))
    and public.helix_mailbox_principal_is_active(actor.org_id, actor.id)
  limit max_recipient_count;
  if found then return; end if;

  return query
  select actor.org_id, actor.id, lower(actor.email),
    coalesce(public.helix_authoritative_storage_usage_bytes(actor.org_id)
      >= public.helix_storage_limit_bytes(actor.org_id), false)
  from public.mail_receiving_domains receiving
  join public.admin_domains domain
    on domain.org_id = receiving.org_id and domain.id = receiving.admin_domain_id
  join public.orgs org on org.id = domain.org_id
  join public.actors actor
    on actor.org_id = receiving.org_id and actor.id = receiving.catch_all_actor_id
  join public.organization_memberships membership
    on membership.org_id = actor.org_id and membership.actor_id = actor.id
  where receiving.domain = lower(btrim(requested_domain))
    and domain.domain = receiving.domain
    and domain.domain = split_part(lower(btrim(requested_address)), '@', 2)
    and receiving.status = 'active' and receiving.verified_at is not null
    and domain.status = 'verified' and domain.mail_enabled and domain.verified_at is not null
    and org.status = 'active' and org.suspended_at is null
    and org.soft_deleted_at is null and org.hard_deleted_at is null
    and actor.type = 'user' and actor.disabled_at is null and actor.email is not null
    and membership.status = 'active' and membership.guest_type = 'member'
  limit 1;
end;
$$;
alter function helix_resolve_inbound_mailboxes(text, text, integer)
  owner to helix_migration_owner;
revoke all on function helix_resolve_inbound_mailboxes(text, text, integer) from public;
grant execute on function helix_resolve_inbound_mailboxes(text, text, integer) to helix_app;
