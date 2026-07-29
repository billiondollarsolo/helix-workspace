create table if not exists mail_inbound_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  dedup_key text not null,
  normalized_message_id text,
  raw_sha256 text not null,
  envelope_from text,
  envelope_to text[] not null,
  message_id uuid references messages(id) on delete cascade,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mail_inbound_deliveries_dedup_sha256 check (dedup_key ~ '^[a-f0-9]{64}$'),
  constraint mail_inbound_deliveries_raw_sha256 check (raw_sha256 ~ '^[a-f0-9]{64}$'),
  constraint mail_inbound_deliveries_recipients_nonempty check (
    cardinality(envelope_to) > 0 and array_position(envelope_to, null) is null
  )
);

create unique index if not exists mail_inbound_deliveries_org_dedup_idx
  on mail_inbound_deliveries (org_id, dedup_key);
create unique index if not exists mail_inbound_deliveries_message_idx
  on mail_inbound_deliveries (message_id)
  where message_id is not null;
create index if not exists mail_inbound_deliveries_org_received_idx
  on mail_inbound_deliveries (org_id, received_at desc);

create table if not exists mail_inbound_recipients (
  delivery_id uuid not null references mail_inbound_deliveries(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  actor_id uuid not null references actors(id),
  address text not null,
  match_kind text not null check (match_kind in ('primary', 'alias', 'catch_all')),
  created_at timestamptz not null default now(),
  primary key (delivery_id, address)
);

create index if not exists mail_inbound_recipients_actor_idx
  on mail_inbound_recipients (org_id, actor_id, created_at desc);

create or replace function mail_inbound_recipients_validate_tenant()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from mail_inbound_deliveries
    where id = new.delivery_id and org_id = new.org_id
  ) or not exists (
    select 1 from actors
    where id = new.actor_id and org_id = new.org_id and disabled_at is null
  ) then
    raise exception 'inbound recipient, delivery, and actor must belong to one organization'
      using errcode = '23514',
            constraint = 'mail_inbound_recipients_same_org';
  end if;
  return new;
end
$$;

drop trigger if exists mail_inbound_recipients_same_org on mail_inbound_recipients;
create trigger mail_inbound_recipients_same_org
before insert or update of delivery_id, org_id, actor_id
on mail_inbound_recipients
for each row
execute function mail_inbound_recipients_validate_tenant();

alter table mail_inbound_deliveries enable row level security;
drop policy if exists helix_tenant_isolation on mail_inbound_deliveries;
create policy helix_tenant_isolation on mail_inbound_deliveries
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

alter table mail_inbound_recipients enable row level security;
drop policy if exists helix_tenant_isolation on mail_inbound_recipients;
create policy helix_tenant_isolation on mail_inbound_recipients
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
