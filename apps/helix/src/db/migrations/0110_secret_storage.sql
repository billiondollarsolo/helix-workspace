-- Remove directly usable long-lived credentials from SQL-backed configuration.
-- Values that cannot be encrypted during a SQL-only upgrade are invalidated so
-- administrators must rotate them through the application/Vault boundary.

-- Better Auth encrypts provider and MFA material with versioned XChaCha20-Poly1305
-- envelopes. Plaintext and legacy unversioned values are no longer readable.
update account
set "accessToken" = null
where "accessToken" is not null
  and "accessToken" !~ '^[$]ba[$][1-9][0-9]*[$][0-9a-f]{80,}$';

update account
set "refreshToken" = null
where "refreshToken" is not null
  and "refreshToken" !~ '^[$]ba[$][1-9][0-9]*[$][0-9a-f]{80,}$';

update account
set "idToken" = null
where "idToken" is not null
  and "idToken" !~ '^[$]ba[$][1-9][0-9]*[$][0-9a-f]{80,}$';

alter table account
  drop constraint if exists better_auth_account_access_token_encrypted,
  drop constraint if exists better_auth_account_refresh_token_encrypted,
  drop constraint if exists better_auth_account_id_token_encrypted;

alter table account
  add constraint better_auth_account_access_token_encrypted check (
    "accessToken" is null or "accessToken" ~ '^[$]ba[$][1-9][0-9]*[$][0-9a-f]{80,}$'
  ),
  add constraint better_auth_account_refresh_token_encrypted check (
    "refreshToken" is null or "refreshToken" ~ '^[$]ba[$][1-9][0-9]*[$][0-9a-f]{80,}$'
  ),
  add constraint better_auth_account_id_token_encrypted check (
    "idToken" is null or "idToken" ~ '^[$]ba[$][1-9][0-9]*[$][0-9a-f]{80,}$'
  );

update "user"
set "twoFactorEnabled" = false
where id in (
  select "userId"
  from "twoFactor"
  where secret !~ '^[$]ba[$][1-9][0-9]*[$][0-9a-f]{80,}$'
     or "backupCodes" !~ '^[$]ba[$][1-9][0-9]*[$][0-9a-f]{80,}$'
);

delete from "twoFactor"
where secret !~ '^[$]ba[$][1-9][0-9]*[$][0-9a-f]{80,}$'
   or "backupCodes" !~ '^[$]ba[$][1-9][0-9]*[$][0-9a-f]{80,}$';

alter table "twoFactor"
  drop constraint if exists better_auth_two_factor_secret_encrypted,
  drop constraint if exists better_auth_two_factor_backup_codes_encrypted;

alter table "twoFactor"
  add constraint better_auth_two_factor_secret_encrypted check (
    secret ~ '^[$]ba[$][1-9][0-9]*[$][0-9a-f]{80,}$'
  ),
  add constraint better_auth_two_factor_backup_codes_encrypted check (
    "backupCodes" ~ '^[$]ba[$][1-9][0-9]*[$][0-9a-f]{80,}$'
  );

-- DKIM PEM cannot be safely transformed without the runtime master key. Drop
-- legacy keys and require the application envelope for every replacement.
alter table mail_dkim_keys
  add column if not exists private_key_ciphertext text;

delete from mail_dkim_keys
where private_key_ciphertext is null
   or private_key_ciphertext !~ '^helix[$]1([$][A-Za-z0-9_-]+){6}$';

alter table mail_dkim_keys
  drop column if exists private_key_pem,
  alter column private_key_ciphertext set not null,
  drop constraint if exists mail_dkim_keys_private_key_ciphertext_check;

alter table mail_dkim_keys
  add constraint mail_dkim_keys_private_key_ciphertext_check check (
    private_key_ciphertext ~ '^helix[$]1([$][A-Za-z0-9_-]+){6}$'
  );

-- Webhook signing secrets formerly lived in secret_ref as inline:<plaintext>.
-- Invalidate those endpoints and their deliveries; rotation recreates them as
-- tenant-bound AES-256-GCM envelopes.
alter table outbound_webhooks
  add column if not exists secret_ciphertext text;
alter table inbound_webhooks
  add column if not exists secret_ciphertext text;

delete from webhook_deliveries
where outbound_webhook_id in (
    select id from outbound_webhooks
    where secret_ciphertext is null
       or secret_ciphertext !~ '^helix[$]1([$][A-Za-z0-9_-]+){6}$'
  )
   or inbound_webhook_id in (
    select id from inbound_webhooks
    where secret_ciphertext is null
       or secret_ciphertext !~ '^helix[$]1([$][A-Za-z0-9_-]+){6}$'
  );

delete from outbound_webhooks
where secret_ciphertext is null
   or secret_ciphertext !~ '^helix[$]1([$][A-Za-z0-9_-]+){6}$';
delete from inbound_webhooks
where secret_ciphertext is null
   or secret_ciphertext !~ '^helix[$]1([$][A-Za-z0-9_-]+){6}$';

alter table outbound_webhooks
  drop column if exists secret_ref,
  alter column secret_ciphertext set not null,
  drop constraint if exists outbound_webhooks_secret_ciphertext_check,
  drop constraint if exists outbound_webhooks_headers_no_credentials,
  drop constraint if exists outbound_webhooks_metadata_no_credentials;

alter table inbound_webhooks
  drop column if exists secret_ref,
  alter column secret_ciphertext set not null,
  drop constraint if exists inbound_webhooks_secret_ciphertext_check,
  drop constraint if exists inbound_webhooks_metadata_no_credentials;

update outbound_webhooks webhook
set headers = coalesce((
  select jsonb_object_agg(entry.key, entry.value)
  from jsonb_each(webhook.headers) entry
  where entry.key !~* '(authorization|authentication|x[-_]?auth|secret|password|token|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|signing[-_]?(key|secret))'
), '{}'::jsonb);

update outbound_webhooks
set metadata = '{}'::jsonb
where metadata::text ~* '"[^"]*(authentication|x[-_]?auth|secret|password|token|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|signing[-_]?(key|secret))[^"]*"[[:space:]]*:';

update inbound_webhooks
set metadata = '{}'::jsonb
where metadata::text ~* '"[^"]*(authentication|x[-_]?auth|secret|password|token|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|signing[-_]?(key|secret))[^"]*"[[:space:]]*:';

update webhook_deliveries delivery
set request_headers = coalesce((
      select jsonb_object_agg(entry.key, entry.value)
      from jsonb_each(delivery.request_headers) entry
      where entry.key !~* '(authorization|authentication|x[-_]?auth|secret|password|token|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|signing[-_]?(key|secret))'
    ), '{}'::jsonb),
    response_headers = coalesce((
      select jsonb_object_agg(entry.key, entry.value)
      from jsonb_each(delivery.response_headers) entry
      where entry.key !~* '(authorization|authentication|x[-_]?auth|secret|password|token|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|signing[-_]?(key|secret))'
    ), '{}'::jsonb);

alter table outbound_webhooks
  add constraint outbound_webhooks_secret_ciphertext_check check (
    secret_ciphertext ~ '^helix[$]1([$][A-Za-z0-9_-]+){6}$'
  ),
  add constraint outbound_webhooks_headers_no_credentials check (
    headers::text !~* '"[^"]*(authorization|authentication|x[-_]?auth|secret|password|token|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|signing[-_]?(key|secret))[^"]*"[[:space:]]*:'
  ),
  add constraint outbound_webhooks_metadata_no_credentials check (
    metadata::text !~* '"[^"]*(authentication|x[-_]?auth|secret|password|token|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|signing[-_]?(key|secret))[^"]*"[[:space:]]*:'
  );

alter table inbound_webhooks
  add constraint inbound_webhooks_secret_ciphertext_check check (
    secret_ciphertext ~ '^helix[$]1([$][A-Za-z0-9_-]+){6}$'
  ),
  add constraint inbound_webhooks_metadata_no_credentials check (
    metadata::text !~* '"[^"]*(authentication|x[-_]?auth|secret|password|token|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|signing[-_]?(key|secret))[^"]*"[[:space:]]*:'
  );

alter table webhook_deliveries
  drop constraint if exists webhook_deliveries_request_headers_no_credentials,
  drop constraint if exists webhook_deliveries_response_headers_no_credentials;

alter table webhook_deliveries
  add constraint webhook_deliveries_request_headers_no_credentials check (
    request_headers::text !~* '"[^"]*(authorization|authentication|x[-_]?auth|secret|password|token|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|signing[-_]?(key|secret))[^"]*"[[:space:]]*:'
  ),
  add constraint webhook_deliveries_response_headers_no_credentials check (
    response_headers::text !~* '"[^"]*(authorization|authentication|x[-_]?auth|secret|password|token|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|signing[-_]?(key|secret))[^"]*"[[:space:]]*:'
  );

-- Persist only an opaque tenant Vault handle and an allowlisted public config
-- for outbound mail providers.
update mail_outbound_providers
set secret_ref = null
where secret_ref is not null
  and secret_ref !~ '^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$';

update mail_outbound_providers provider
set config = coalesce((
  select jsonb_object_agg(entry.key, entry.value)
  from jsonb_each(
    case when jsonb_typeof(provider.config) = 'object' then provider.config else '{}'::jsonb end
  ) entry
  where case provider.kind::text
    when 'ses' then
      (entry.key in ('host', 'user', 'region') and jsonb_typeof(entry.value) = 'string')
      or (entry.key = 'port' and jsonb_typeof(entry.value) = 'number')
      or (entry.key = 'secure' and jsonb_typeof(entry.value) = 'boolean')
    when 'smtp' then
      (entry.key in ('host', 'user') and jsonb_typeof(entry.value) = 'string')
      or (entry.key = 'port' and jsonb_typeof(entry.value) = 'number')
      or (entry.key = 'secure' and jsonb_typeof(entry.value) = 'boolean')
    when 'mailgun' then
      entry.key in ('domain', 'baseUrl') and jsonb_typeof(entry.value) = 'string'
    when 'postmark' then
      entry.key in ('baseUrl', 'messageStream') and jsonb_typeof(entry.value) = 'string'
    else false
  end
), '{}'::jsonb);

update mail_outbound_providers
set config = config - 'baseUrl'
where config->>'baseUrl' !~ '^https://'
   or config->>'baseUrl' ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@';

update mail_outbound_providers
set config = config - 'host'
where config->>'host' ~ '[@/]';

update mail_outbound_providers
set config = config - 'domain'
where config->>'domain' ~ '[@/]';

alter table mail_outbound_providers
  drop constraint if exists mail_outbound_providers_secret_handle,
  drop constraint if exists mail_outbound_providers_public_config;

alter table mail_outbound_providers
  add constraint mail_outbound_providers_secret_handle check (
    secret_ref is null or secret_ref ~ '^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$'
  ),
  add constraint mail_outbound_providers_public_config check (
    jsonb_typeof(config) = 'object'
    and case kind
      when 'ses' then config - array['host', 'port', 'secure', 'user', 'region'] = '{}'::jsonb
      when 'smtp' then config - array['host', 'port', 'secure', 'user'] = '{}'::jsonb
      when 'mailgun' then config - array['domain', 'baseUrl'] = '{}'::jsonb
      when 'postmark' then config - array['baseUrl', 'messageStream'] = '{}'::jsonb
      else false
    end
    and (not (config ? 'host') or (
      jsonb_typeof(config->'host') = 'string' and config->>'host' !~ '[@/]'
    ))
    and (not (config ? 'port') or jsonb_typeof(config->'port') = 'number')
    and (not (config ? 'secure') or jsonb_typeof(config->'secure') = 'boolean')
    and (not (config ? 'user') or jsonb_typeof(config->'user') = 'string')
    and (not (config ? 'region') or jsonb_typeof(config->'region') = 'string')
    and (not (config ? 'domain') or (
      jsonb_typeof(config->'domain') = 'string' and config->>'domain' !~ '[@/]'
    ))
    and (not (config ? 'baseUrl') or (
      jsonb_typeof(config->'baseUrl') = 'string'
      and config->>'baseUrl' ~ '^https://'
      and config->>'baseUrl' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'
    ))
    and (not (config ? 'messageStream') or jsonb_typeof(config->'messageStream') = 'string')
  );

-- IdP JSON contains public protocol settings and fixed claim selectors only;
-- certificates and client credentials are selected by the opaque secret handle.
update tenant_idp_configs idp
set config = coalesce((
  select jsonb_object_agg(entry.key, entry.value)
  from jsonb_each(
    case when jsonb_typeof(idp.config) = 'object' then idp.config else '{}'::jsonb end
  ) entry
  where case idp.protocol
    when 'saml' then
      (entry.key in ('metadataUrl', 'entityId', 'ssoUrl', 'logoutUrl', 'nameIdFormat')
        and jsonb_typeof(entry.value) = 'string')
      or (entry.key = 'signRequests' and jsonb_typeof(entry.value) = 'boolean')
    when 'oidc' then
      (entry.key in (
        'issuer', 'metadataUrl', 'clientId', 'authorizationEndpoint', 'tokenEndpoint', 'jwksUri'
      ) and jsonb_typeof(entry.value) = 'string')
      or (entry.key = 'scopes' and jsonb_typeof(entry.value) = 'array')
    else false
  end
), '{}'::jsonb);

update tenant_idp_configs idp
set attr_mapping = coalesce((
  select jsonb_object_agg(entry.key, entry.value)
  from jsonb_each(
    case
      when jsonb_typeof(idp.attr_mapping) = 'object' then idp.attr_mapping
      else '{}'::jsonb
    end
  ) entry
  where entry.key in ('email', 'displayName', 'givenName', 'familyName', 'groups', 'externalId')
    and jsonb_typeof(entry.value) = 'string'
    and entry.value #>> '{}' ~ '^[$][.][A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*$'
), '{}'::jsonb);

update tenant_idp_configs
set config = config - 'metadataUrl'
where config->>'metadataUrl' !~ '^https://'
   or config->>'metadataUrl' ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@';
update tenant_idp_configs
set config = config - 'ssoUrl'
where config->>'ssoUrl' !~ '^https://'
   or config->>'ssoUrl' ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@';
update tenant_idp_configs
set config = config - 'logoutUrl'
where config->>'logoutUrl' !~ '^https://'
   or config->>'logoutUrl' ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@';
update tenant_idp_configs
set config = config - 'issuer'
where config->>'issuer' !~ '^https://'
   or config->>'issuer' ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@';
update tenant_idp_configs
set config = config - 'authorizationEndpoint'
where config->>'authorizationEndpoint' !~ '^https://'
   or config->>'authorizationEndpoint' ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@';
update tenant_idp_configs
set config = config - 'tokenEndpoint'
where config->>'tokenEndpoint' !~ '^https://'
   or config->>'tokenEndpoint' ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@';
update tenant_idp_configs
set config = config - 'jwksUri'
where config->>'jwksUri' !~ '^https://'
   or config->>'jwksUri' ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@';

update tenant_idp_configs
set config = config - 'scopes'
where config ? 'scopes'
  and jsonb_path_exists(config, '$.scopes[*] ? (@.type() != "string")');

alter table tenant_idp_configs
  drop constraint if exists tenant_idp_configs_public_config,
  drop constraint if exists tenant_idp_configs_public_attr_mapping;

alter table tenant_idp_configs
  add constraint tenant_idp_configs_public_config check (
    jsonb_typeof(config) = 'object'
    and case protocol
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
  add constraint tenant_idp_configs_public_attr_mapping check (
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
  );

-- Reject conventional credential keys in BYO storage configuration and
-- snapshots. Existing unsafe records are invalidated rather than copied.
update orgs
set byo_config = '{}'::jsonb
where jsonb_path_exists(
    byo_config,
    '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^((aws[-_]?)?access[-_]?key([-_]?id)?|(aws[-_]?)?secret[-_]?access[-_]?key|secret[-_]?key|password|pass|token|access[-_]?token|refresh[-_]?token|id[-_]?token|(aws[-_]?)?session[-_]?token|api[-_]?key|client[-_]?secret|private[-_]?key|signing[-_]?(key|secret)|credential(s)?)$" flag "i")'
  )
   or byo_config->'storage'->>'endpoint' ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@';

update tenant_storage_migration_jobs
set source_storage = null
where source_storage is not null
  and (
    jsonb_path_exists(
      source_storage,
      '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^((aws[-_]?)?access[-_]?key([-_]?id)?|(aws[-_]?)?secret[-_]?access[-_]?key|secret[-_]?key|password|pass|token|access[-_]?token|refresh[-_]?token|id[-_]?token|(aws[-_]?)?session[-_]?token|api[-_]?key|client[-_]?secret|private[-_]?key|signing[-_]?(key|secret)|credential(s)?)$" flag "i")'
    )
    or source_storage->'storage'->>'endpoint' ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'
  );

update tenant_storage_migration_jobs
set target_storage = null
where target_storage is not null
  and (
    jsonb_path_exists(
      target_storage,
      '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^((aws[-_]?)?access[-_]?key([-_]?id)?|(aws[-_]?)?secret[-_]?access[-_]?key|secret[-_]?key|password|pass|token|access[-_]?token|refresh[-_]?token|id[-_]?token|(aws[-_]?)?session[-_]?token|api[-_]?key|client[-_]?secret|private[-_]?key|signing[-_]?(key|secret)|credential(s)?)$" flag "i")'
    )
    or target_storage->'storage'->>'endpoint' ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'
  );

alter table orgs
  drop constraint if exists orgs_byo_config_no_credentials;
alter table orgs
  add constraint orgs_byo_config_no_credentials check (
    not jsonb_path_exists(
      byo_config,
      '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^((aws[-_]?)?access[-_]?key([-_]?id)?|(aws[-_]?)?secret[-_]?access[-_]?key|secret[-_]?key|password|pass|token|access[-_]?token|refresh[-_]?token|id[-_]?token|(aws[-_]?)?session[-_]?token|api[-_]?key|client[-_]?secret|private[-_]?key|signing[-_]?(key|secret)|credential(s)?)$" flag "i")'
    )
    and byo_config->'storage'->>'endpoint' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'
  );

alter table tenant_storage_migration_jobs
  drop constraint if exists tenant_storage_migration_jobs_source_no_credentials,
  drop constraint if exists tenant_storage_migration_jobs_target_no_credentials;
alter table tenant_storage_migration_jobs
  add constraint tenant_storage_migration_jobs_source_no_credentials check (
    source_storage is null or (
      not jsonb_path_exists(
        source_storage,
        '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^((aws[-_]?)?access[-_]?key([-_]?id)?|(aws[-_]?)?secret[-_]?access[-_]?key|secret[-_]?key|password|pass|token|access[-_]?token|refresh[-_]?token|id[-_]?token|(aws[-_]?)?session[-_]?token|api[-_]?key|client[-_]?secret|private[-_]?key|signing[-_]?(key|secret)|credential(s)?)$" flag "i")'
      )
      and source_storage->'storage'->>'endpoint' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'
    )
  ),
  add constraint tenant_storage_migration_jobs_target_no_credentials check (
    target_storage is null or (
      not jsonb_path_exists(
        target_storage,
        '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^((aws[-_]?)?access[-_]?key([-_]?id)?|(aws[-_]?)?secret[-_]?access[-_]?key|secret[-_]?key|password|pass|token|access[-_]?token|refresh[-_]?token|id[-_]?token|(aws[-_]?)?session[-_]?token|api[-_]?key|client[-_]?secret|private[-_]?key|signing[-_]?(key|secret)|credential(s)?)$" flag "i")'
      )
      and target_storage->'storage'->>'endpoint' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'
    )
  );

-- Config audit history is part of a database dump. Redact unsafe snapshots
-- created while cleaning orgs, then prevent credentials from re-entering it.
update tenant_config_audit
set old_value = null
where old_value is not null
  and (
    jsonb_path_exists(
      old_value,
      '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^((aws[-_]?)?access[-_]?key([-_]?id)?|(aws[-_]?)?secret[-_]?access[-_]?key|secret[-_]?key|password|pass|token|access[-_]?token|refresh[-_]?token|id[-_]?token|(aws[-_]?)?session[-_]?token|api[-_]?key|client[-_]?secret|private[-_]?key|signing[-_]?(key|secret)|credential(s)?)$" flag "i")'
    )
    or old_value->'storage'->>'endpoint' ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'
  );

update tenant_config_audit
set new_value = null
where new_value is not null
  and (
    jsonb_path_exists(
      new_value,
      '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^((aws[-_]?)?access[-_]?key([-_]?id)?|(aws[-_]?)?secret[-_]?access[-_]?key|secret[-_]?key|password|pass|token|access[-_]?token|refresh[-_]?token|id[-_]?token|(aws[-_]?)?session[-_]?token|api[-_]?key|client[-_]?secret|private[-_]?key|signing[-_]?(key|secret)|credential(s)?)$" flag "i")'
    )
    or new_value->'storage'->>'endpoint' ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'
  );

alter table tenant_config_audit
  drop constraint if exists tenant_config_audit_values_no_credentials;
alter table tenant_config_audit
  add constraint tenant_config_audit_values_no_credentials check (
    (old_value is null or (
      not jsonb_path_exists(
        old_value,
        '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^((aws[-_]?)?access[-_]?key([-_]?id)?|(aws[-_]?)?secret[-_]?access[-_]?key|secret[-_]?key|password|pass|token|access[-_]?token|refresh[-_]?token|id[-_]?token|(aws[-_]?)?session[-_]?token|api[-_]?key|client[-_]?secret|private[-_]?key|signing[-_]?(key|secret)|credential(s)?)$" flag "i")'
      )
      and old_value->'storage'->>'endpoint' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'
    ))
    and (new_value is null or (
      not jsonb_path_exists(
        new_value,
        '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^((aws[-_]?)?access[-_]?key([-_]?id)?|(aws[-_]?)?secret[-_]?access[-_]?key|secret[-_]?key|password|pass|token|access[-_]?token|refresh[-_]?token|id[-_]?token|(aws[-_]?)?session[-_]?token|api[-_]?key|client[-_]?secret|private[-_]?key|signing[-_]?(key|secret)|credential(s)?)$" flag "i")'
      )
      and new_value->'storage'->>'endpoint' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'
    ))
  );
