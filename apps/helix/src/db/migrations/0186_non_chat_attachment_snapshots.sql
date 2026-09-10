-- 0139 required durable snapshots for every attachment, but its binding trigger
-- populated them only for chat. Mail, Meet, and seed/import writers share this
-- invariant, so derive non-chat snapshots from the authoritative tenant object.
create function helix_bind_non_chat_message_attachment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  message_kind text;
  target_object public.objects%rowtype;
begin
  select message.kind::text into message_kind from public.messages message
  where message.org_id = new.org_id and message.id = new.message_id;
  if not found then
    raise foreign_key_violation using message = 'attachment message tenant mismatch';
  end if;
  -- The existing chat trigger owns current-ACL, room, scan, and DLP checks.
  if message_kind = 'chat' then return new; end if;

  select * into target_object from public.objects object
  where object.org_id = new.org_id and object.id = new.object_id;
  if not found then
    raise foreign_key_violation using message = 'attachment object tenant mismatch';
  end if;
  new.snapshot := jsonb_build_object(
    'filename', coalesce(nullif(target_object.metadata->>'filename', ''),
      nullif(target_object.metadata->>'name', ''), 'File'),
    'mimeType', target_object.mime_type,
    'byteSize', target_object.byte_size,
    'sha256', target_object.sha256,
    'classification', target_object.classification,
    'versionId', target_object.metadata->>'latestVersionId'
  );
  new.access_mode := 'current_acl';
  new.authorized_at := statement_timestamp();
  return new;
end
$$;

alter function helix_bind_non_chat_message_attachment() owner to helix_migration_owner;
revoke all on function helix_bind_non_chat_message_attachment() from public;
create trigger message_attachments_bind_non_chat_object
before insert on message_attachments
for each row execute function helix_bind_non_chat_message_attachment();
