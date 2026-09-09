-- One fail-closed authority check shared by every durable credential path.
-- In the current greenfield identity model an actor row is the organization
-- membership; IAM-01 can change this function without rewriting callers.
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
    from public.actors a
    join public.orgs o on o.id = a.org_id
    where a.id = principal_actor_id
      and a.org_id = tenant_org_id
      and a.disabled_at is null
      and o.status = 'active'
  )
$$;
