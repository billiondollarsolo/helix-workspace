-- Keep storage authorization, sensitivity and search independent of retired tables.
CREATE OR REPLACE FUNCTION public.permissions_require_tenant_resource()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  if new.resource_type = 'org' then
    if new.resource_id is distinct from new.org_id then
      raise foreign_key_violation using constraint = 'permissions_resource_org_fk';
    end if;
    return new;
  elsif new.resource_type = 'mailbox' then
    perform 1 from actors where org_id = new.org_id and id = new.resource_id;
  elsif new.resource_type = 'object' then
    perform 1 from objects where org_id = new.org_id and id = new.resource_id;
  elsif new.resource_type in ('drive_folder', 'folder') then
    perform 1 from drive_folders where org_id = new.org_id and id = new.resource_id;
  elsif new.resource_type = 'thread' then
    perform 1 from threads where org_id = new.org_id and id = new.resource_id;
  elsif new.resource_type = 'calendar' then
    perform 1 from cal_calendars where org_id = new.org_id and id = new.resource_id;
  elsif new.resource_type = 'event' then
    perform 1 from cal_events where org_id = new.org_id and id = new.resource_id;
  elsif new.resource_type = 'meet_room' then
    perform 1 from meet_rooms where org_id = new.org_id and id = new.resource_id;
  else
    return new;
  end if;

  if not found then
    raise foreign_key_violation using
      constraint = 'permissions_resource_org_fk',
      message = 'permission resource must belong to the same organization';
  end if;
  return new;
end
$function$;

CREATE OR REPLACE FUNCTION public.helix_search_reindex_id_page(input_type text, input_updated_at timestamp with time zone, input_id uuid, input_limit integer)
 RETURNS TABLE(id uuid, org_id uuid, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  if input_type = 'mail' then
    return query select item.id, item.org_id, item.updated_at from messages item
      where item.kind = 'mail' and item.deleted_at is null
        and (input_updated_at is null or (item.updated_at, item.id) > (input_updated_at, input_id))
      order by item.updated_at, item.id limit greatest(1, least(coalesce(input_limit, 100), 1000));
  elsif input_type = 'chat' then
    return query select item.id, item.org_id, item.updated_at from messages item
      where item.kind = 'chat' and item.deleted_at is null
        and (input_updated_at is null or (item.updated_at, item.id) > (input_updated_at, input_id))
      order by item.updated_at, item.id limit greatest(1, least(coalesce(input_limit, 100), 1000));
  elsif input_type = 'drive' then
    return query select item.id, item.org_id, item.updated_at from objects item
      where item.kind = 'file' and item.deleted_at is null
        and (input_updated_at is null or (item.updated_at, item.id) > (input_updated_at, input_id))
      order by item.updated_at, item.id limit greatest(1, least(coalesce(input_limit, 100), 1000));
  elsif input_type = 'calendar' then
    return query select item.id, item.org_id, item.updated_at from cal_events item
      where item.deleted_at is null and item.status <> 'cancelled'
        and (input_updated_at is null or (item.updated_at, item.id) > (input_updated_at, input_id))
      order by item.updated_at, item.id limit greatest(1, least(coalesce(input_limit, 100), 1000));
  else
    raise exception 'Unsupported search reindex type: %', input_type using errcode = '22023';
  end if;
end $function$;

CREATE OR REPLACE FUNCTION public.helix_project_sensitivity_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET row_security TO 'off'
AS $function$
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
$function$;
