-- Content references participate in quota, journaling and eDiscovery.

create function helix_mail_body_reference(input_org_id uuid, input_message_id uuid)
returns jsonb language sql stable set search_path = pg_catalog, public as $$
  select jsonb_build_object('storageKey', storage_key, 'sha256', sha256,
    'byteSize', byte_size, 'logicalSize', logical_size)
  from mail_message_bodies where org_id = input_org_id and message_id = input_message_id
$$;
alter function helix_mail_body_reference(uuid, uuid) owner to helix_migration_owner;
revoke all on function helix_mail_body_reference(uuid, uuid) from public;
grant execute on function helix_mail_body_reference(uuid, uuid) to helix_app, helix_worker, helix_readonly;

create or replace function helix_actor_storage_usage_bytes(input_org_id uuid, input_actor_id uuid)
returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select (
    coalesce((
      select sum(object.byte_size)
      from public.objects object
      where object.org_id = input_org_id
        and object.owner_actor_id = input_actor_id
        and object.kind::text in ('file', 'recording')
    ), 0)
    + coalesce((
      select sum(coalesce(
        source.byte_size,
        coalesce(body.logical_size, octet_length(message.body)) + coalesce(attached.byte_size, 0)
      ))
      from public.mail_message_deliveries delivery
      join public.messages message
        on message.org_id = delivery.org_id and message.id = delivery.message_id
      left join public.mail_message_bodies body
        on body.org_id = message.org_id and body.message_id = message.id
      left join public.mail_raw_sources raw
        on raw.org_id = message.org_id and raw.message_id = message.id
      left join public.objects source
        on source.org_id = raw.org_id and source.id = raw.object_id
      left join lateral (
        select sum(coalesce(ingestion.actual_byte_size, ingestion.expected_byte_size)) as byte_size
        from public.mail_attachment_ingestions ingestion
        where ingestion.org_id = message.org_id
          and ingestion.message_id = message.id
          and ingestion.status::text = 'attached'
      ) attached on true
      where delivery.org_id = input_org_id
        and delivery.actor_id = input_actor_id
        and message.deleted_at is null
    ), 0)
  )::bigint
$$;

create or replace function helix_protect_mail_message_content()
returns trigger
language plpgsql
as $$
begin
  if old.kind = 'mail' and (
    new.org_id is distinct from old.org_id
    or new.thread_id is distinct from old.thread_id
    or new.actor_id is distinct from old.actor_id
    or new.kind is distinct from old.kind
    or ((new.body is distinct from old.body
      or new.metadata->'bodyStorage' is distinct from old.metadata->'bodyStorage'
      or new.metadata->'preview' is distinct from old.metadata->'preview') and not (
        current_user = 'helix_migration_owner'
        and coalesce(current_setting('helix.mail_body_backfill', true), '') = 'on'
        and old.metadata->>'bodyStorage' is distinct from 'object-v1'
        and new.metadata->>'bodyStorage' = 'object-v1' and new.body = ''
        and exists (select 1 from public.mail_message_bodies b where b.org_id = new.org_id and b.message_id = new.id)
      ))
    or new.body_format is distinct from old.body_format
    or new.sent_at is distinct from old.sent_at
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'canonical mail content is immutable';
  end if;
  return new;
end
$$;

create or replace function helix_record_mail_journal(input_org_id uuid, input_message_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  configured_retention integer;
  journal_direction text;
  journal_custodians uuid[];
  journal_snapshot jsonb;
  previous_hash text;
begin
  if public.helix_current_org_id() is distinct from input_org_id then
    raise insufficient_privilege using message = 'invalid mail journal tenant context';
  end if;
  select retention_days into configured_retention
  from public.mail_journal_settings where org_id = input_org_id and enabled;
  if configured_retention is null then return false; end if;

  select message.metadata->>'direction',
    public.helix_governance_item_custodians(input_org_id, 'mail', 'message', message.id),
    jsonb_build_object(
      'message', to_jsonb(message),
      'thread', to_jsonb(thread),
      'attachments', coalesce((
        select jsonb_agg(jsonb_build_object(
          'objectId', object.id, 'storageKey', object.storage_key,
          'sha256', object.sha256, 'byteSize', object.byte_size
        ) order by object.id)
        from public.message_attachments attachment
        join public.objects object on object.org_id = attachment.org_id and object.id = attachment.object_id
        where attachment.org_id = input_org_id and attachment.message_id = message.id
      ), '[]'::jsonb),
      'mailBody', public.helix_mail_body_reference(input_org_id, message.id),
      'rawSource', (
        select jsonb_build_object(
          'objectId', object.id, 'storageKey', object.storage_key,
          'sha256', object.sha256, 'byteSize', object.byte_size
        )
        from public.mail_raw_sources source
        join public.objects object on object.org_id = source.org_id and object.id = source.object_id
        where source.org_id = input_org_id and source.message_id = message.id
      )
    )
  into journal_direction, journal_custodians, journal_snapshot
  from public.messages message
  join public.threads thread on thread.org_id = message.org_id and thread.id = message.thread_id
  where message.org_id = input_org_id and message.id = input_message_id and message.kind = 'mail';
  if journal_snapshot is null then raise no_data_found using message = 'mail journal source missing'; end if;
  if journal_direction not in ('inbound', 'outbound') then
    raise check_violation using message = 'mail journal direction missing';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('mail-journal:' || input_org_id::text, 0));
  select content_sha256 into previous_hash
  from public.mail_journal_entries where org_id = input_org_id
  order by created_at desc, id desc limit 1;
  insert into public.mail_journal_entries (
    org_id, message_id, direction, custodians, snapshot, content_sha256,
    previous_sha256, retention_until
  ) values (
    input_org_id, input_message_id, journal_direction, journal_custodians, journal_snapshot,
    encode(digest(convert_to(coalesce(previous_hash, '') || ':' || journal_snapshot::text, 'UTF8'), 'sha256'), 'hex'),
    previous_hash, statement_timestamp() + make_interval(days => configured_retention)
  ) on conflict (org_id, message_id) do nothing;
  return found;
end
$$;

create or replace function helix_governance_items(input_org_id uuid)
returns table (
  item_key text, product text, resource_type text, resource_id uuid, revision text,
  occurred_at timestamptz, custodians uuid[], search_text text, snapshot jsonb,
  storage_objects jsonb, item_sha256 text
)
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  with source as (
    select message.kind::text product, 'message'::text resource_type, message.id resource_id,
      case when message.kind::text = 'chat' then 'current-' || message.chat_revision::text else 'current' end revision,
      message.sent_at occurred_at,
      helix_governance_item_custodians(message.org_id, message.kind::text, 'message', message.id) custodians,
      concat_ws(' ', thread.subject, message.body, message.metadata::text) search_text,
      jsonb_build_object('message', to_jsonb(message), 'thread', to_jsonb(thread))
        || case when body.message_id is null then '{}'::jsonb else jsonb_build_object(
          'mailBody', helix_mail_body_reference(message.org_id, message.id)) end snapshot,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'key', object.storage_key, 'sha256', object.sha256, 'byteSize', object.byte_size
        ) order by object.storage_key)
        from objects object
        where object.org_id = message.org_id and object.id in (
          select attachment.object_id from message_attachments attachment
          where attachment.org_id = message.org_id and attachment.message_id = message.id
          union
          select raw.object_id from mail_raw_sources raw
          where raw.org_id = message.org_id and raw.message_id = message.id
        )
      ), '[]'::jsonb) || case when body.message_id is null then '[]'::jsonb else
        jsonb_build_array(jsonb_build_object('key', body.storage_key, 'sha256', body.sha256, 'byteSize', body.byte_size)) end storage_objects
    from messages message join threads thread
      on thread.org_id = message.org_id and thread.id = message.thread_id
    left join mail_message_bodies body on body.org_id = message.org_id and body.message_id = message.id
    where message.org_id = input_org_id and message.kind::text in ('mail', 'chat')

    union all
    select 'chat', 'message', revision.message_id, 'revision-' || revision.revision::text,
      revision.captured_at,
      helix_governance_item_custodians(revision.org_id, 'chat', 'message', revision.message_id),
      concat_ws(' ', revision.body, revision.metadata::text), to_jsonb(revision), '[]'::jsonb
    from chat_message_revisions revision
    where revision.org_id = input_org_id

    union all
    select case when object.kind::text = 'recording' then 'recording' else 'drive' end,
      'object', object.id, 'current', object.created_at,
      helix_governance_item_custodians(object.org_id,
        case when object.kind::text = 'recording' then 'recording' else 'drive' end,
        'object', object.id),
      concat_ws(' ', object.metadata->>'name', object.metadata::text, object.mime_type),
      to_jsonb(object), jsonb_build_array(jsonb_build_object(
        'key', object.storage_key, 'sha256', object.sha256, 'byteSize', object.byte_size
      ))
    from objects object
    where object.org_id = input_org_id and object.kind::text in ('file', 'recording')

    union all
    select case when object.kind::text = 'recording' then 'recording' else 'drive' end,
      'object', version.object_id, 'version-' || version.version_number::text, version.created_at,
      helix_governance_item_custodians(version.org_id,
        case when object.kind::text = 'recording' then 'recording' else 'drive' end,
        'object', version.object_id),
      concat_ws(' ', object.metadata->>'name', version.metadata::text, version.mime_type),
      to_jsonb(version), jsonb_build_array(jsonb_build_object(
        'key', version.storage_key, 'sha256', version.sha256, 'byteSize', version.byte_size
      ))
    from drive_versions version join objects object
      on object.org_id = version.org_id and object.id = version.object_id
    where version.org_id = input_org_id and object.kind::text in ('file', 'recording')

    union all
    select 'comment', 'comment', comment.id, 'current-' || comment.revision::text,
      coalesce(comment.updated_at, comment.created_at),
      helix_governance_item_custodians(comment.org_id, 'comment', 'comment', comment.id),
      concat_ws(' ', comment.body, comment.metadata::text), to_jsonb(comment), '[]'::jsonb
    from drive_comments comment where comment.org_id = input_org_id

    union all
    select 'comment', 'comment', revision.comment_id, 'revision-' || revision.revision::text,
      revision.captured_at,
      helix_governance_item_custodians(revision.org_id, 'comment', 'comment', revision.comment_id),
      concat_ws(' ', revision.body, revision.metadata::text), to_jsonb(revision), '[]'::jsonb
    from drive_comment_revisions revision where revision.org_id = input_org_id

    union all
    select 'calendar', 'calendar_event', event.id, 'current-' || event.ics_sequence::text,
      event.created_at,
      helix_governance_item_custodians(event.org_id, 'calendar', 'calendar_event', event.id),
      concat_ws(' ', event.title, event.description, event.location, event.metadata::text),
      jsonb_build_object('event', to_jsonb(event), 'attendees', coalesce((
        select jsonb_agg(to_jsonb(attendee) order by attendee.email)
        from cal_attendees attendee where attendee.org_id = event.org_id and attendee.event_id = event.id
      ), '[]'::jsonb)), '[]'::jsonb
    from cal_events event where event.org_id = input_org_id

    union all
    select 'calendar', 'calendar_event', revision.event_id, 'revision-' || revision.revision::text,
      revision.created_at,
      helix_governance_item_custodians(revision.org_id, 'calendar', 'calendar_event', revision.event_id),
      revision.snapshot::text, revision.snapshot, '[]'::jsonb
    from cal_event_revisions revision where revision.org_id = input_org_id
  )
  select product || ':' || resource_type || ':' || resource_id::text || ':' || revision,
    product, resource_type, resource_id, revision, occurred_at, custodians,
    search_text, snapshot, storage_objects,
    encode(digest(convert_to(
      product || ':' || resource_type || ':' || resource_id::text || ':' || revision || ':'
      || snapshot::text || ':' || storage_objects::text, 'UTF8'
    ), 'sha256'), 'hex')
  from source
$$;

create or replace function helix_governance_search_with_bodies(
  input_org_id uuid, input_actor_id uuid, input_matter_id uuid, input_query text,
  input_products text[], input_from timestamptz, input_to timestamptz,
  input_after text, input_limit integer
)
returns table (
  item_key text, product text, resource_type text, resource_id uuid, revision text,
  occurred_at timestamptz, custodians uuid[], snapshot jsonb, storage_objects jsonb,
  item_sha256 text, review_disposition text, matches_metadata boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
    or input_limit not between 1 and 500
    or not exists (select 1 from governance_matters where org_id = input_org_id and id = input_matter_id)
  then raise insufficient_privilege using message = 'invalid eDiscovery search context'; end if;
  return query
  select item.item_key, item.product, item.resource_type, item.resource_id, item.revision,
    item.occurred_at, item.custodians, item.snapshot, item.storage_objects, item.item_sha256,
    review.disposition, (nullif(btrim(input_query), '') is null or strpos(lower(item.search_text), lower(input_query)) > 0)
  from helix_governance_items(input_org_id) item
  left join governance_review_items review on review.org_id = input_org_id
    and review.matter_id = input_matter_id and review.item_key = item.item_key
  where (input_after is null or item.item_key > input_after)
    and (coalesce(array_length(input_products, 1), 0) = 0 or item.product = any(input_products))
    and (input_from is null or item.occurred_at >= input_from)
    and (input_to is null or item.occurred_at < input_to)
    and (nullif(btrim(input_query), '') is null or strpos(lower(item.search_text), lower(input_query)) > 0 or item.snapshot ? 'mailBody')
    and (
      not exists (select 1 from governance_matter_custodians custodian
        where custodian.org_id = input_org_id and custodian.matter_id = input_matter_id)
      or exists (select 1 from governance_hold_resources resource
        join governance_legal_holds hold_record on hold_record.org_id = resource.org_id
          and hold_record.id = resource.hold_id
        where resource.org_id = input_org_id and hold_record.matter_id = input_matter_id
          and resource.product = item.product and resource.resource_type = item.resource_type
          and resource.resource_id = item.resource_id)
      or exists (select 1 from governance_matter_custodians custodian
        where custodian.org_id = input_org_id and custodian.matter_id = input_matter_id
          and custodian.actor_id = any(item.custodians))
    )
  order by item.item_key
  limit input_limit;
end
$$;
alter function helix_governance_search_with_bodies(uuid, uuid, uuid, text, text[], timestamptz, timestamptz, text, integer) owner to helix_migration_owner;
revoke all on function helix_governance_search_with_bodies(uuid, uuid, uuid, text, text[], timestamptz, timestamptz, text, integer) from public;
grant execute on function helix_governance_search_with_bodies(uuid, uuid, uuid, text, text[], timestamptz, timestamptz, text, integer) to helix_app;

