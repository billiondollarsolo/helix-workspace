-- Add encrypted write-only mail credentials; existing tenant RLS applies.
alter table mail_outbound_providers
  add column credential_ciphertext text check (credential_ciphertext is null or credential_ciphertext like 'helix$1$%'),
  add column feedback_credential_ciphertext text check (feedback_credential_ciphertext is null or feedback_credential_ciphertext like 'helix$1$%');
alter table mail_outbound_providers drop constraint mail_outbound_providers_public_config;
alter table mail_outbound_providers
  add constraint mail_outbound_providers_public_config check (
    jsonb_typeof(config) = 'object'
    and case kind
      when 'ses' then config - array['host', 'port', 'secure', 'user', 'region', 'feedbackTopicArn', 'dkimMode', 'feedbackProvider'] = '{}'::jsonb
      when 'smtp' then config - array['host', 'port', 'secure', 'user', 'feedbackTopicArn', 'dkimMode', 'feedbackProvider'] = '{}'::jsonb
      when 'mailgun' then config - array['domain', 'baseUrl', 'dkimMode'] = '{}'::jsonb
      when 'postmark' then config - array['baseUrl', 'messageStream', 'dkimMode'] = '{}'::jsonb
      else false
    end
    and (not (config ? 'dkimMode') or (jsonb_typeof(config->'dkimMode') = 'string' and config->>'dkimMode' in ('provider', 'tenant') and (kind in ('ses', 'smtp') or config->>'dkimMode' = 'provider')))
    and (not (config ? 'feedbackProvider') or (jsonb_typeof(config->'feedbackProvider') = 'string' and config->>'feedbackProvider' in ('sendgrid', 'resend', 'cloudflare')))
    and (not (config ? 'feedbackTopicArn') or jsonb_typeof(config->'feedbackTopicArn') = 'string')
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
