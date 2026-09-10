-- Migration 0101 renamed the canonical domain lifecycle column to status.
-- Preserve the owner/session and external-sharing policy gates when repairing
-- the older ACL helper. A missing effective role must also fail closed.
create or replace function helix_set_drive_domain_grant(
  input_org_id uuid, input_actor_id uuid, input_resource_type text, input_resource_id uuid,
  input_domain text, input_role text, input_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare normalized_domain text := lower(btrim(input_domain)); grant_id uuid;
declare policy_mode text; allowed_domains jsonb; require_expiry boolean;
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
    or helix_drive_effective_role(input_org_id, input_actor_id, input_resource_type, input_resource_id) is distinct from 'owner'
  then raise insufficient_privilege using message = 'domain grant requires resource ownership'; end if;
  if not exists (
    select 1 from admin_domains where org_id = input_org_id and lower(domain) = normalized_domain
      and status = 'verified' and verified_at is not null
  ) then
    select settings->>'mode', coalesce(settings->'allowedDomains', '[]'::jsonb),
      coalesce((settings->>'requireExpiry')::boolean, false)
    into policy_mode, allowed_domains, require_expiry
    from admin_security_policies where org_id = input_org_id and policy_type = 'external_sharing'
      and enabled and enforcement <> 'disabled';
    if policy_mode is null or policy_mode = 'blocked'
      or (policy_mode = 'allowlist' and not exists (
        select 1 from jsonb_array_elements_text(allowed_domains) allowed(domain)
        where lower(allowed.domain) = normalized_domain
      ))
    then raise insufficient_privilege using message = 'organization policy blocks this domain'; end if;
    if require_expiry and input_expires_at is null then
      raise check_violation using message = 'organization policy requires domain grant expiry';
    end if;
  end if;
  insert into drive_domain_grants(
    org_id, resource_type, resource_id, domain, role, granted_by_actor_id, expires_at
  ) values (
    input_org_id, input_resource_type, input_resource_id, normalized_domain,
    input_role, input_actor_id, input_expires_at
  ) on conflict (org_id, resource_type, resource_id, domain) do update set
    role = excluded.role, granted_by_actor_id = excluded.granted_by_actor_id,
    expires_at = excluded.expires_at, updated_at = statement_timestamp()
  returning id into grant_id;
  return grant_id;
end
$$;
