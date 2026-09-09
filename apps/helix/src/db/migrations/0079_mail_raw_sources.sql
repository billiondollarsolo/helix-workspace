alter type object_kind add value if not exists 'mail_source';

create unique index if not exists messages_org_id_id_unique_idx on messages (org_id, id);
create unique index if not exists objects_org_id_id_unique_idx on objects (org_id, id);

create table if not exists mail_raw_sources (
  message_id uuid primary key,
  org_id uuid not null,
  object_id uuid not null unique,
  parser text not null check (char_length(parser) between 1 and 100),
  projection_version integer not null check (projection_version > 0),
  projection jsonb not null,
  projection_sha256 text not null check (projection_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  constraint mail_raw_sources_message_fk
    foreign key (org_id, message_id) references messages (org_id, id) on delete cascade,
  constraint mail_raw_sources_object_fk
    foreign key (org_id, object_id) references objects (org_id, id) on delete restrict
);

alter table mail_raw_sources enable row level security;
drop policy if exists helix_tenant_isolation on mail_raw_sources;
create policy helix_tenant_isolation on mail_raw_sources
  using (org_id = helix_current_org_id())
  with check (org_id = helix_current_org_id());

create or replace function helix_reject_mail_evidence_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'raw mail evidence is immutable';
end
$$;

drop trigger if exists mail_raw_sources_immutable on mail_raw_sources;
create trigger mail_raw_sources_immutable
before update on mail_raw_sources
for each row execute function helix_reject_mail_evidence_update();

create or replace function helix_protect_mail_source_object()
returns trigger
language plpgsql
as $$
begin
  if old.kind::text = 'mail_source' and (
    new.org_id is distinct from old.org_id or
    new.owner_actor_id is distinct from old.owner_actor_id or
    new.kind is distinct from old.kind or
    new.storage_key is distinct from old.storage_key or
    new.mime_type is distinct from old.mime_type or
    new.byte_size is distinct from old.byte_size or
    new.sha256 is distinct from old.sha256 or
    new.classification is distinct from old.classification or
    new.metadata is distinct from old.metadata
  ) then
    raise exception 'raw mail source object is immutable';
  end if;
  return new;
end
$$;

drop trigger if exists objects_mail_source_immutable on objects;
create trigger objects_mail_source_immutable
before update on objects
for each row execute function helix_protect_mail_source_object();
