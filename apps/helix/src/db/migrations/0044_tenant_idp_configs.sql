create table if not exists tenant_idp_configs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  protocol text not null check (protocol in ('saml', 'oidc')),
  is_primary boolean not null default true,
  display_name text not null,
  config jsonb not null default '{}',
  signing_cert_secret_handle text,
  attr_mapping jsonb not null default '{}',
  jit_provisioning boolean not null default true,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_idp_configs_config_object check (jsonb_typeof(config) = 'object'),
  constraint tenant_idp_configs_attr_mapping_object check (jsonb_typeof(attr_mapping) = 'object'),
  constraint tenant_idp_configs_public_config check (
    case protocol
      when 'saml' then config - array[
        'metadataUrl', 'entityId', 'ssoUrl', 'logoutUrl', 'nameIdFormat', 'signRequests'
      ] = '{}'::jsonb
      when 'oidc' then config - array[
        'issuer', 'metadataUrl', 'clientId', 'scopes', 'authorizationEndpoint', 'tokenEndpoint',
        'jwksUri'
      ] = '{}'::jsonb
      else false
    end
    and (not (config ? 'metadataUrl') or (
      jsonb_typeof(config->'metadataUrl') = 'string'
      and config->>'metadataUrl' ~ '^https://'
      and config->>'metadataUrl' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'
    ))
    and (not (config ? 'entityId') or jsonb_typeof(config->'entityId') = 'string')
    and (not (config ? 'ssoUrl') or (
      jsonb_typeof(config->'ssoUrl') = 'string'
      and config->>'ssoUrl' ~ '^https://'
      and config->>'ssoUrl' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'
    ))
    and (not (config ? 'logoutUrl') or (
      jsonb_typeof(config->'logoutUrl') = 'string'
      and config->>'logoutUrl' ~ '^https://'
      and config->>'logoutUrl' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'
    ))
    and (not (config ? 'nameIdFormat') or jsonb_typeof(config->'nameIdFormat') = 'string')
    and (not (config ? 'signRequests') or jsonb_typeof(config->'signRequests') = 'boolean')
    and (not (config ? 'issuer') or (
      jsonb_typeof(config->'issuer') = 'string'
      and config->>'issuer' ~ '^https://'
      and config->>'issuer' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'
    ))
    and (not (config ? 'clientId') or jsonb_typeof(config->'clientId') = 'string')
    and (not (config ? 'scopes') or (
      jsonb_typeof(config->'scopes') = 'array'
      and not jsonb_path_exists(config, '$.scopes[*] ? (@.type() != "string")')
    ))
    and (not (config ? 'authorizationEndpoint') or (
      jsonb_typeof(config->'authorizationEndpoint') = 'string'
      and config->>'authorizationEndpoint' ~ '^https://'
      and config->>'authorizationEndpoint' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'
    ))
    and (not (config ? 'tokenEndpoint') or (
      jsonb_typeof(config->'tokenEndpoint') = 'string'
      and config->>'tokenEndpoint' ~ '^https://'
      and config->>'tokenEndpoint' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'
    ))
    and (not (config ? 'jwksUri') or (
      jsonb_typeof(config->'jwksUri') = 'string'
      and config->>'jwksUri' ~ '^https://'
      and config->>'jwksUri' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'
    ))
  ),
  constraint tenant_idp_configs_public_attr_mapping check (
    jsonb_typeof(attr_mapping) = 'object'
    and
    attr_mapping - array[
      'email', 'displayName', 'givenName', 'familyName', 'groups', 'externalId'
    ] = '{}'::jsonb
    and (not (attr_mapping ? 'email') or attr_mapping->>'email' ~ '^[$][.][A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*$')
    and (not (attr_mapping ? 'displayName') or attr_mapping->>'displayName' ~ '^[$][.][A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*$')
    and (not (attr_mapping ? 'givenName') or attr_mapping->>'givenName' ~ '^[$][.][A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*$')
    and (not (attr_mapping ? 'familyName') or attr_mapping->>'familyName' ~ '^[$][.][A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*$')
    and (not (attr_mapping ? 'groups') or attr_mapping->>'groups' ~ '^[$][.][A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*$')
    and (not (attr_mapping ? 'externalId') or attr_mapping->>'externalId' ~ '^[$][.][A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*$')
  ),
  constraint tenant_idp_configs_signing_cert_secret_handle check (
    signing_cert_secret_handle is null
    or signing_cert_secret_handle ~ '^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$'
  )
);

create unique index if not exists tenant_idp_configs_primary_idx
  on tenant_idp_configs (org_id)
  where is_primary and enabled;

create index if not exists tenant_idp_configs_org_idx
  on tenant_idp_configs (org_id, enabled, is_primary);
