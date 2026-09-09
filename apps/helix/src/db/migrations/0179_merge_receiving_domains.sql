-- Local-first installations created the dormant receiving table after their
-- sending table had already been absorbed, so its parent link was never added.
do $$
begin
  if not exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mail_receiving_domains'
      and column_name = 'admin_domain_id') then
    alter table mail_receiving_domains add column admin_domain_id uuid;
    alter table mail_receiving_domains add constraint mail_receiving_domains_parent_org_fk
      foreign key (org_id, admin_domain_id) references admin_domains(org_id, id);
    update mail_receiving_domains receiving set admin_domain_id = domain.id
    from admin_domains domain
    where domain.org_id = receiving.org_id and domain.domain = receiving.domain;
  end if;
end;
$$;

-- Receiving-only domains on main already proved ownership. Preserve their mail
-- capability when adopting the unified domain aggregate.
update admin_domains domain
set mail_enabled = true
from mail_receiving_domains receiving
where receiving.org_id = domain.org_id and receiving.admin_domain_id = domain.id
  and receiving.status = 'active' and receiving.verified_at is not null
  and domain.status = 'verified' and domain.verified_at is not null
  and not domain.mail_enabled;

-- A legacy catch-all is considered only after every exact mailbox, alias and
-- mailing-list match. The canonical domain and principal lifecycle still gate it.
alter function helix_resolve_inbound_mailboxes(text, text, integer)
  rename to helix_resolve_exact_inbound_mailboxes;
revoke all on function helix_resolve_exact_inbound_mailboxes(text, text, integer)
  from public, helix_app, helix_worker, helix_readonly;

create function helix_resolve_inbound_mailboxes(
  requested_address text, requested_domain text, max_recipient_count integer default 100
)
returns table (org_id uuid, actor_id uuid, address text, quota_exceeded boolean)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  return query select * from public.helix_resolve_exact_inbound_mailboxes(
    requested_address, requested_domain, max_recipient_count
  );
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
