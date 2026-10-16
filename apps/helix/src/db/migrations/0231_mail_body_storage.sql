-- Private content references are separate from Drive objects: sharing a file
-- must never grant access to the email body that happened to contain it.
create table mail_message_bodies (
  org_id uuid not null references orgs(id),
  message_id uuid primary key,
  storage_id uuid not null unique,
  storage_key text not null,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 52428800),
  logical_size bigint not null check (logical_size > 0 and logical_size <= 52428800),
  created_at timestamptz not null default now(),
  constraint mail_message_bodies_org_key_idx unique (org_id, storage_key),
  constraint mail_message_bodies_message_fk foreign key (org_id, message_id) references messages(org_id, id) on delete cascade
);
alter table mail_message_bodies enable row level security;
alter table mail_message_bodies force row level security;
create policy helix_tenant_boundary on mail_message_bodies as restrictive for all
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());
create policy mail_body_read on mail_message_bodies for select
  using (helix_can_read_mail_message(org_id, message_id));
create policy mail_body_insert on mail_message_bodies for insert
  with check (helix_can_write_mail_message(org_id, message_id));

create trigger mail_body_immutable before update on mail_message_bodies
  for each row execute function helix_reject_mail_evidence_update();

-- The parent's legal-hold/retention guard runs before its cascading delete.
-- Cleanup survives that delete and retries through the existing storage worker.
create function helix_queue_mail_body_deletion() returns trigger
language plpgsql security definer set search_path = pg_catalog, public set row_security = off as $$
begin
  insert into public.drive_quarantine_deletions(org_id, object_id, storage_key)
  values (old.org_id, old.storage_id, old.storage_key)
  on conflict (org_id, storage_key) do nothing;
  return old;
end
$$;
alter function helix_queue_mail_body_deletion() owner to helix_migration_owner;
revoke all on function helix_queue_mail_body_deletion() from public;
create trigger mail_body_delete after delete on mail_message_bodies
  for each row execute function helix_queue_mail_body_deletion();

grant select, insert on mail_message_bodies to helix_app, helix_worker;
grant select on mail_message_bodies to helix_readonly;
alter table mail_message_bodies owner to helix_migration_owner;
