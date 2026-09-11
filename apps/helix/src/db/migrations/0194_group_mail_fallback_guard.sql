-- A known group that failed current delivery eligibility must never become a
-- catch-all, legacy group expansion, or external SMTP destination.
alter function helix_resolve_non_group_inbound_mailboxes(text, text, integer)
  rename to helix_resolve_legacy_inbound_mailboxes;

create function helix_resolve_non_group_inbound_mailboxes(
  requested_address text, requested_domain text, max_recipient_count integer default 100
)
returns table (org_id uuid, actor_id uuid, address text, quota_exceeded boolean)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if exists (
    select 1 from public.admin_domains domain
    left join public.admin_domains target on target.org_id = domain.org_id
      and target.id = domain.alias_target_domain_id
    join public.admin_groups group_record on group_record.org_id = domain.org_id
    join public.admin_domains group_domain on group_domain.org_id = group_record.org_id
      and group_domain.domain = split_part(lower(group_record.email), '@', 2)
    left join public.admin_domains group_target on group_target.org_id = group_domain.org_id
      and group_target.id = group_domain.alias_target_domain_id
    where domain.domain = lower(btrim(requested_domain)) and domain.status <> 'released'
      and domain.domain = split_part(lower(btrim(requested_address)), '@', 2)
      and group_record.kind = 'mailing_list'
      and split_part(lower(group_record.email), '@', 1) = split_part(lower(btrim(requested_address)), '@', 1)
      and case group_domain.identity_mode when 'alias' then group_target.domain else group_domain.domain end
        = case domain.identity_mode when 'alias' then target.domain else domain.domain end
  ) then
    raise insufficient_privilege using message = 'mail_group_unavailable';
  end if;
  return query select * from public.helix_resolve_legacy_inbound_mailboxes(
    requested_address, requested_domain, max_recipient_count
  );
end;
$$;
alter function helix_resolve_non_group_inbound_mailboxes(text, text, integer) owner to helix_migration_owner;
revoke all on function helix_resolve_non_group_inbound_mailboxes(text, text, integer)
  from public, helix_app, helix_worker, helix_readonly;
