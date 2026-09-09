create table mail_message_identities (
  message_id uuid primary key,
  org_id uuid not null,
  normalized_message_id text,
  raw_sha256 text,
  provider_delivery_id text,
  created_at timestamptz not null default now(),
  constraint mail_message_identities_has_identity check (
    normalized_message_id is not null or raw_sha256 is not null or provider_delivery_id is not null
  ),
  constraint mail_message_identities_message_id_format check (
    normalized_message_id is null or (
      char_length(normalized_message_id) between 3 and 998 and
      normalized_message_id ~ '^<[^[:space:]<>@]+@[^[:space:]<>@]+>$'
    )
  ),
  constraint mail_message_identities_raw_sha256_format check (
    raw_sha256 is null or raw_sha256 ~ '^[a-f0-9]{64}$'
  ),
  constraint mail_message_identities_provider_delivery_id_format check (
    provider_delivery_id is null or (
      char_length(provider_delivery_id) between 1 and 512 and
      provider_delivery_id !~ '[[:cntrl:]]'
    )
  ),
  constraint mail_message_identities_message_fk
    foreign key (org_id, message_id) references messages (org_id, id) on delete cascade
);

create unique index mail_message_identities_rfc_uidx
  on mail_message_identities (org_id, normalized_message_id)
  where normalized_message_id is not null;
create unique index mail_message_identities_raw_uidx
  on mail_message_identities (org_id, raw_sha256)
  where raw_sha256 is not null;
create unique index mail_message_identities_provider_uidx
  on mail_message_identities (org_id, provider_delivery_id)
  where provider_delivery_id is not null;

create table mail_message_deliveries (
  org_id uuid not null,
  message_id uuid not null,
  actor_id uuid not null,
  delivered_at timestamptz not null default now(),
  primary key (message_id, actor_id),
  constraint mail_message_deliveries_message_fk
    foreign key (org_id, message_id) references messages (org_id, id) on delete cascade,
  constraint mail_message_deliveries_actor_fk
    foreign key (org_id, actor_id) references actors (org_id, id) on delete cascade
);

create index mail_message_deliveries_actor_idx
  on mail_message_deliveries (org_id, actor_id, delivered_at desc);

alter table mail_message_identities enable row level security;
create policy helix_tenant_isolation on mail_message_identities
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

alter table mail_message_deliveries enable row level security;
create policy helix_tenant_isolation on mail_message_deliveries
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
