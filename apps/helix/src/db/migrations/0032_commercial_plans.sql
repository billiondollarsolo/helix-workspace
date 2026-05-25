create table if not exists plans (
  id text primary key,
  display_name text not null,
  description text,
  pricing jsonb not null default '{}',
  feature_flags_default jsonb not null default '{}',
  quotas_default jsonb not null default '{}',
  available_for text[] not null default '{saas,self-host}',
  stripe_product_id text,
  stripe_price_ids jsonb,
  sort_order integer not null default 100,
  available boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into plans (
  id,
  display_name,
  description,
  pricing,
  feature_flags_default,
  quotas_default,
  available_for,
  sort_order,
  available
)
values
  (
    'personal',
    'Personal',
    'Free single-user tier for individuals and OSS users.',
    '{"currency":"USD","per_seat_monthly_cents":0,"per_seat_annual_cents":0}'::jsonb,
    '{
      "editors_native_document": true,
      "editors_native_spreadsheet": true,
      "editors_native_presentation": true,
      "editors_native_pdf": true,
      "editors_ai_rag": false,
      "ai_smart_compose": false,
      "dlp_enforcement": "off",
      "watermark": "off",
      "b2b_sharing": false,
      "mail_outbound": true,
      "sso_saml": false,
      "scim_provisioning": false,
      "custom_domain": false,
      "byo_storage": false,
      "byo_database": false,
      "byo_kms": false,
      "byo_ai_provider": false,
      "white_label": false,
      "multi_region_dr": false,
      "dedicated_csm": false,
      "marketplace_install_paid": false,
      "support_tier": "community"
    }'::jsonb,
    '{
      "actors_limit": 1,
      "storage_bytes_limit": 5000000000,
      "ai_tokens_monthly_limit": 100000,
      "ai_image_gen_monthly_limit": 10,
      "outbound_webhooks_limit": 5,
      "api_rps_limit": 5,
      "collab_concurrent_editors_per_doc": 5,
      "export_jobs_per_hour": 10
    }'::jsonb,
    '{saas,self-host}',
    10,
    true
  ),
  (
    'pro',
    'Pro',
    'Small-team plan with basic SSO and higher collaboration limits.',
    '{"currency":"USD","per_seat_monthly_cents":1200,"per_seat_annual_cents":1000}'::jsonb,
    '{
      "ai_smart_compose": true,
      "editors_ai_rag": true,
      "marketplace_install_paid": true,
      "support_tier": "email-48h"
    }'::jsonb,
    '{
      "actors_limit": 25,
      "storage_bytes_limit": 50000000000,
      "ai_tokens_monthly_limit": 1000000,
      "ai_image_gen_monthly_limit": 100,
      "outbound_webhooks_limit": 100,
      "api_rps_limit": 50,
      "collab_concurrent_editors_per_doc": 25,
      "export_jobs_per_hour": 100
    }'::jsonb,
    '{saas,self-host}',
    20,
    true
  ),
  (
    'business',
    'Business',
    'Mid-market plan with SAML, SCIM, DLP, custom domains, and priority support.',
    '{"currency":"USD","per_seat_monthly_cents":2400,"per_seat_annual_cents":2000}'::jsonb,
    '{
      "ai_smart_compose": true,
      "editors_ai_rag": true,
      "dlp_enforcement": "block",
      "watermark": "visible",
      "b2b_sharing": true,
      "sso_saml": true,
      "scim_provisioning": true,
      "custom_domain": true,
      "byo_ai_provider": true,
      "marketplace_install_paid": true,
      "support_tier": "priority-24h"
    }'::jsonb,
    '{
      "actors_limit": null,
      "storage_bytes_limit": 1000000000000,
      "ai_tokens_monthly_limit": 5000000,
      "ai_image_gen_monthly_limit": 500,
      "outbound_webhooks_limit": 1000,
      "api_rps_limit": 500,
      "collab_concurrent_editors_per_doc": 50,
      "export_jobs_per_hour": 1000
    }'::jsonb,
    '{saas,self-host}',
    30,
    true
  ),
  (
    'enterprise',
    'Enterprise',
    'Sales-assisted enterprise plan with BYO controls, DR, white-labeling, and premium support.',
    '{"currency":"USD","quote":true}'::jsonb,
    '{
      "ai_smart_compose": true,
      "editors_ai_rag": true,
      "dlp_enforcement": "block",
      "watermark": "both",
      "b2b_sharing": true,
      "sso_saml": true,
      "scim_provisioning": true,
      "custom_domain": true,
      "byo_storage": true,
      "byo_database": true,
      "byo_kms": true,
      "byo_ai_provider": true,
      "white_label": true,
      "multi_region_dr": true,
      "dedicated_csm": true,
      "marketplace_install_paid": true,
      "support_tier": "premium-4h"
    }'::jsonb,
    '{
      "actors_limit": null,
      "storage_bytes_limit": null,
      "ai_tokens_monthly_limit": null,
      "ai_image_gen_monthly_limit": null,
      "outbound_webhooks_limit": null,
      "api_rps_limit": 5000,
      "collab_concurrent_editors_per_doc": 100,
      "export_jobs_per_hour": null
    }'::jsonb,
    '{saas,self-host}',
    40,
    true
  ),
  (
    'sovereign',
    'Sovereign',
    'Regulated and federal posture with named support, air-gap support, and FIPS/STIG controls.',
    '{"currency":"USD","quote":true}'::jsonb,
    '{
      "ai_smart_compose": true,
      "editors_ai_rag": true,
      "dlp_enforcement": "block",
      "watermark": "both",
      "b2b_sharing": true,
      "sso_saml": true,
      "scim_provisioning": true,
      "custom_domain": true,
      "byo_storage": true,
      "byo_database": true,
      "byo_kms": true,
      "byo_ai_provider": true,
      "white_label": true,
      "multi_region_dr": true,
      "dedicated_csm": true,
      "marketplace_install_paid": true,
      "support_tier": "premium-1h-named"
    }'::jsonb,
    '{
      "actors_limit": null,
      "storage_bytes_limit": null,
      "ai_tokens_monthly_limit": null,
      "ai_image_gen_monthly_limit": null,
      "outbound_webhooks_limit": null,
      "api_rps_limit": null,
      "collab_concurrent_editors_per_doc": null,
      "export_jobs_per_hour": null
    }'::jsonb,
    '{self-host}',
    50,
    true
  )
on conflict (id) do update
  set
    display_name = excluded.display_name,
    description = excluded.description,
    pricing = excluded.pricing,
    feature_flags_default = excluded.feature_flags_default,
    quotas_default = excluded.quotas_default,
    available_for = excluded.available_for,
    sort_order = excluded.sort_order,
    available = excluded.available,
    updated_at = now();

alter table orgs
  add column if not exists plan_id text not null default 'personal';

do $$ begin
  alter table orgs
    add constraint orgs_plan_id_fkey foreign key (plan_id) references plans(id);
exception when duplicate_object then null; end $$;

create index if not exists orgs_plan_id_idx on orgs (plan_id);
create index if not exists plans_available_idx on plans (available, sort_order);

create table if not exists tenant_config_audit (
  org_id uuid not null references orgs(id) on delete cascade,
  key text not null,
  old_value jsonb,
  new_value jsonb,
  changed_by uuid references actors(id),
  changed_at timestamptz not null default now(),
  reason text,
  primary key (org_id, key, changed_at)
);
