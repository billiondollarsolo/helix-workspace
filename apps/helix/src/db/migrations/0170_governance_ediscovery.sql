-- One cross-product retention, legal-hold, and eDiscovery model. Product rows
-- remain the source of truth; their existing immutable revisions are searched
-- directly, and these guards prevent physical purge while governance applies.

create table governance_matters (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 255),
  description text not null default '' check (octet_length(description) <= 10000),
  status text not null default 'open' check (status in ('open', 'closed')),
  created_by_actor_id uuid not null,
  closed_by_actor_id uuid,
  closed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (org_id, id),
  foreign key (org_id, created_by_actor_id) references actors(org_id, id),
  foreign key (org_id, closed_by_actor_id) references actors(org_id, id),
  check ((status = 'open' and closed_at is null and closed_by_actor_id is null)
    or (status = 'closed' and closed_at is not null and closed_by_actor_id is not null))
);

create table governance_matter_custodians (
  org_id uuid not null,
  matter_id uuid not null,
  actor_id uuid not null,
  added_by_actor_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  primary key (org_id, matter_id, actor_id),
  foreign key (org_id, matter_id) references governance_matters(org_id, id) on delete cascade,
  foreign key (org_id, actor_id) references actors(org_id, id),
  foreign key (org_id, added_by_actor_id) references actors(org_id, id)
);

create table governance_legal_holds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  matter_id uuid not null,
  product text not null default 'all'
    check (product in ('all', 'mail', 'chat', 'drive', 'calendar', 'comment', 'recording')),
  resource_type text,
  resource_id uuid,
  reason text not null check (char_length(btrim(reason)) between 1 and 2000),
  created_by_actor_id uuid not null,
  released_by_actor_id uuid,
  released_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  unique (org_id, id),
  foreign key (org_id, matter_id) references governance_matters(org_id, id) on delete cascade,
  foreign key (org_id, created_by_actor_id) references actors(org_id, id),
  foreign key (org_id, released_by_actor_id) references actors(org_id, id),
  check ((resource_type is null and resource_id is null)
    or (resource_type is not null and resource_id is not null)),
  check ((released_at is null and released_by_actor_id is null)
    or (released_at is not null and released_by_actor_id is not null and released_at >= created_at))
);

create index governance_legal_holds_active_idx
  on governance_legal_holds(org_id, product, matter_id) where released_at is null;

-- Freeze the resource/custodian relationship when a hold starts. Membership,
-- delivery, or ACL changes may continue without making held content disappear.
create table governance_hold_resources (
  org_id uuid not null,
  hold_id uuid not null,
  product text not null
    check (product in ('mail', 'chat', 'drive', 'calendar', 'comment', 'recording')),
  resource_type text not null,
  resource_id uuid not null,
  captured_at timestamptz not null default statement_timestamp(),
  primary key (org_id, hold_id, product, resource_type, resource_id),
  foreign key (org_id, hold_id) references governance_legal_holds(org_id, id) on delete cascade
);

create table governance_retention_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 255),
  product text not null default 'all'
    check (product in ('all', 'mail', 'chat', 'drive', 'calendar', 'comment', 'recording')),
  custodian_actor_id uuid,
  retention_days integer not null check (retention_days between 1 and 36500),
  enabled boolean not null default true,
  created_by_actor_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique nulls not distinct (org_id, name, product, custodian_actor_id),
  foreign key (org_id, custodian_actor_id) references actors(org_id, id),
  foreign key (org_id, created_by_actor_id) references actors(org_id, id)
);

create index governance_retention_policies_match_idx
  on governance_retention_policies(org_id, product, custodian_actor_id) where enabled;

create table governance_review_items (
  org_id uuid not null,
  matter_id uuid not null,
  item_key text not null check (char_length(item_key) between 1 and 500),
  item_sha256 text not null check (item_sha256 ~ '^[a-f0-9]{64}$'),
  disposition text not null check (disposition in ('responsive', 'nonresponsive', 'privileged')),
  note text not null default '' check (octet_length(note) <= 10000),
  reviewed_by_actor_id uuid not null,
  reviewed_at timestamptz not null default statement_timestamp(),
  primary key (org_id, matter_id, item_key),
  foreign key (org_id, matter_id) references governance_matters(org_id, id) on delete cascade,
  foreign key (org_id, reviewed_by_actor_id) references actors(org_id, id)
);

create table governance_exports (
  id uuid primary key,
  org_id uuid not null,
  matter_id uuid not null,
  generated_by_actor_id uuid not null,
  query jsonb not null check (jsonb_typeof(query) = 'object'),
  item_count integer not null check (item_count >= 0),
  object_key text not null,
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  previous_manifest_sha256 text check (previous_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default statement_timestamp(),
  unique (org_id, id),
  unique (org_id, manifest_sha256),
  foreign key (org_id, matter_id) references governance_matters(org_id, id),
  foreign key (org_id, generated_by_actor_id) references actors(org_id, id)
);

create unique index governance_exports_chain_idx
  on governance_exports(org_id, matter_id, previous_manifest_sha256) nulls not distinct;

create table governance_export_objects (
  org_id uuid not null,
  export_id uuid not null,
  kind text not null check (kind in ('content', 'manifest', 'source_copy')),
  object_key text not null,
  source_key text,
  sha256 text check (sha256 is null or sha256 ~ '^[a-f0-9]{64}$'),
  byte_size bigint check (byte_size is null or byte_size >= 0),
  primary key (org_id, export_id, object_key),
  foreign key (org_id, export_id) references governance_exports(org_id, id) on delete cascade
);

create function helix_governance_item_custodians(
  input_org_id uuid, input_product text, input_resource_type text, input_resource_id uuid
)
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select coalesce(array_agg(distinct actor_id order by actor_id), array[]::uuid[])
  from (
    select message.actor_id
    from messages message
    where input_resource_type = 'message' and message.org_id = input_org_id
      and message.id = input_resource_id and message.actor_id is not null
    union
    select delivery.actor_id
    from mail_message_deliveries delivery
    where input_product = 'mail' and input_resource_type = 'message'
      and delivery.org_id = input_org_id and delivery.message_id = input_resource_id
    union
    select permission.actor_id
    from messages message join permissions permission
      on permission.org_id = message.org_id and permission.resource_type = 'thread'
      and permission.resource_id = message.thread_id
    where input_product = 'chat' and input_resource_type = 'message'
      and message.org_id = input_org_id and message.id = input_resource_id
      and permission.status = 'active' and permission.revoked_at is null
      and permission.valid_from <= statement_timestamp()
      and (permission.expires_at is null or permission.expires_at > statement_timestamp())
    union
    select object.owner_actor_id
    from objects object
    where input_resource_type = 'object' and object.org_id = input_org_id
      and object.id = input_resource_id and object.owner_actor_id is not null
    union
    select permission.actor_id from permissions permission
    where input_resource_type = 'object' and permission.org_id = input_org_id
      and permission.resource_type = 'object' and permission.resource_id = input_resource_id
      and permission.status = 'active' and permission.revoked_at is null
      and permission.valid_from <= statement_timestamp()
      and (permission.expires_at is null or permission.expires_at > statement_timestamp())
    union
    select comment.actor_id
    from drive_comments comment
    where input_resource_type = 'comment' and comment.org_id = input_org_id
      and comment.id = input_resource_id and comment.actor_id is not null
    union
    select event.organizer_actor_id
    from cal_events event
    where input_resource_type = 'calendar_event' and event.org_id = input_org_id
      and event.id = input_resource_id and event.organizer_actor_id is not null
    union
    select attendee.actor_id from cal_attendees attendee
    where input_resource_type = 'calendar_event' and attendee.org_id = input_org_id
      and attendee.event_id = input_resource_id and attendee.actor_id is not null
  ) custodians(actor_id)
$$;

-- Hold always wins. Otherwise the longest matching organization/product or
-- custodian policy wins, so a narrower policy can never shorten retention.
create function helix_governance_retention_until(
  input_org_id uuid, input_product text, input_created_at timestamptz, input_custodians uuid[]
)
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select max(input_created_at + make_interval(days => policy.retention_days))
  from governance_retention_policies policy
  where policy.org_id = input_org_id and policy.enabled
    and policy.product in ('all', input_product)
    and (policy.custodian_actor_id is null or policy.custodian_actor_id = any(input_custodians))
$$;

create function helix_governance_is_held(
  input_org_id uuid, input_product text, input_resource_type text,
  input_resource_id uuid, input_custodians uuid[]
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select exists (
    select 1
    from governance_legal_holds hold_record
    where hold_record.org_id = input_org_id and hold_record.released_at is null
      and hold_record.product in ('all', input_product)
      and (hold_record.resource_id is null or (
        hold_record.resource_type = input_resource_type
        and hold_record.resource_id = input_resource_id
      ))
      and (
        exists (
          select 1 from governance_hold_resources resource
          where resource.org_id = hold_record.org_id and resource.hold_id = hold_record.id
            and resource.product = input_product and resource.resource_type = input_resource_type
            and resource.resource_id = input_resource_id
        )
        or
        not exists (
          select 1 from governance_matter_custodians custodian
          where custodian.org_id = hold_record.org_id and custodian.matter_id = hold_record.matter_id
        )
        or exists (
          select 1 from governance_matter_custodians custodian
          where custodian.org_id = hold_record.org_id and custodian.matter_id = hold_record.matter_id
            and custodian.actor_id = any(input_custodians)
        )
      )
  )
$$;

create function helix_governance_items(input_org_id uuid)
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
      jsonb_build_object('message', to_jsonb(message), 'thread', to_jsonb(thread)) snapshot,
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
      ), '[]'::jsonb) storage_objects
    from messages message join threads thread
      on thread.org_id = message.org_id and thread.id = message.thread_id
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

create function helix_governance_search(
  input_org_id uuid, input_actor_id uuid, input_matter_id uuid, input_query text,
  input_products text[], input_from timestamptz, input_to timestamptz,
  input_after text, input_limit integer
)
returns table (
  item_key text, product text, resource_type text, resource_id uuid, revision text,
  occurred_at timestamptz, custodians uuid[], snapshot jsonb, storage_objects jsonb,
  item_sha256 text, review_disposition text
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
    review.disposition
  from helix_governance_items(input_org_id) item
  left join governance_review_items review on review.org_id = input_org_id
    and review.matter_id = input_matter_id and review.item_key = item.item_key
  where (input_after is null or item.item_key > input_after)
    and (coalesce(array_length(input_products, 1), 0) = 0 or item.product = any(input_products))
    and (input_from is null or item.occurred_at >= input_from)
    and (input_to is null or item.occurred_at < input_to)
    and (nullif(btrim(input_query), '') is null or item.search_text ilike '%' || input_query || '%')
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

create function helix_governance_capture_resource(
  input_org_id uuid, input_product text, input_resource_type text, input_resource_id uuid
)
returns void
language sql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  insert into governance_hold_resources(org_id, hold_id, product, resource_type, resource_id)
  select input_org_id, hold_record.id, input_product, input_resource_type, input_resource_id
  from governance_legal_holds hold_record
  where hold_record.org_id = input_org_id and hold_record.released_at is null
    and hold_record.product in ('all', input_product)
    and (hold_record.resource_id is null or (
      hold_record.resource_type = input_resource_type and hold_record.resource_id = input_resource_id
    ))
    and (
      not exists (select 1 from governance_matter_custodians custodian
        where custodian.org_id = input_org_id and custodian.matter_id = hold_record.matter_id)
      or exists (select 1 from governance_matter_custodians custodian
        where custodian.org_id = input_org_id and custodian.matter_id = hold_record.matter_id
          and custodian.actor_id = any(helix_governance_item_custodians(
            input_org_id, input_product, input_resource_type, input_resource_id
          )))
    )
  on conflict do nothing
$$;

create function helix_governance_capture_hold()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if new.resource_id is not null then
    insert into governance_hold_resources(org_id, hold_id, product, resource_type, resource_id)
    select new.org_id, new.id, item.product, new.resource_type, new.resource_id
    from (values
      ('mail'), ('chat'), ('drive'), ('calendar'), ('comment'), ('recording')
    ) item(product)
    where new.product in ('all', item.product)
    on conflict do nothing;
  else
    insert into governance_hold_resources(org_id, hold_id, product, resource_type, resource_id)
    select distinct new.org_id, new.id, item.product, item.resource_type, item.resource_id
    from helix_governance_items(new.org_id) item
    where new.product in ('all', item.product)
      and (
        not exists (select 1 from governance_matter_custodians custodian
          where custodian.org_id = new.org_id and custodian.matter_id = new.matter_id)
        or exists (select 1 from governance_matter_custodians custodian
          where custodian.org_id = new.org_id and custodian.matter_id = new.matter_id
            and custodian.actor_id = any(item.custodians))
      )
    on conflict do nothing;
  end if;
  return new;
end
$$;

create trigger governance_legal_holds_capture after insert on governance_legal_holds
  for each row execute function helix_governance_capture_hold();

create function helix_governance_capture_product_resource()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare row_data jsonb := to_jsonb(new); product_name text; resource_type_name text; resource_id_value uuid;
begin
  if tg_table_name = 'messages' then
    product_name := row_data->>'kind'; resource_type_name := 'message';
    resource_id_value := (row_data->>'id')::uuid;
  elsif tg_table_name in ('mail_message_deliveries', 'message_attachments') then
    select message.kind::text into product_name from messages message
    where message.org_id = (row_data->>'org_id')::uuid
      and message.id = (row_data->>'message_id')::uuid;
    resource_type_name := 'message'; resource_id_value := (row_data->>'message_id')::uuid;
  elsif tg_table_name = 'objects' and row_data->>'kind' in ('file', 'recording') then
    product_name := case when row_data->>'kind' = 'recording' then 'recording' else 'drive' end;
    resource_type_name := 'object'; resource_id_value := (row_data->>'id')::uuid;
  elsif tg_table_name = 'drive_comments' then
    product_name := 'comment'; resource_type_name := 'comment';
    resource_id_value := (row_data->>'id')::uuid;
  elsif tg_table_name = 'cal_events' then
    product_name := 'calendar'; resource_type_name := 'calendar_event';
    resource_id_value := (row_data->>'id')::uuid;
  elsif tg_table_name = 'cal_attendees' then
    product_name := 'calendar'; resource_type_name := 'calendar_event';
    resource_id_value := (row_data->>'event_id')::uuid;
  elsif tg_table_name = 'permissions' and row_data->>'resource_type' = 'object' then
    select case when object.kind::text = 'recording' then 'recording' else 'drive' end
      into product_name from objects object where object.org_id = (row_data->>'org_id')::uuid
        and object.id = (row_data->>'resource_id')::uuid;
    resource_type_name := 'object'; resource_id_value := (row_data->>'resource_id')::uuid;
  elsif tg_table_name = 'permissions' and row_data->>'resource_type' = 'thread' then
    for resource_id_value in select message.id from messages message
      where message.org_id = (row_data->>'org_id')::uuid
        and message.thread_id = (row_data->>'resource_id')::uuid and message.kind::text = 'chat'
    loop
      perform helix_governance_capture_resource(
        (row_data->>'org_id')::uuid, 'chat', 'message', resource_id_value
      );
    end loop;
    return new;
  else return new;
  end if;
  if product_name in ('mail', 'chat', 'drive', 'calendar', 'comment', 'recording') then
    perform helix_governance_capture_resource(
      (row_data->>'org_id')::uuid, product_name, resource_type_name, resource_id_value
    );
  end if;
  return new;
end
$$;

create trigger messages_governance_hold_capture after insert on messages
  for each row execute function helix_governance_capture_product_resource();
create trigger deliveries_governance_hold_capture after insert on mail_message_deliveries
  for each row execute function helix_governance_capture_product_resource();
create trigger attachments_governance_hold_capture after insert on message_attachments
  for each row execute function helix_governance_capture_product_resource();
create trigger objects_governance_hold_capture after insert on objects
  for each row execute function helix_governance_capture_product_resource();
create trigger comments_governance_hold_capture after insert on drive_comments
  for each row execute function helix_governance_capture_product_resource();
create trigger events_governance_hold_capture after insert on cal_events
  for each row execute function helix_governance_capture_product_resource();
create trigger attendees_governance_hold_capture after insert on cal_attendees
  for each row execute function helix_governance_capture_product_resource();
create trigger permissions_governance_hold_capture after insert or update on permissions
  for each row execute function helix_governance_capture_product_resource();

create function helix_governance_purge_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  row_data jsonb := to_jsonb(old);
  item_org_id uuid := (row_data->>'org_id')::uuid;
  item_product text;
  item_resource_type text;
  item_resource_id uuid;
  item_created_at timestamptz;
  item_custodians uuid[];
begin
  if tg_table_name in (
    'mail_message_deliveries', 'message_attachments', 'mail_raw_sources', 'mail_attachment_ingestions'
  ) then
    if nullif(row_data->>'message_id', '') is null then return old; end if;
    select message.kind::text, message.id, message.created_at
      into item_product, item_resource_id, item_created_at
    from messages message where message.org_id = item_org_id
      and message.id = (row_data->>'message_id')::uuid;
    item_resource_type := 'message';
  elsif tg_table_name = 'messages' then
    item_product := row_data->>'kind'; item_resource_type := 'message';
    item_resource_id := (row_data->>'id')::uuid;
    item_created_at := (row_data->>'created_at')::timestamptz;
  elsif tg_table_name = 'drive_versions' then
    select case when object.kind::text = 'recording' then 'recording' else 'drive' end,
      object.created_at into item_product, item_created_at
    from objects object where object.org_id = item_org_id
      and object.id = (row_data->>'object_id')::uuid;
    item_resource_type := 'object'; item_resource_id := (row_data->>'object_id')::uuid;
  elsif tg_table_name = 'objects' then
    if row_data->>'kind' not in ('file', 'recording') then return old; end if;
    item_product := case when row_data->>'kind' = 'recording' then 'recording' else 'drive' end;
    item_resource_type := 'object'; item_resource_id := (row_data->>'id')::uuid;
    item_created_at := (row_data->>'created_at')::timestamptz;
  elsif tg_table_name = 'drive_folders' then
    item_product := 'drive'; item_resource_type := 'folder';
    item_resource_id := (row_data->>'id')::uuid;
    item_created_at := (row_data->>'created_at')::timestamptz;
  elsif tg_table_name = 'drive_comments' then
    item_product := 'comment'; item_resource_type := 'comment';
    item_resource_id := (row_data->>'id')::uuid;
    item_created_at := (row_data->>'created_at')::timestamptz;
  elsif tg_table_name = 'cal_events' then
    item_product := 'calendar'; item_resource_type := 'calendar_event';
    item_resource_id := (row_data->>'id')::uuid;
    item_created_at := (row_data->>'created_at')::timestamptz;
  else
    return old;
  end if;
  if item_product is null then return old; end if;
  item_custodians := helix_governance_item_custodians(
    item_org_id, item_product, item_resource_type, item_resource_id
  );
  if helix_governance_is_held(
      item_org_id, item_product, item_resource_type, item_resource_id, item_custodians
    ) or helix_governance_retention_until(
      item_org_id, item_product, item_created_at, item_custodians
    ) > statement_timestamp()
  then raise object_not_in_prerequisite_state using
    message = 'content is protected by retention or legal hold'; end if;
  return old;
end
$$;

create trigger messages_governance_purge_guard before delete on messages
  for each row execute function helix_governance_purge_guard();
create trigger message_attachments_governance_purge_guard before delete on message_attachments
  for each row execute function helix_governance_purge_guard();
create trigger mail_deliveries_governance_purge_guard before delete on mail_message_deliveries
  for each row execute function helix_governance_purge_guard();
create trigger mail_raw_sources_governance_purge_guard before delete on mail_raw_sources
  for each row execute function helix_governance_purge_guard();
create trigger mail_attachment_ingestions_governance_purge_guard before delete on mail_attachment_ingestions
  for each row execute function helix_governance_purge_guard();
create trigger objects_governance_purge_guard before delete on objects
  for each row execute function helix_governance_purge_guard();
create trigger drive_versions_governance_purge_guard before delete on drive_versions
  for each row execute function helix_governance_purge_guard();
create trigger drive_folders_governance_purge_guard before delete on drive_folders
  for each row execute function helix_governance_purge_guard();
create trigger drive_comments_governance_purge_guard before delete on drive_comments
  for each row execute function helix_governance_purge_guard();
create trigger cal_events_governance_purge_guard before delete on cal_events
  for each row execute function helix_governance_purge_guard();

-- Version payload identity is immutable. Storage rotation and preview
-- generation may still replace storage_key/metadata without rewriting bytes.
create function helix_governance_drive_version_immutable()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.id is distinct from old.id or new.org_id is distinct from old.org_id
    or new.object_id is distinct from old.object_id
    or new.version_number is distinct from old.version_number
    or new.mime_type is distinct from old.mime_type or new.byte_size is distinct from old.byte_size
    or new.sha256 is distinct from old.sha256
    or new.created_by_actor_id is distinct from old.created_by_actor_id
    or new.created_at is distinct from old.created_at
    or new.idempotency_key is distinct from old.idempotency_key
  then raise check_violation using message = 'Drive version content is immutable'; end if;
  return new;
end
$$;

create trigger drive_versions_governance_immutable before update on drive_versions
  for each row execute function helix_governance_drive_version_immutable();

create function helix_governance_review_item_valid()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if not exists (
    select 1 from helix_governance_items(new.org_id) item
    where item.item_key = new.item_key and item.item_sha256 = new.item_sha256
      and (
        not exists (select 1 from governance_matter_custodians custodian
          where custodian.org_id = new.org_id and custodian.matter_id = new.matter_id)
        or exists (select 1 from governance_hold_resources resource
          join governance_legal_holds hold_record on hold_record.org_id = resource.org_id
            and hold_record.id = resource.hold_id
          where resource.org_id = new.org_id and hold_record.matter_id = new.matter_id
            and resource.product = item.product and resource.resource_type = item.resource_type
            and resource.resource_id = item.resource_id)
        or exists (select 1 from governance_matter_custodians custodian
          where custodian.org_id = new.org_id and custodian.matter_id = new.matter_id
            and custodian.actor_id = any(item.custodians))
      )
  ) then raise check_violation using message = 'review item is not in the matter evidence set'; end if;
  return new;
end
$$;

create trigger governance_review_items_valid before insert or update on governance_review_items
  for each row execute function helix_governance_review_item_valid();

create function helix_governance_export_immutable()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  raise insufficient_privilege using message = 'eDiscovery exports are immutable';
end
$$;

create trigger governance_exports_immutable before update or delete on governance_exports
  for each row execute function helix_governance_export_immutable();
create trigger governance_export_objects_immutable before update or delete on governance_export_objects
  for each row execute function helix_governance_export_immutable();

create function helix_governance_hold_release_only()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'DELETE' then
    raise check_violation using message = 'legal holds cannot be deleted';
  elsif old.released_at is not null
    or new.org_id is distinct from old.org_id or new.matter_id is distinct from old.matter_id
    or new.product is distinct from old.product or new.resource_type is distinct from old.resource_type
    or new.resource_id is distinct from old.resource_id or new.reason is distinct from old.reason
    or new.created_by_actor_id is distinct from old.created_by_actor_id
    or new.created_at is distinct from old.created_at or new.released_at is null
  then raise check_violation using message = 'legal holds may only be released once'; end if;
  return new;
end
$$;

create trigger governance_legal_holds_release_only before update or delete on governance_legal_holds
  for each row execute function helix_governance_hold_release_only();

create function helix_governance_record_export(
  input_org_id uuid, input_actor_id uuid, input_export_id uuid, input_matter_id uuid,
  input_query jsonb, input_item_summaries jsonb, input_content_object_key text,
  input_content_sha256 text, input_manifest_object_key text, input_source_copies jsonb
)
returns governance_exports
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  prior_hash text;
  manifest_body jsonb;
  manifest_hash text;
  result governance_exports%rowtype;
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
    or jsonb_typeof(input_query) <> 'object'
    or jsonb_typeof(input_item_summaries) <> 'array'
    or jsonb_typeof(input_source_copies) <> 'array'
    or jsonb_array_length(input_item_summaries) > 10000
    or input_content_sha256 !~ '^[a-f0-9]{64}$'
    or not exists (select 1 from governance_matters
      where org_id = input_org_id and id = input_matter_id)
  then raise insufficient_privilege using message = 'invalid eDiscovery export context'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'governance-export:' || input_org_id::text || ':' || input_matter_id::text, 0
  ));
  select manifest_sha256 into prior_hash from governance_exports
  where org_id = input_org_id and matter_id = input_matter_id
  order by created_at desc, id desc limit 1;
  manifest_body := jsonb_build_object(
    'version', 1, 'exportId', input_export_id, 'matterId', input_matter_id,
    'generatedAt', statement_timestamp(), 'generatedByActorId', input_actor_id,
    'query', input_query, 'contentObjectKey', input_content_object_key,
    'contentSha256', input_content_sha256, 'previousManifestSha256', prior_hash,
    'items', input_item_summaries, 'sourceCopies', input_source_copies
  );
  manifest_hash := encode(digest(convert_to(
    coalesce(prior_hash, '') || ':' || manifest_body::text, 'UTF8'
  ), 'sha256'), 'hex');
  manifest_body := manifest_body || jsonb_build_object('manifestSha256', manifest_hash);
  insert into governance_exports(
    id, org_id, matter_id, generated_by_actor_id, query, item_count, object_key,
    content_sha256, manifest, manifest_sha256, previous_manifest_sha256
  ) values (
    input_export_id, input_org_id, input_matter_id, input_actor_id, input_query,
    jsonb_array_length(input_item_summaries), input_content_object_key,
    input_content_sha256, manifest_body, manifest_hash, prior_hash
  ) returning * into result;
  insert into governance_export_objects(org_id, export_id, kind, object_key, sha256)
  values
    (input_org_id, input_export_id, 'content', input_content_object_key, input_content_sha256),
    (input_org_id, input_export_id, 'manifest', input_manifest_object_key, manifest_hash);
  insert into governance_export_objects(
    org_id, export_id, kind, object_key, source_key, sha256, byte_size
  ) select input_org_id, input_export_id, 'source_copy', copy.object_key,
      copy.source_key, copy.sha256, copy.byte_size
    from jsonb_to_recordset(input_source_copies) as copy(
      object_key text, source_key text, sha256 text, byte_size bigint
    );
  return result;
end
$$;

-- Tenant deletion disables product triggers by design, so its preflight must
-- include the shared governance engine before that privileged path can start.
create or replace function helix_tenant_deletion_blockers(input_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select coalesce(jsonb_agg(blocker order by blocker->>'type'), '[]'::jsonb)
  from (
    select jsonb_build_object('type', 'mail_hold', 'count', count(*)) blocker
    from mail_retention_holds where org_id = input_org_id
      and (expires_at is null or expires_at > statement_timestamp()) having count(*) > 0
    union all select jsonb_build_object('type', 'drive_hold', 'count', count(*))
    from drive_retention_holds where org_id = input_org_id and released_at is null
      and (expires_at is null or expires_at > statement_timestamp()) having count(*) > 0
    union all select jsonb_build_object('type', 'drive_retention', 'count', count(*))
    from (select id from objects where org_id = input_org_id and retain_until > statement_timestamp()
      union all select id from drive_folders where org_id = input_org_id
        and retain_until > statement_timestamp()) retained_drive having count(*) > 0
    union all select jsonb_build_object('type', 'recording_hold_or_retention', 'count', count(*))
    from meet_recording_governance where org_id = input_org_id
      and (legal_hold or retention_until > statement_timestamp()) having count(*) > 0
    union all select jsonb_build_object('type', 'governance_legal_hold', 'count', count(*))
    from governance_legal_holds where org_id = input_org_id and released_at is null having count(*) > 0
    union all select jsonb_build_object('type', 'governance_retention', 'count', count(*))
    from helix_governance_items(input_org_id) item
    where helix_governance_retention_until(
      input_org_id, item.product, item.occurred_at, item.custodians
    ) > statement_timestamp() having count(*) > 0
  ) blockers
$$;

alter table governance_matters enable row level security;
alter table governance_matters force row level security;
alter table governance_matter_custodians enable row level security;
alter table governance_matter_custodians force row level security;
alter table governance_legal_holds enable row level security;
alter table governance_legal_holds force row level security;
alter table governance_hold_resources enable row level security;
alter table governance_hold_resources force row level security;
alter table governance_retention_policies enable row level security;
alter table governance_retention_policies force row level security;
alter table governance_review_items enable row level security;
alter table governance_review_items force row level security;
alter table governance_exports enable row level security;
alter table governance_exports force row level security;
alter table governance_export_objects enable row level security;
alter table governance_export_objects force row level security;

create policy helix_tenant_isolation on governance_matters
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());
create policy helix_tenant_isolation on governance_matter_custodians
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());
create policy helix_tenant_isolation on governance_legal_holds
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());
create policy helix_tenant_isolation on governance_hold_resources
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());
create policy helix_tenant_isolation on governance_retention_policies
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());
create policy helix_tenant_isolation on governance_review_items
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());
create policy helix_tenant_isolation on governance_exports
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());
create policy helix_tenant_isolation on governance_export_objects
  using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());

alter table governance_matters owner to helix_migration_owner;
alter table governance_matter_custodians owner to helix_migration_owner;
alter table governance_legal_holds owner to helix_migration_owner;
alter table governance_hold_resources owner to helix_migration_owner;
alter table governance_retention_policies owner to helix_migration_owner;
alter table governance_review_items owner to helix_migration_owner;
alter table governance_exports owner to helix_migration_owner;
alter table governance_export_objects owner to helix_migration_owner;
alter function helix_governance_item_custodians(uuid, text, text, uuid) owner to helix_migration_owner;
alter function helix_governance_retention_until(uuid, text, timestamptz, uuid[]) owner to helix_migration_owner;
alter function helix_governance_is_held(uuid, text, text, uuid, uuid[]) owner to helix_migration_owner;
alter function helix_governance_items(uuid) owner to helix_migration_owner;
alter function helix_governance_search(uuid, uuid, uuid, text, text[], timestamptz, timestamptz, text, integer) owner to helix_migration_owner;
alter function helix_governance_capture_resource(uuid, text, text, uuid) owner to helix_migration_owner;
alter function helix_governance_capture_hold() owner to helix_migration_owner;
alter function helix_governance_capture_product_resource() owner to helix_migration_owner;
alter function helix_governance_purge_guard() owner to helix_migration_owner;
alter function helix_governance_drive_version_immutable() owner to helix_migration_owner;
alter function helix_governance_review_item_valid() owner to helix_migration_owner;
alter function helix_governance_export_immutable() owner to helix_migration_owner;
alter function helix_governance_hold_release_only() owner to helix_migration_owner;
alter function helix_governance_record_export(uuid, uuid, uuid, uuid, jsonb, jsonb, text, text, text, jsonb) owner to helix_migration_owner;

revoke all on governance_matters, governance_matter_custodians, governance_legal_holds, governance_hold_resources,
  governance_retention_policies, governance_review_items, governance_exports,
  governance_export_objects from public, helix_app, helix_worker, helix_readonly;
grant select, insert, update on governance_matters, governance_matter_custodians,
  governance_legal_holds, governance_retention_policies, governance_review_items to helix_app;
grant select on governance_matters, governance_matter_custodians, governance_legal_holds,
  governance_hold_resources, governance_retention_policies, governance_review_items, governance_exports,
  governance_export_objects to helix_app, helix_worker, helix_readonly;
revoke execute on function helix_governance_item_custodians(uuid, text, text, uuid)
  from public, helix_app, helix_worker, helix_readonly;
revoke execute on function helix_governance_retention_until(uuid, text, timestamptz, uuid[])
  from public, helix_app, helix_worker, helix_readonly;
revoke execute on function helix_governance_is_held(uuid, text, text, uuid, uuid[])
  from public, helix_app, helix_worker, helix_readonly;
revoke execute on function helix_governance_items(uuid)
  from public, helix_app, helix_worker, helix_readonly;
revoke execute on function helix_governance_search(uuid, uuid, uuid, text, text[], timestamptz, timestamptz, text, integer)
  from public, helix_app, helix_worker, helix_readonly;
revoke execute on function helix_governance_capture_resource(uuid, text, text, uuid)
  from public, helix_app, helix_worker, helix_readonly;
revoke execute on function helix_governance_capture_hold()
  from public, helix_app, helix_worker, helix_readonly;
revoke execute on function helix_governance_capture_product_resource()
  from public, helix_app, helix_worker, helix_readonly;
revoke execute on function helix_governance_purge_guard()
  from public, helix_app, helix_worker, helix_readonly;
revoke execute on function helix_governance_drive_version_immutable()
  from public, helix_app, helix_worker, helix_readonly;
revoke execute on function helix_governance_review_item_valid()
  from public, helix_app, helix_worker, helix_readonly;
revoke execute on function helix_governance_export_immutable()
  from public, helix_app, helix_worker, helix_readonly;
revoke execute on function helix_governance_hold_release_only()
  from public, helix_app, helix_worker, helix_readonly;
revoke execute on function helix_governance_record_export(uuid, uuid, uuid, uuid, jsonb, jsonb, text, text, text, jsonb)
  from public, helix_app, helix_worker, helix_readonly;
grant execute on function helix_governance_search(uuid, uuid, uuid, text, text[], timestamptz, timestamptz, text, integer) to helix_app;
grant execute on function helix_governance_record_export(uuid, uuid, uuid, uuid, jsonb, jsonb, text, text, text, jsonb) to helix_app;
