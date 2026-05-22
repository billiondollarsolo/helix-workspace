-- 0024: Admin Console backend domains.
--
-- The web Admin Console (`apps/web/src/features/admin/admin-console.tsx`) has
-- eight sections. Users and Audit log already have durable backends; this
-- migration adds the five that were seed-only:
--
--   * Groups & OUs       -> admin_org_units, admin_groups, admin_group_members
--   * Security policies  -> admin_security_policies
--   * OAuth apps         -> admin_oauth_apps
--   * Billing            -> admin_billing_accounts, admin_billing_invoices
--   * Domain / DNS       -> admin_domains, admin_dns_records
--
-- Every table is org-scoped. Stores are accessed through the
-- `platform/admin/**` modules; routes are admin-scope gated and audited.

------------------------------------------------------------------------------
-- Groups & OUs
------------------------------------------------------------------------------

-- Organizational units form a tree (parent_id -> admin_org_units.id). The root
-- units have a NULL parent. `path` is a denormalized human-readable breadcrumb
-- ("Engineering > Platform") maintained by the store on write.
create table if not exists admin_org_units (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  parent_id uuid references admin_org_units (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 200),
  path text not null default '',
  description text not null default '',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_org_units_org_idx
  on admin_org_units (org_id, created_at desc, id desc);
create index if not exists admin_org_units_parent_idx
  on admin_org_units (org_id, parent_id);
create unique index if not exists admin_org_units_org_parent_name_idx
  on admin_org_units (org_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

-- Groups are flat membership collections (mailing lists, security groups).
-- `kind` distinguishes a generic group from a security group or a mailing list.
create table if not exists admin_groups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  name text not null check (char_length(name) between 1 and 200),
  email text,
  kind text not null default 'group'
    check (kind in ('group', 'security', 'mailing_list')),
  description text not null default '',
  org_unit_id uuid references admin_org_units (id) on delete set null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_groups_org_idx
  on admin_groups (org_id, created_at desc, id desc);
create unique index if not exists admin_groups_org_name_idx
  on admin_groups (org_id, lower(name));

-- Group membership. `role` records whether the member is a plain member or a
-- manager/owner of the group.
create table if not exists admin_group_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  group_id uuid not null references admin_groups (id) on delete cascade,
  actor_id uuid not null,
  role text not null default 'member'
    check (role in ('member', 'manager', 'owner')),
  added_by uuid,
  created_at timestamptz not null default now()
);

create unique index if not exists admin_group_members_unique_idx
  on admin_group_members (group_id, actor_id);
create index if not exists admin_group_members_org_idx
  on admin_group_members (org_id, group_id);
create index if not exists admin_group_members_actor_idx
  on admin_group_members (org_id, actor_id);

------------------------------------------------------------------------------
-- Security policies
------------------------------------------------------------------------------

-- One row per (org, policy_type). The UI surfaces MFA / SSO / Session /
-- External sharing / DLP / Device trust. `settings` is a typed JSON blob whose
-- shape is validated per policy_type by the Zod schemas in the store layer.
-- Some tier-config enforcement already exists elsewhere; these rows hold the
-- *org-author-editable* policy state and are advisory to that enforcement.
create table if not exists admin_security_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  policy_type text not null
    check (policy_type in ('mfa', 'sso', 'session', 'external_sharing', 'dlp', 'device_trust')),
  enabled boolean not null default false,
  enforcement text not null default 'optional'
    check (enforcement in ('disabled', 'optional', 'required')),
  settings jsonb not null default '{}'::jsonb,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists admin_security_policies_org_type_idx
  on admin_security_policies (org_id, policy_type);

------------------------------------------------------------------------------
-- OAuth apps
------------------------------------------------------------------------------

-- Third-party OAuth app registrations the org has encountered. `risk` and
-- `status` drive the Apps section chips. `client_id` optionally ties a row to
-- an `agent_credentials` / oauth client where the app is a first-party-issued
-- credential.
create table if not exists admin_oauth_apps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  name text not null check (char_length(name) between 1 and 200),
  client_id text,
  publisher text not null default '',
  scopes text[] not null default array[]::text[],
  scope_summary text not null default '',
  risk text not null default 'low'
    check (risk in ('low', 'medium', 'high')),
  status text not null default 'pending'
    check (status in ('approved', 'pending', 'blocked', 'revoked')),
  user_count integer not null default 0 check (user_count >= 0),
  first_authorized_at timestamptz,
  last_authorized_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_oauth_apps_org_idx
  on admin_oauth_apps (org_id, created_at desc, id desc);
create index if not exists admin_oauth_apps_org_status_idx
  on admin_oauth_apps (org_id, status);

------------------------------------------------------------------------------
-- Billing (read model)
------------------------------------------------------------------------------

-- One billing account per org. This is a read model only: there is NO payment
-- gateway integration. License / storage / AI-credit counts and the plan are
-- maintained by ops tooling; the admin API exposes them read-only.
create table if not exists admin_billing_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique,
  plan_name text not null default 'Business',
  plan_price_per_seat_cents integer not null default 0 check (plan_price_per_seat_cents >= 0),
  billing_cycle text not null default 'annual'
    check (billing_cycle in ('monthly', 'annual')),
  currency text not null default 'USD' check (char_length(currency) = 3),
  licenses_total integer not null default 0 check (licenses_total >= 0),
  licenses_used integer not null default 0 check (licenses_used >= 0),
  storage_used_bytes bigint not null default 0 check (storage_used_bytes >= 0),
  storage_limit_bytes bigint not null default 0 check (storage_limit_bytes >= 0),
  ai_credits_used integer not null default 0 check (ai_credits_used >= 0),
  ai_credits_limit integer not null default 0 check (ai_credits_limit >= 0),
  next_invoice_cents integer not null default 0 check (next_invoice_cents >= 0),
  next_invoice_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Historical invoices for the Billing section's "recent invoices" list.
create table if not exists admin_billing_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  invoice_number text not null,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null default 'USD' check (char_length(currency) = 3),
  status text not null default 'paid'
    check (status in ('paid', 'open', 'void', 'uncollectible')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  issued_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists admin_billing_invoices_org_number_idx
  on admin_billing_invoices (org_id, invoice_number);
create index if not exists admin_billing_invoices_org_idx
  on admin_billing_invoices (org_id, issued_at desc, id desc);

------------------------------------------------------------------------------
-- Domain / DNS
------------------------------------------------------------------------------

-- Org domains. One domain may be flagged primary; verification status reflects
-- ownership verification.
create table if not exists admin_domains (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  domain text not null check (char_length(domain) between 1 and 253),
  is_primary boolean not null default false,
  verification_status text not null default 'pending'
    check (verification_status in ('verified', 'pending', 'failed')),
  verified_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists admin_domains_org_domain_idx
  on admin_domains (org_id, lower(domain));
create index if not exists admin_domains_org_idx
  on admin_domains (org_id, created_at desc, id desc);

-- DNS records associated with a domain (MX / SPF / DKIM / DMARC / TXT / CNAME).
-- `status` reflects whether the live DNS lookup matched the expected value.
create table if not exists admin_dns_records (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  domain_id uuid not null references admin_domains (id) on delete cascade,
  record_type text not null
    check (record_type in ('MX', 'SPF', 'DKIM', 'DMARC', 'TXT', 'CNAME', 'A')),
  host text not null,
  expected_value text not null,
  observed_value text,
  status text not null default 'pending'
    check (status in ('verified', 'pending', 'failed')),
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_dns_records_domain_idx
  on admin_dns_records (org_id, domain_id, record_type);
