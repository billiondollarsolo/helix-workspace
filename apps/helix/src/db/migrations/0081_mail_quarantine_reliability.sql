alter table mail_drafts
  add column if not exists version integer not null default 1;

alter table mail_outbound_messages
  add column if not exists idempotency_key text;

create unique index if not exists mail_outbound_idempotency_idx
  on mail_outbound_messages (org_id, actor_id, idempotency_key)
  where idempotency_key is not null;

create table if not exists mail_quarantined_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  dedup_key text not null,
  status text not null default 'quarantined'
    check (status in ('quarantined', 'rescanning', 'released', 'deleted')),
  envelope_from text,
  envelope_to text[] not null,
  subject text not null,
  reasons text[] not null,
  auth_evidence jsonb not null default '{}'::jsonb,
  scan_evidence jsonb not null default '{}'::jsonb,
  raw_message bytea,
  released_at timestamptz,
  released_by uuid references actors(id),
  deleted_at timestamptz,
  deleted_by uuid references actors(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mail_quarantine_dedup_sha256 check (dedup_key ~ '^[a-f0-9]{64}$'),
  constraint mail_quarantine_recipients_nonempty check (
    cardinality(envelope_to) > 0 and array_position(envelope_to, null) is null
  ),
  constraint mail_quarantine_reasons_nonempty check (
    cardinality(reasons) > 0 and array_position(reasons, null) is null
  ),
  constraint mail_quarantine_raw_lifecycle check (
    (status in ('quarantined', 'rescanning') and raw_message is not null)
    or (status in ('released', 'deleted') and raw_message is null)
  )
);

create unique index if not exists mail_quarantined_messages_org_dedup_idx
  on mail_quarantined_messages (org_id, dedup_key);
create index if not exists mail_quarantined_messages_org_status_idx
  on mail_quarantined_messages (org_id, status, created_at desc);

create or replace function mail_quarantine_validate_tenant()
returns trigger
language plpgsql
as $$
begin
  if new.released_by is not null and not exists (
    select 1 from actors where id = new.released_by and org_id = new.org_id
  ) then
    raise exception 'quarantine releasing actor must belong to the organization'
      using errcode = '23514',
            constraint = 'mail_quarantine_release_actor_same_org';
  end if;
  if new.deleted_by is not null and not exists (
    select 1 from actors where id = new.deleted_by and org_id = new.org_id
  ) then
    raise exception 'quarantine deleting actor must belong to the organization'
      using errcode = '23514',
            constraint = 'mail_quarantine_delete_actor_same_org';
  end if;
  return new;
end
$$;

drop trigger if exists mail_quarantine_same_org on mail_quarantined_messages;
create trigger mail_quarantine_same_org
before insert or update of org_id, released_by, deleted_by
on mail_quarantined_messages
for each row execute function mail_quarantine_validate_tenant();

alter table mail_quarantined_messages enable row level security;
drop policy if exists helix_tenant_isolation on mail_quarantined_messages;
create policy helix_tenant_isolation on mail_quarantined_messages
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());
