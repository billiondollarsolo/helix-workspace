-- Sensitivity is one canonical classification row plus derived product projections.
-- Product metadata is display-only; policy decisions read resource_classifications.
create table sensitivity_labels (
  key text primary key check (key in ('public', 'standard', 'confidential', 'restricted')),
  rank smallint not null unique check (rank between 0 and 3),
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  description text not null check (length(btrim(description)) between 1 and 500),
  color text not null check (color ~ '^#[0-9A-F]{6}$'),
  marking text not null check (length(btrim(marking)) between 1 and 80),
  retention_days integer not null check (retention_days between 0 and 36500),
  encryption text not null check (encryption in ('platform', 'tenant_kms')),
  external_sharing_allowed boolean not null,
  recording_export_allowed boolean not null,
  boundary_actions jsonb not null check (jsonb_typeof(boundary_actions) = 'object')
);

insert into sensitivity_labels values
  ('public', 0, 'Public', 'Approved for public distribution.', '#16A34A', 'PUBLIC',
    0, 'platform', true, true, '{}'),
  ('standard', 1, 'Standard', 'Internal workspace content.', '#2563EB', 'INTERNAL',
    0, 'platform', true, true, '{}'),
  ('confidential', 2, 'Confidential',
    'Sensitive business data limited to approved collaborators.', '#D97706', 'CONFIDENTIAL',
    365, 'tenant_kms', false, false,
    '{"drive_share":"audit","drive_download":"warn","copy_export":"block","api_agent":"block","external_guest":"block"}'),
  ('restricted', 3, 'Restricted',
    'Highest-sensitivity content limited to explicitly authorized users.', '#DC2626', 'RESTRICTED',
    2555, 'tenant_kms', false, false,
    '{"drive_share":"block","drive_download":"block","copy_export":"block","api_agent":"block","external_guest":"block"}');

alter table resource_classifications
  add column retention_until timestamptz,
  add constraint resource_classifications_label_fk foreign key (classification)
    references sensitivity_labels(key);

-- Docs, Sheets, Slides, and Drive all address the same object. Collapse old
-- aliases before future writes are canonicalized in ResourceClassificationService.
insert into resource_classifications (
  org_id, resource_type, resource_id, classification, source, reason, actor_id, updated_at
)
select distinct on (org_id, resource_id)
  org_id, 'drive.file', resource_id, classification, source, reason, actor_id, updated_at
from resource_classifications
where resource_type in ('drive.file', 'object', 'docs.document', 'sheets.sheet', 'slides.deck')
order by org_id, resource_id,
  case classification when 'restricted' then 3 when 'confidential' then 2
    when 'standard' then 1 else 0 end desc,
  updated_at desc
on conflict (org_id, resource_type, resource_id) do update set
  classification = case
    when (select rank from sensitivity_labels where key = excluded.classification) >
         (select rank from sensitivity_labels where key = resource_classifications.classification)
    then excluded.classification else resource_classifications.classification end,
  source = case
    when (select rank from sensitivity_labels where key = excluded.classification) >
         (select rank from sensitivity_labels where key = resource_classifications.classification)
    then excluded.source else resource_classifications.source end,
  reason = case
    when (select rank from sensitivity_labels where key = excluded.classification) >
         (select rank from sensitivity_labels where key = resource_classifications.classification)
    then excluded.reason else resource_classifications.reason end,
  actor_id = coalesce(excluded.actor_id, resource_classifications.actor_id),
  updated_at = greatest(excluded.updated_at, resource_classifications.updated_at);

delete from resource_classifications
where resource_type in ('object', 'docs.document', 'sheets.sheet', 'slides.deck');

create function helix_sensitivity_label_metadata(input_key text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select jsonb_build_object(
    'key', label.key,
    'displayName', label.display_name,
    'color', label.color,
    'marking', label.marking,
    'encryption', label.encryption
  )
  from sensitivity_labels label where label.key = input_key
$$;

create function helix_validate_sensitivity_assignment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  old_rank smallint;
  new_label sensitivity_labels%rowtype;
begin
  select * into strict new_label from sensitivity_labels where key = new.classification;
  if tg_op = 'UPDATE' and old.classification <> new.classification then
    select rank into strict old_rank from sensitivity_labels where key = old.classification;
    if old_rank > new_label.rank
      and not (old.source in ('default', 'folder') and new.source in ('default', 'folder'))
      and coalesce(current_setting('helix.allow_sensitivity_downgrade', true), '') <> 'on'
    then
      raise insufficient_privilege using
        message = 'Lowering a sensitivity label requires security-administrator permission';
    end if;
  end if;
  if new_label.retention_days > 0 then
    new.retention_until := greatest(
      new.retention_until,
      statement_timestamp() + make_interval(days => new_label.retention_days)
    );
  end if;
  return new;
end
$$;

create trigger resource_classifications_validate_sensitivity
before insert or update on resource_classifications
for each row execute function helix_validate_sensitivity_assignment();

create function helix_project_sensitivity_assignment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  label sensitivity_labels%rowtype;
  resource_uuid uuid;
  audit_actor uuid;
  label_metadata jsonb;
begin
  select * into strict label from sensitivity_labels where key = new.classification;
  label_metadata := helix_sensitivity_label_metadata(new.classification);
  if new.resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    resource_uuid := new.resource_id::uuid;
  end if;

  if new.resource_type = 'drive.file' and resource_uuid is not null then
    update objects set
      classification = new.classification,
      metadata = jsonb_set(metadata - 'classification', '{sensitivityLabel}', label_metadata, true),
      retain_until = greatest(retain_until, new.retention_until)
    where org_id = new.org_id and id = resource_uuid;
    update docs_documents set
      metadata = jsonb_set(metadata - 'classification', '{sensitivityLabel}', label_metadata, true)
    where org_id = new.org_id and id = resource_uuid;
    update sheets set
      metadata = jsonb_set(metadata - 'classification', '{sensitivityLabel}', label_metadata, true)
    where org_id = new.org_id and id = resource_uuid;
    update slide_decks set
      metadata = jsonb_set(metadata - 'classification', '{sensitivityLabel}', label_metadata, true)
    where org_id = new.org_id and id = resource_uuid;
    update meet_recording_governance set
      classification = new.classification,
      retention_until = greatest(retention_until, new.retention_until),
      export_allowed = export_allowed and label.recording_export_allowed
    where org_id = new.org_id and object_id = resource_uuid;
  elsif new.resource_type = 'drive.folder' and resource_uuid is not null then
    update drive_folders set
      metadata = jsonb_set(metadata - 'classification', '{sensitivityLabel}', label_metadata, true),
      retain_until = greatest(retain_until, new.retention_until)
    where org_id = new.org_id and id = resource_uuid;
  elsif new.resource_type in ('mail.message', 'chat.message') and resource_uuid is not null then
    update messages set
      metadata = jsonb_set(metadata - 'classification', '{sensitivityLabel}', label_metadata, true)
    where org_id = new.org_id and id = resource_uuid;
  elsif new.resource_type = 'calendar.event' and resource_uuid is not null then
    update cal_events set
      metadata = jsonb_set(metadata - 'classification', '{sensitivityLabel}', label_metadata, true)
    where org_id = new.org_id and id = resource_uuid;
  end if;

  if (tg_op = 'UPDATE' and old.classification <> new.classification)
    or (tg_op = 'INSERT' and new.classification in ('confidential', 'restricted'))
  then
    select actor.id into audit_actor from actors actor
    where actor.org_id = new.org_id and actor.id = new.actor_id;
    insert into activity (org_id, actor_id, verb, object_type, object_id, payload)
    values (
      new.org_id, audit_actor, 'sensitivity.label.changed', new.resource_type, resource_uuid,
      jsonb_build_object(
        'resourceId', new.resource_id,
        'previousLabel', case when tg_op = 'UPDATE' then old.classification else null end,
        'label', new.classification,
        'source', new.source,
        'reason', new.reason,
        'effects', jsonb_build_object(
          'retentionDays', label.retention_days,
          'encryption', label.encryption,
          'externalSharingAllowed', label.external_sharing_allowed,
          'recordingExportAllowed', label.recording_export_allowed,
          'boundaries', label.boundary_actions
        )
      )
    );
  end if;
  return new;
end
$$;

create trigger resource_classifications_project_sensitivity
after insert or update of classification, source, reason, actor_id, retention_until
on resource_classifications
for each row execute function helix_project_sensitivity_assignment();

create function helix_inherit_object_sensitivity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  parent_id text := nullif(new.metadata->>'folderId', '');
  inherited text;
begin
  if tg_op = 'UPDATE' and parent_id is not distinct from nullif(old.metadata->>'folderId', '') then
    return new;
  end if;
  select classification into inherited from resource_classifications
  where org_id = new.org_id and resource_type = 'drive.folder' and resource_id = parent_id;
  inherited := coalesce(
    inherited,
    case when new.classification in ('public', 'standard', 'confidential', 'restricted')
      then new.classification else 'standard' end
  );
  insert into resource_classifications (
    org_id, resource_type, resource_id, classification, source, reason, actor_id
  ) values (
    new.org_id, 'drive.file', new.id::text, inherited,
    case when parent_id is null then 'default' else 'folder' end,
    case when parent_id is null then 'workspace-default' else 'inherited-folder:' || parent_id end,
    new.owner_actor_id
  ) on conflict (org_id, resource_type, resource_id) do update set
    classification = excluded.classification,
    source = excluded.source,
    reason = excluded.reason,
    actor_id = excluded.actor_id,
    updated_at = statement_timestamp()
  where resource_classifications.source in ('default', 'folder');
  return new;
end
$$;

create trigger objects_inherit_sensitivity
after insert or update of metadata on objects
for each row execute function helix_inherit_object_sensitivity();

create function helix_inherit_folder_sensitivity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  inherited text;
begin
  select classification into inherited from resource_classifications
  where org_id = new.org_id and resource_type = 'drive.folder'
    and resource_id = new.parent_folder_id::text;
  inherited := coalesce(inherited, 'standard');
  insert into resource_classifications (
    org_id, resource_type, resource_id, classification, source, reason, actor_id
  ) values (
    new.org_id, 'drive.folder', new.id::text, inherited,
    case when new.parent_folder_id is null then 'default' else 'folder' end,
    case when new.parent_folder_id is null then 'workspace-default'
      else 'inherited-folder:' || new.parent_folder_id::text end,
    new.owner_actor_id
  ) on conflict (org_id, resource_type, resource_id) do update set
    classification = excluded.classification,
    source = excluded.source,
    reason = excluded.reason,
    actor_id = excluded.actor_id,
    updated_at = statement_timestamp()
  where resource_classifications.source in ('default', 'folder');
  return new;
end
$$;

create trigger drive_folders_inherit_sensitivity
after insert or update of parent_folder_id on drive_folders
for each row execute function helix_inherit_folder_sensitivity();

-- A changed folder label flows to inherited descendants; explicit/heuristic
-- assignments are exceptions and remain untouched.
create function helix_propagate_folder_sensitivity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if new.resource_type <> 'drive.folder' then return new; end if;
  insert into resource_classifications (
    org_id, resource_type, resource_id, classification, source, reason, actor_id
  )
  select child.org_id, 'drive.folder', child.id::text, new.classification, 'folder',
    'inherited-folder:' || new.resource_id, new.actor_id
  from drive_folders child
  where child.org_id = new.org_id and child.parent_folder_id::text = new.resource_id
  on conflict (org_id, resource_type, resource_id) do update set
    classification = excluded.classification, source = excluded.source,
    reason = excluded.reason, actor_id = excluded.actor_id, updated_at = statement_timestamp()
  where resource_classifications.source in ('default', 'folder');

  insert into resource_classifications (
    org_id, resource_type, resource_id, classification, source, reason, actor_id
  )
  select object.org_id, 'drive.file', object.id::text, new.classification, 'folder',
    'inherited-folder:' || new.resource_id, new.actor_id
  from objects object
  where object.org_id = new.org_id and object.metadata->>'folderId' = new.resource_id
  on conflict (org_id, resource_type, resource_id) do update set
    classification = excluded.classification, source = excluded.source,
    reason = excluded.reason, actor_id = excluded.actor_id, updated_at = statement_timestamp()
  where resource_classifications.source in ('default', 'folder');
  return new;
end
$$;

create trigger resource_classifications_propagate_folder
after insert or update of classification on resource_classifications
for each row execute function helix_propagate_folder_sensitivity();

-- Existing explicit classifications gain their derived markings/effects.
update resource_classifications set classification = classification;

alter table sensitivity_labels owner to helix_migration_owner;
alter function helix_sensitivity_label_metadata(text) owner to helix_migration_owner;
alter function helix_validate_sensitivity_assignment() owner to helix_migration_owner;
alter function helix_project_sensitivity_assignment() owner to helix_migration_owner;
alter function helix_inherit_object_sensitivity() owner to helix_migration_owner;
alter function helix_inherit_folder_sensitivity() owner to helix_migration_owner;
alter function helix_propagate_folder_sensitivity() owner to helix_migration_owner;

revoke all on sensitivity_labels from public;
grant select on sensitivity_labels to helix_app, helix_worker, helix_readonly;
revoke execute on function helix_sensitivity_label_metadata(text) from public;
revoke execute on function helix_validate_sensitivity_assignment() from public;
revoke execute on function helix_project_sensitivity_assignment() from public;
revoke execute on function helix_inherit_object_sensitivity() from public;
revoke execute on function helix_inherit_folder_sensitivity() from public;
revoke execute on function helix_propagate_folder_sensitivity() from public;
