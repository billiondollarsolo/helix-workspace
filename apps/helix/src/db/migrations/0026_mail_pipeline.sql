-- 0026_mail_pipeline.sql
--
-- Production mail pipeline: inbound spam routing, pluggable outbound providers,
-- and the mail-admin domains. Forward-only and idempotent.
--
--   * Spam routing      -> mail_thread_state.spam_at
--   * Outbound providers-> mail_outbound_providers
--   * Sending domains   -> mail_sending_domains
--   * DKIM keys         -> mail_dkim_keys
--   * DMARC reports     -> mail_dmarc_reports, mail_dmarc_report_records
--   * Routing rules     -> mail_inbound_routing_rules
--
-- Every table is org-scoped. The admin tables are mutated through the
-- `platform/mail/**` stores; routes are admin-scope gated and audited.

------------------------------------------------------------------------------
-- Spam routing
------------------------------------------------------------------------------
-- Inbound ingest scores each message via SpamAssassin spamd / ClamAV clamd.
-- A message above the configured spam threshold (or carrying a virus) gets
-- its per-actor thread-state row stamped with `spam_at`; the thread-list
-- projection surfaces a dedicated Spam folder filtered on this column. The
-- spamd score and triggered symbols live on the message metadata.
alter table mail_thread_state
  add column if not exists spam_at timestamptz;

create index if not exists mail_thread_state_spam_idx
  on mail_thread_state (org_id, actor_id, spam_at);

------------------------------------------------------------------------------
-- Outbound mail providers
------------------------------------------------------------------------------
-- Org-admin-selectable outbound mail delivery providers. Exactly one provider
-- per org is `is_default` and routes new outbound dispatch; the rest are kept
-- for fail-over / migration. `config` carries the per-provider settings
-- (region, domain, base URL, ...) while secrets (API keys, SMTP passwords) are
-- stored as `secret_ref` env-var indirections — never inline.
do $$ begin
  create type mail_outbound_provider_kind as enum ('ses', 'mailgun', 'smtp', 'postmark');
exception when duplicate_object then null; end $$;

create table if not exists mail_outbound_providers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  name text not null check (char_length(name) between 1 and 200),
  kind mail_outbound_provider_kind not null,
  enabled boolean not null default true,
  is_default boolean not null default false,
  -- Non-secret provider settings (region, domain, host, port, baseUrl, ...).
  config jsonb not null default '{}'::jsonb,
  -- Env-var name holding the provider API key / SMTP password.
  secret_ref text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mail_outbound_providers_org_idx
  on mail_outbound_providers (org_id, created_at desc, id desc);
create unique index if not exists mail_outbound_providers_org_name_idx
  on mail_outbound_providers (org_id, lower(name));
-- At most one default provider per org.
create unique index if not exists mail_outbound_providers_org_default_idx
  on mail_outbound_providers (org_id)
  where is_default;

------------------------------------------------------------------------------
-- Sending domains
------------------------------------------------------------------------------
-- Domains the org is authorised to send mail From. Distinct from the Admin
-- Console `admin_domains` (org ownership / inbound MX) — a sending domain is
-- the unit DKIM keys and DMARC reports attach to. `verified_at` records the
-- ownership / DNS verification handshake completing.
create table if not exists mail_sending_domains (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  domain text not null check (char_length(domain) between 1 and 253),
  is_default boolean not null default false,
  verified_at timestamptz,
  -- Optional dedicated provider for this domain (else the org default applies).
  provider_id uuid references mail_outbound_providers (id) on delete set null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists mail_sending_domains_org_domain_idx
  on mail_sending_domains (org_id, lower(domain));
create index if not exists mail_sending_domains_org_idx
  on mail_sending_domains (org_id, created_at desc, id desc);
create unique index if not exists mail_sending_domains_org_default_idx
  on mail_sending_domains (org_id)
  where is_default;

------------------------------------------------------------------------------
-- DKIM keys
------------------------------------------------------------------------------
-- DKIM signing keys per sending domain. Rotation creates a new `active` key
-- and demotes the previous one to `retiring` (kept published in DNS until
-- in-flight mail signed with it has been delivered) before it is `retired`.
-- The private key is stored PEM-encoded; the public key is surfaced as the
-- DNS TXT record value the admin must publish at `<selector>._domainkey.<domain>`.
do $$ begin
  create type mail_dkim_key_status as enum ('active', 'retiring', 'retired');
exception when duplicate_object then null; end $$;

create table if not exists mail_dkim_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  domain_id uuid not null references mail_sending_domains (id) on delete cascade,
  selector text not null check (char_length(selector) between 1 and 63),
  status mail_dkim_key_status not null default 'active',
  algorithm text not null default 'rsa-sha256',
  key_bits integer not null default 2048,
  private_key_pem text not null,
  public_key_pem text not null,
  -- DNS TXT record value for <selector>._domainkey.<domain>.
  dns_record text not null,
  rotated_at timestamptz,
  retired_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists mail_dkim_keys_domain_selector_idx
  on mail_dkim_keys (domain_id, lower(selector));
create index if not exists mail_dkim_keys_org_idx
  on mail_dkim_keys (org_id, domain_id, status);
-- At most one active key per domain.
create unique index if not exists mail_dkim_keys_domain_active_idx
  on mail_dkim_keys (domain_id)
  where status = 'active';

------------------------------------------------------------------------------
-- DMARC aggregate reports
------------------------------------------------------------------------------
-- Ingested aggregate (RUA) DMARC reports. `mail_dmarc_reports` is one row per
-- report XML; `mail_dmarc_report_records` is the per-source-IP row breakdown
-- carrying the SPF/DKIM/disposition results used for the deliverability summary.
create table if not exists mail_dmarc_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  domain text not null check (char_length(domain) between 1 and 253),
  -- Reporting org + the report's own id from the <report_metadata> block.
  org_name text not null default '',
  report_id text not null,
  date_range_begin timestamptz not null,
  date_range_end timestamptz not null,
  -- Published policy from the <policy_published> block.
  policy_p text not null default 'none',
  policy_sp text,
  policy_pct integer,
  total_messages integer not null default 0,
  pass_messages integer not null default 0,
  fail_messages integer not null default 0,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists mail_dmarc_reports_unique_idx
  on mail_dmarc_reports (org_id, lower(domain), org_name, report_id);
create index if not exists mail_dmarc_reports_org_domain_idx
  on mail_dmarc_reports (org_id, lower(domain), date_range_end desc);

create table if not exists mail_dmarc_report_records (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references mail_dmarc_reports (id) on delete cascade,
  org_id uuid not null,
  source_ip text not null,
  message_count integer not null default 0,
  disposition text not null default 'none',
  dkim_result text not null default 'fail',
  spf_result text not null default 'fail',
  header_from text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists mail_dmarc_report_records_report_idx
  on mail_dmarc_report_records (report_id);
create index if not exists mail_dmarc_report_records_org_idx
  on mail_dmarc_report_records (org_id, source_ip);

------------------------------------------------------------------------------
-- Inbound routing rules
------------------------------------------------------------------------------
-- Org-level inbound routing applied before per-actor filters: match an
-- envelope recipient / header pattern and forward, alias, drop, or tag the
-- message. Rules are evaluated in `priority` order (ascending); `is_enabled`
-- gates evaluation. `match` and `action` are validated JSON shapes.
do $$ begin
  create type mail_routing_action_kind as enum ('forward', 'alias', 'drop', 'tag', 'mailbox');
exception when duplicate_object then null; end $$;

create table if not exists mail_inbound_routing_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  name text not null check (char_length(name) between 1 and 200),
  is_enabled boolean not null default true,
  priority integer not null default 100,
  -- { recipientPattern?, senderPattern?, subjectContains?, headerName?, headerContains? }
  match jsonb not null default '{}'::jsonb,
  action_kind mail_routing_action_kind not null,
  -- { forwardTo?, aliasActorId?, tag?, mailbox?, stopProcessing? }
  action jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mail_inbound_routing_rules_org_idx
  on mail_inbound_routing_rules (org_id, priority asc, created_at asc);
create unique index if not exists mail_inbound_routing_rules_org_name_idx
  on mail_inbound_routing_rules (org_id, lower(name));
