alter table message_attachments
  add column snapshot jsonb,
  add column access_mode text not null default 'current_acl'
    check (access_mode in ('current_acl', 'room_content')),
  add column authorized_at timestamptz;

update message_attachments linked
set snapshot = jsonb_build_object(
      'filename', coalesce(nullif(object.metadata->>'name', ''), 'File'),
      'mimeType', object.mime_type,
      'byteSize', object.byte_size,
      'sha256', object.sha256,
      'classification', case
        when object.classification in ('public', 'standard', 'confidential', 'restricted')
          then object.classification
        else 'standard'
      end
    ),
    access_mode = case when object.kind::text = 'chat_attachment'
      then 'room_content' else 'current_acl' end,
    authorized_at = coalesce(linked.authorized_at, object.created_at)
from objects object
where object.org_id = linked.org_id and object.id = linked.object_id;

alter table message_attachments
  alter column snapshot set not null,
  alter column authorized_at set not null,
  add constraint message_attachments_snapshot_shape check (
    jsonb_typeof(snapshot) = 'object'
    and jsonb_typeof(snapshot->'filename') = 'string'
    and jsonb_typeof(snapshot->'mimeType') = 'string'
    and jsonb_typeof(snapshot->'byteSize') = 'number'
    and snapshot->>'classification' in ('public', 'standard', 'confidential', 'restricted')
  );

create or replace function helix_bind_chat_message_attachment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target_message public.messages%rowtype;
  target_object public.objects%rowtype;
  current_actor uuid := public.helix_current_actor_id();
  object_classification text;
  external_room boolean := false;
  external_mode text;
  external_domains jsonb := '[]'::jsonb;
  dlp_block boolean := false;
begin
  select * into target_message from public.messages message
  where message.org_id = new.org_id and message.id = new.message_id;
  if not found or target_message.kind <> 'chat' then return new; end if;

  if current_actor is null or target_message.actor_id is distinct from current_actor then
    raise insufficient_privilege using message = 'chat attachment actor mismatch';
  end if;

  select * into target_object from public.objects object
  where object.org_id = new.org_id and object.id = new.object_id
    and object.deleted_at is null;
  if not found then raise check_violation using message = 'chat attachment object is unavailable'; end if;

  select classification into object_classification
  from public.resource_classifications classification
  where classification.org_id = new.org_id
    and classification.resource_type in ('drive.file', 'object')
    and classification.resource_id = new.object_id::text
  order by case classification.resource_type when 'drive.file' then 0 else 1 end
  limit 1;
  object_classification := coalesce(
    object_classification,
    case when target_object.metadata->>'classification'
      in ('public', 'standard', 'confidential', 'restricted')
      then target_object.metadata->>'classification' end,
    case when target_object.classification
      in ('public', 'standard', 'confidential', 'restricted')
      then target_object.classification end,
    'standard'
  );

  if target_object.kind::text = 'chat_attachment' then
    update public.chat_attachments attachment set
      message_id = new.message_id,
      expires_at = 'infinity',
      updated_at = now()
    where attachment.org_id = new.org_id
      and attachment.object_id = new.object_id
      and attachment.room_id = target_message.thread_id
      and attachment.owner_actor_id = current_actor
      and attachment.status = 'ready'
      and attachment.message_id is null
      and attachment.expires_at > statement_timestamp()
      and exists (
        select 1 from public.drive_quarantine_deletions deletion
        where deletion.org_id = attachment.org_id
          and deletion.object_id = attachment.object_id
          and deletion.storage_key = target_object.storage_key
          and deletion.status = 'pending'
          and deletion.next_attempt_at > statement_timestamp()
      );
    if not found then
      raise check_violation using message = 'chat attachment is not ready, owned, or room-scoped';
    end if;
    delete from public.drive_quarantine_deletions deletion
    where deletion.org_id = new.org_id
      and deletion.object_id = new.object_id
      and deletion.storage_key = target_object.storage_key;
    new.access_mode := 'room_content';
  elsif target_object.kind::text in ('file', 'recording') then
    if coalesce(target_object.metadata->>'status', 'ready') <> 'ready'
      or exists (
        select 1 from public.drive_scan_jobs scan
        where scan.org_id = new.org_id and scan.object_id = new.object_id
          and scan.status in ('pending', 'processing', 'dead_lettered')
      )
    then raise check_violation using message = 'Drive attachment is not clean and ready'; end if;

    if public.drive_comment_actor_role_rank(new.org_id, new.object_id, current_actor) < 0 then
      raise insufficient_privilege using message = 'Drive attachment is inaccessible';
    end if;

    select exists (
      select 1
      from public.permissions room_permission
      join public.organization_memberships membership
        on membership.org_id = room_permission.org_id
       and membership.actor_id = room_permission.actor_id
       and membership.status = 'active'
      where public.chat_permission_is_valid(
        room_permission, new.org_id, room_permission.actor_id, target_message.thread_id
      ) and membership.guest_type <> 'member'
    ) into external_room;

    if external_room then
      if object_classification in ('confidential', 'restricted') then
        raise insufficient_privilege using message = 'classified Drive attachment cannot enter an external room';
      end if;
      if exists (
        select 1 from public.chat_room_settings settings
        where settings.org_id = new.org_id and settings.thread_id = target_message.thread_id
          and not settings.allow_external_guests
      ) then raise insufficient_privilege using message = 'external attachments are disabled for this room'; end if;

      select policy.settings->>'mode', coalesce(policy.settings->'allowedDomains', '[]'::jsonb)
      into external_mode, external_domains
      from public.admin_security_policies policy
      where policy.org_id = new.org_id and policy.policy_type = 'external_sharing'
        and policy.enabled and policy.enforcement <> 'disabled';
      if external_mode = 'blocked' then
        raise insufficient_privilege using message = 'organization policy blocks external Drive attachments';
      end if;
      if external_mode = 'allowlist' and exists (
        select 1
        from public.permissions room_permission
        join public.organization_memberships membership
          on membership.org_id = room_permission.org_id
         and membership.actor_id = room_permission.actor_id
         and membership.status = 'active'
         and membership.guest_type <> 'member'
        join public.actors actor
          on actor.org_id = membership.org_id and actor.id = membership.actor_id
        where public.chat_permission_is_valid(
          room_permission, new.org_id, room_permission.actor_id, target_message.thread_id
        ) and not exists (
          select 1 from jsonb_array_elements_text(external_domains) allowed(domain)
          where lower(allowed.domain) = lower(split_part(actor.email, '@', 2))
        )
      ) then raise insufficient_privilege using message = 'external participant domain is not allowed'; end if;
    end if;

    select exists (
      select 1 from public.admin_security_policies policy
      where policy.org_id = new.org_id and policy.policy_type = 'dlp'
        and policy.enabled and policy.enforcement <> 'disabled'
        and policy.settings->>'action' = 'block'
        and coalesce((policy.settings->>'scanSharedDocs')::boolean, true)
    ) into dlp_block;
    if dlp_block and coalesce(target_object.metadata->>'dlpVerdict', 'unscanned')
      not in ('clean', 'allowed')
    then raise insufficient_privilege using message = 'Drive attachment has no passing DLP verdict'; end if;
    new.access_mode := 'current_acl';
  else
    raise check_violation using message = 'unsupported chat attachment object kind';
  end if;

  new.snapshot := jsonb_build_object(
    'filename', case when target_object.kind::text = 'chat_attachment'
      then (select attachment.filename from public.chat_attachments attachment
        where attachment.org_id = new.org_id and attachment.object_id = new.object_id)
      else coalesce(nullif(target_object.metadata->>'name', ''), 'Drive file') end,
    'mimeType', target_object.mime_type,
    'byteSize', target_object.byte_size,
    'sha256', target_object.sha256,
    'classification', object_classification,
    'versionId', target_object.metadata->>'latestVersionId',
    'dlpVerdict', target_object.metadata->>'dlpVerdict'
  );
  new.authorized_at := statement_timestamp();
  return new;
end
$$;

alter function helix_bind_chat_message_attachment() owner to helix_migration_owner;
revoke all on function helix_bind_chat_message_attachment() from public;
