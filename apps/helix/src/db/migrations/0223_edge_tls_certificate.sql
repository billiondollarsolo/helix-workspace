-- Operator-provided HTTPS certificate for the deployment's public address,
-- managed from Admin → Domains.
--
-- A single-organization deployment may replace the automatically obtained
-- certificate with its own. The chain is public; the private key is sealed
-- with the tenant envelope and is written, in the clear, only to the volume
-- the edge reads certificates from.

create table edge_tls_certificates (
  org_id uuid primary key references orgs (id) on delete cascade,
  -- PEM: the certificate for the public address, then its intermediates.
  chain_pem text not null check (char_length(chain_pem) between 1 and 65536),
  -- TenantEnvelopeCipher output for purpose 'edge-tls-key'.
  key_ciphertext text not null check (
    key_ciphertext ~ '^helix[$]1([$][A-Za-z0-9_-]+){6}$'
  ),
  -- What the Admin console shows without parsing the chain again.
  subject text not null check (char_length(subject) <= 1000),
  issuer text not null check (char_length(issuer) <= 1000),
  names text[] not null check (cardinality(names) between 1 and 200),
  not_before timestamptz not null,
  not_after timestamptz not null,
  fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  updated_by_actor_id uuid,
  updated_at timestamptz not null default statement_timestamp(),
  constraint edge_tls_certificates_validity check (not_after > not_before),
  constraint edge_tls_certificates_updated_by_fk
    foreign key (org_id, updated_by_actor_id)
    references actors (org_id, id) on delete set null (updated_by_actor_id)
);

alter table edge_tls_certificates enable row level security;
alter table edge_tls_certificates force row level security;
create policy helix_tenant_isolation on edge_tls_certificates
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
create policy helix_tenant_boundary on edge_tls_certificates as restrictive for all
  using (org_id = public.helix_current_org_id())
  with check (org_id = public.helix_current_org_id());
