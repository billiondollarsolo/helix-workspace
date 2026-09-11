alter table admin_groups add column posting_policy text not null default 'organization'
  check (posting_policy in ('organization', 'anyone'));

-- Keep legacy direct mailboxes/aliases/catch-all resolution as a private fallback.
-- Every public resolver and routing-rule target retains this canonical entrypoint.
alter function helix_resolve_inbound_mailboxes(text, text, integer)
  rename to helix_resolve_non_group_inbound_mailboxes;
revoke all on function helix_resolve_non_group_inbound_mailboxes(text, text, integer)
  from public, helix_app, helix_worker, helix_readonly;

create function helix_resolve_inbound_mailboxes_for_sender(
  requested_address text, requested_domain text, sender_authenticated boolean, max_recipient_count integer default 100
)
returns table (org_id uuid, actor_id uuid, address text, quota_exceeded boolean)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  destination public.admin_groups%rowtype;
  recipient_count integer;
begin
  if max_recipient_count < 1 or max_recipient_count > 1000 then
    raise invalid_parameter_value using message = 'invalid recipient expansion limit';
  end if;
  select group_record.* into destination
  from public.admin_domains domain
  join public.orgs org on org.id = domain.org_id
  join public.admin_groups group_record on group_record.org_id = domain.org_id
  join public.admin_domains group_domain on group_domain.org_id = group_record.org_id
    and group_domain.domain = split_part(lower(group_record.email), '@', 2)
  where domain.domain = lower(btrim(requested_domain))
    and domain.domain = split_part(lower(btrim(requested_address)), '@', 2)
    and domain.status = 'verified' and domain.verified_at is not null
    and domain.mail_enabled and domain.aliases_enabled
    and group_domain.status = 'verified' and group_domain.verified_at is not null
    and group_domain.mail_enabled and group_domain.aliases_enabled
    and org.status = 'active' and org.suspended_at is null
    and org.soft_deleted_at is null and org.hard_deleted_at is null
    and group_record.kind = 'mailing_list'
    and coalesce(public.helix_canonical_login_email(domain.org_id, group_record.email), lower(group_record.email))
      = coalesce(public.helix_canonical_login_email(domain.org_id, requested_address), lower(btrim(requested_address)))
  limit 1;

  if not found then
    return query select * from public.helix_resolve_non_group_inbound_mailboxes(
      requested_address, requested_domain, max_recipient_count
    );
    return;
  end if;

  -- SMTP is unauthenticated, even when its envelope/header claims a local address.
  -- Local dispatch sets this context only from the authenticated queued principal.
  if destination.posting_policy = 'organization' and not (
    sender_authenticated is true
    and public.helix_current_org_id() is not distinct from destination.org_id
    and public.helix_current_actor_id() is not null
    and public.helix_mailbox_principal_is_active(destination.org_id, public.helix_current_actor_id())
  ) then
    raise insufficient_privilege using message = 'mail_group_posting_denied';
  end if;

  select count(distinct member.actor_id)::integer into recipient_count
  from public.admin_group_members member
  join public.actors actor on actor.org_id = member.org_id and actor.id = member.actor_id
  join public.organization_memberships membership
    on membership.org_id = actor.org_id and membership.actor_id = actor.id
  where member.org_id = destination.org_id and member.group_id = destination.id
    and actor.type = 'user' and actor.disabled_at is null and actor.email is not null
    and membership.status = 'active' and membership.guest_type = 'member';
  if recipient_count = 0 then
    raise no_data_found using message = 'mail_group_no_recipients';
  end if;
  if recipient_count > max_recipient_count then
    raise program_limit_exceeded using message = 'mail recipient expansion limit exceeded';
  end if;

  return query
  select distinct member.org_id, member.actor_id, lower(actor.email),
    coalesce(public.helix_authoritative_storage_usage_bytes(member.org_id)
      >= public.helix_storage_limit_bytes(member.org_id), false)
  from public.admin_group_members member
  join public.actors actor on actor.org_id = member.org_id and actor.id = member.actor_id
  join public.organization_memberships membership
    on membership.org_id = actor.org_id and membership.actor_id = actor.id
  where member.org_id = destination.org_id and member.group_id = destination.id
    and actor.type = 'user' and actor.disabled_at is null and actor.email is not null
    and membership.status = 'active' and membership.guest_type = 'member';
end;
$$;
alter function helix_resolve_inbound_mailboxes_for_sender(text, text, boolean, integer) owner to helix_migration_owner;
revoke all on function helix_resolve_inbound_mailboxes_for_sender(text, text, boolean, integer) from public;
grant execute on function helix_resolve_inbound_mailboxes_for_sender(text, text, boolean, integer) to helix_app;

-- Inbound tools and routing rules remain external even inside an authenticated
-- service-account transaction. Only trusted outbound dispatch opts in explicitly.
create function helix_resolve_inbound_mailboxes(
  requested_address text, requested_domain text, max_recipient_count integer default 100
)
returns table (org_id uuid, actor_id uuid, address text, quota_exceeded boolean)
language sql stable security definer set search_path = pg_catalog, public as $$
  select * from public.helix_resolve_inbound_mailboxes_for_sender(
    requested_address, requested_domain, false, max_recipient_count
  )
$$;
alter function helix_resolve_inbound_mailboxes(text, text, integer) owner to helix_migration_owner;
revoke all on function helix_resolve_inbound_mailboxes(text, text, integer) from public;
grant execute on function helix_resolve_inbound_mailboxes(text, text, integer) to helix_app;
