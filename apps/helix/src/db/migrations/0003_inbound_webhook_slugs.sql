alter table inbound_webhooks
  add column if not exists slug text;

update inbound_webhooks
set slug = lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))
where slug is null;

alter table inbound_webhooks
  alter column slug set not null;

create unique index if not exists inbound_webhooks_org_slug_unique_idx
  on inbound_webhooks (org_id, slug)
  where disabled_at is null;

create index if not exists inbound_webhooks_org_slug_idx on inbound_webhooks (org_id, slug);
