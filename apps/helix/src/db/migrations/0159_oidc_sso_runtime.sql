-- Official Better Auth OIDC SSO runtime. Tenant IdP configuration remains the
-- admin source of truth; this table is the minimal projection consumed by the
-- maintained protocol implementation. It contains no client secret or key.
create table if not exists "ssoProvider" (
  id text primary key,
  issuer text not null,
  "oidcConfig" text,
  "samlConfig" text,
  "userId" text references "user"(id) on delete set null,
  "providerId" text not null unique,
  "organizationId" text,
  domain text not null,
  "domainVerified" boolean not null default false,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  constraint better_auth_sso_oidc_only check ("oidcConfig" is not null and "samlConfig" is null)
);

create index if not exists better_auth_sso_domain_idx on "ssoProvider" (domain);

-- SAML was only a metadata-shaped placeholder. Keep old configuration
-- invisible and inactive rather than exposing an ACS route that does not exist.
update tenant_idp_configs
set enabled = false, is_primary = false, updated_at = now()
where protocol = 'saml';

update tenant_idp_configs set jit_provisioning = false where jit_provisioning;

create or replace function helix_sync_oidc_sso_provider(target_config_id uuid)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  source record;
begin
  select
    config.id,
    config.org_id,
    config.config,
    config.attr_mapping,
    config.signing_cert_secret_handle,
    config.created_at,
    string_agg(lower(domain.domain), ',' order by lower(domain.domain)) as domains
  into source
  from tenant_idp_configs config
  join orgs organization
    on organization.id = config.org_id
   and organization.status = 'active'
   and organization.suspended_at is null
   and organization.soft_deleted_at is null
   and organization.hard_deleted_at is null
  join admin_domains domain
    on domain.org_id = config.org_id
   and domain.status = 'verified'
   and domain.identity_enabled
   and domain.federation_enabled
  where config.id = target_config_id
    and config.protocol = 'oidc'
    and config.enabled
    and config.is_primary
    and config.signing_cert_secret_handle is not null
    and nullif(config.config->>'issuer', '') is not null
    and nullif(config.config->>'clientId', '') is not null
  group by config.id;

  if source.id is null then
    delete from "ssoProvider" where id = target_config_id::text;
    return;
  end if;

  insert into "ssoProvider" (
    id, issuer, "oidcConfig", "samlConfig", "providerId", "organizationId",
    domain, "domainVerified", "createdAt", "updatedAt"
  ) values (
    source.id::text,
    source.config->>'issuer',
    jsonb_strip_nulls(jsonb_build_object(
      'issuer', source.config->>'issuer',
      'clientId', source.config->>'clientId',
      'discoveryEndpoint', coalesce(
        source.config->>'metadataUrl',
        rtrim(source.config->>'issuer', '/') || '/.well-known/openid-configuration'
      ),
      'tokenEndpointAuthentication', 'private_key_jwt',
      'privateKeyId', source.signing_cert_secret_handle,
      'pkce', true,
      'scopes', coalesce(source.config->'scopes', '["openid","email","profile"]'::jsonb),
      'mapping', jsonb_strip_nulls(jsonb_build_object(
        'email', nullif(regexp_replace(source.attr_mapping->>'email', '^[$][.]', ''), ''),
        'name', nullif(regexp_replace(source.attr_mapping->>'displayName', '^[$][.]', ''), '')
      ))
    ))::text,
    null,
    'helix-oidc-' || source.org_id::text || '-' || source.id::text,
    source.org_id::text,
    source.domains,
    true,
    source.created_at,
    now()
  )
  on conflict (id) do update set
    issuer = excluded.issuer,
    "oidcConfig" = excluded."oidcConfig",
    "samlConfig" = null,
    "providerId" = excluded."providerId",
    "organizationId" = excluded."organizationId",
    domain = excluded.domain,
    "domainVerified" = true,
    "updatedAt" = now();
end;
$$;

create or replace function helix_sync_oidc_sso_provider_from_config()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  perform helix_sync_oidc_sso_provider(coalesce(new.id, old.id));
  return coalesce(new, old);
end;
$$;

drop trigger if exists tenant_idp_configs_sync_oidc_sso on tenant_idp_configs;
create trigger tenant_idp_configs_sync_oidc_sso
after insert or update or delete on tenant_idp_configs
for each row execute function helix_sync_oidc_sso_provider_from_config();

create or replace function helix_sync_oidc_sso_provider_from_domain()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  config_id uuid;
begin
  for config_id in
    select id from tenant_idp_configs
    where org_id in (coalesce(new.org_id, old.org_id), old.org_id)
  loop
    perform helix_sync_oidc_sso_provider(config_id);
  end loop;
  return coalesce(new, old);
end;
$$;

drop trigger if exists admin_domains_sync_oidc_sso on admin_domains;
create trigger admin_domains_sync_oidc_sso
after insert or update or delete on admin_domains
for each row execute function helix_sync_oidc_sso_provider_from_domain();

select helix_sync_oidc_sso_provider(id) from tenant_idp_configs;
