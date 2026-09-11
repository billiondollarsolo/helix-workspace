-- Mailbox ownership and message authorship are distinct after an audited handoff.
alter table mail_message_deliveries add column sent_at timestamptz;
update mail_message_deliveries delivery set sent_at = message.sent_at
from messages message where message.org_id = delivery.org_id and message.id = delivery.message_id
  and message.actor_id = delivery.actor_id and message.metadata->>'direction' = 'outbound';
create function helix_mail_delivery_sent_provenance() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if current_user <> 'helix_migration_owner' then
    if tg_op = 'UPDATE' then
      new.sent_at := old.sent_at;
    else
      select message.sent_at into new.sent_at from messages message
      where message.org_id = new.org_id and message.id = new.message_id
        and message.actor_id = new.actor_id and message.metadata->>'direction' = 'outbound';
    end if;
  end if;
  return new;
end;
$$;
create trigger mail_delivery_sent_provenance before insert or update on mail_message_deliveries
for each row execute function helix_mail_delivery_sent_provenance();
create function helix_mailbox_sent_message(tenant_id uuid, message_id uuid, mailbox_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select tenant_id = public.helix_current_org_id() and exists (
    select 1 from messages message where message.org_id = tenant_id and message.id = message_id
      and (message.actor_id = mailbox_id or exists (
        select 1 from mail_message_deliveries delivery where delivery.org_id = tenant_id
          and delivery.message_id = message.id and delivery.actor_id = mailbox_id and delivery.sent_at is not null
      ))
  )
$$;
alter function helix_mailbox_sent_message(uuid, uuid, uuid) owner to helix_migration_owner;
revoke all on function helix_mailbox_sent_message(uuid, uuid, uuid) from public;
grant execute on function helix_mailbox_sent_message(uuid, uuid, uuid) to helix_app, helix_worker;

alter table mail_aliases add column receive_domain_aliases boolean not null default false;

-- Reuse the active mailbox-principal boundary for receive-only handoffs to agents.
create or replace function helix_validate_alias_address() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  new.email := lower(btrim(new.email));
  if new.enabled and new.disabled_at is null then
    if not public.helix_mailbox_principal_is_active(new.org_id, new.actor_id) then
      raise check_violation using constraint = 'mail_aliases_active_target_check',
        message = 'mail alias target must be an active mailbox principal in the same organization';
    end if;
    perform public.helix_assert_directory_address(new.org_id, new.email, 'alias', new.id);
  end if;
  return new;
end;
$$;

create function helix_actor_is_account_admin(tenant_id uuid, principal_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  with principal as (
    select actor.scopes, public.helix_actor_role_bindings(tenant_id, principal_id) bindings
    from actors actor where actor.org_id = tenant_id and actor.id = principal_id and actor.type = 'user'
      and public.helix_credential_principal_is_active(actor.id, actor.org_id)
  ), bindings as (
    select binding from principal, jsonb_array_elements(principal.bindings) binding
    where binding->>'scopeType' = 'org'
  )
  select exists (select 1 from principal
    where not exists (select 1 from bindings where binding->'deny' ? 'admin.users')
      and exists (select 1 from (values ('admin.users'), ('admin.console.write')) permissions(permission)
        where not exists (select 1 from bindings where binding->'deny' ? permissions.permission)
          and (principal.scopes && array[permissions.permission, 'admin.*', '*']
            or exists (select 1 from bindings where binding->'allow' ? permissions.permission))))
$$;
alter function helix_actor_is_account_admin(uuid, uuid) owner to helix_migration_owner;
revoke all on function helix_actor_is_account_admin(uuid, uuid) from public;

create function helix_actor_offboard_preview(
  tenant_id uuid, source_id uuid, successor_id uuid, keep_addresses boolean, archive_without_successor boolean default false
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public set row_security = off as $$
declare
  source_record actors%rowtype;
  successor_record actors%rowtype;
  counts jsonb;
  addresses jsonb;
  blockers text[] := '{}';
  preview jsonb;
begin
  if tenant_id is distinct from public.helix_current_org_id()
    or (public.helix_current_actor_id() is not null and not public.helix_user_address_admin_access(tenant_id, true))
    or (archive_without_successor and public.helix_current_actor_id() is not null)
  then raise insufficient_privilege using message = 'Account offboarding permission denied.'; end if;
  select * into source_record from actors where org_id = tenant_id and id = source_id;
  if not found then return null; end if;
  if source_record.type not in ('user', 'agent', 'service_account') then
    blockers := array_append(blockers, 'System accounts cannot be offboarded.');
  end if;
  if source_id = public.helix_current_actor_id() then
    blockers := array_append(blockers, 'Administrators cannot offboard themselves.');
  end if;
  if public.helix_actor_is_account_admin(tenant_id, source_id) and not exists (
    select 1 from actors actor where actor.org_id = tenant_id and actor.id <> source_id
      and public.helix_actor_is_account_admin(tenant_id, actor.id)
  ) then blockers := array_append(blockers, 'The last active workspace administrator cannot be offboarded.'); end if;
  if successor_id is not null then
    select * into successor_record from actors where org_id = tenant_id and id = successor_id
      and type in ('user', 'agent', 'service_account') and public.helix_mailbox_principal_is_active(tenant_id, id);
    if not found or successor_id = source_id then
      blockers := array_append(blockers, 'Choose a different active user or agent in this workspace.');
    end if;
  end if;
  select jsonb_build_object(
    'driveFiles', (select count(*) from objects where org_id = tenant_id and owner_actor_id = source_id and kind <> 'mail_source'),
    'driveFolders', (select count(*) from drive_folders where org_id = tenant_id and owner_actor_id = source_id),
    'mailMessages', (select count(*) from messages message where message.org_id = tenant_id and message.kind = 'mail'
      and (message.actor_id = source_id or exists (select 1 from mail_message_deliveries delivery
        where delivery.org_id = tenant_id and delivery.message_id = message.id and delivery.actor_id = source_id))),
    'mailDrafts', (select count(*) from mail_drafts where org_id = tenant_id and actor_id = source_id),
    'calendars', (select count(*) from cal_calendars where org_id = tenant_id and owner_actor_id = source_id),
    'contacts', (select count(*) from carddav_contacts where org_id = tenant_id and owner_actor_id = source_id),
    'addressBooks', (select count(*) from carddav_addressbooks where org_id = tenant_id and owner_actor_id = source_id),
    'assistantConversations', (select count(*) from assistant_conversations where org_id = tenant_id and actor_id = source_id),
    'assistantMemories', (select count(*) from memory_items where org_id = tenant_id and actor_id = source_id)
  ) into counts;
  if successor_id is null and not archive_without_successor and exists (
    select 1 from jsonb_each_text(counts) entry where entry.value::bigint > 0
  ) then blockers := array_append(blockers, 'Choose a successor to receive this account''s data.'); end if;
  select coalesce(jsonb_agg(address order by address), '[]'::jsonb) into addresses from (
    select lower(source_record.email) address where source_record.email is not null
    union select lower(alias.email) from mail_aliases alias where alias.org_id = tenant_id
      and alias.actor_id = source_id and alias.enabled and alias.disabled_at is null
    union select split_part(lower(source_record.email), '@', 1) || '@' || domain.domain
      from admin_domains domain join admin_domains target on target.id = domain.alias_target_domain_id and target.org_id = domain.org_id
      where domain.org_id = tenant_id and domain.identity_mode = 'alias' and domain.status = 'verified'
        and domain.mail_enabled and domain.identity_enabled and target.domain = split_part(lower(source_record.email), '@', 2)
  ) address_records;
  if exists (select 1 from mail_outbound_messages where org_id = tenant_id and actor_id = source_id and status = 'sending') then
    blockers := array_append(blockers, 'Mail delivery is in progress. Wait for it to settle before offboarding.');
  end if;
  if keep_addresses then
    if successor_id is null then blockers := array_append(blockers, 'Choose a successor to keep receiving mail.'); end if;
    if exists (select 1 from jsonb_array_elements_text(addresses) address where not exists (
      select 1 from admin_domains domain where domain.org_id = tenant_id
        and domain.domain = split_part(address, '@', 2) and domain.status = 'verified'
        and domain.verified_at is not null and domain.mail_enabled and domain.aliases_enabled
    )) then blockers := array_append(blockers, 'Every receiving address requires a verified domain with Mail and aliases enabled.'); end if;
  end if;
  preview := jsonb_build_object(
    'source', jsonb_build_object('id', source_record.id, 'type', source_record.type, 'displayName', source_record.display_name,
      'email', source_record.email, 'updatedAt', source_record.updated_at, 'disabledAt', source_record.disabled_at),
    'successor', case when successor_record.id is null then 'null'::jsonb else jsonb_build_object(
      'id', successor_record.id, 'type', successor_record.type, 'displayName', successor_record.display_name,
      'email', successor_record.email, 'updatedAt', successor_record.updated_at) end,
    'counts', counts, 'receivingAddresses', addresses, 'preserveReceivingAddresses', keep_addresses,
    'blockers', to_jsonb(blockers)
  );
  return preview || jsonb_build_object('confirmationToken', md5(preview::text));
end;
$$;
alter function helix_actor_offboard_preview(uuid, uuid, uuid, boolean, boolean) owner to helix_migration_owner;
revoke all on function helix_actor_offboard_preview(uuid, uuid, uuid, boolean, boolean) from public;
grant execute on function helix_actor_offboard_preview(uuid, uuid, uuid, boolean, boolean) to helix_app;

create function helix_offboard_actor(
  tenant_id uuid, source_id uuid, successor_id uuid, keep_addresses boolean,
  expected_token text, archive_without_successor boolean default false
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public set row_security = off as $$
declare
  preview jsonb;
  source_email text;
  actor_was_disabled boolean;
  app_password_count integer;
  credential_count integer;
  alias_record record;
  label_record record;
  moved_slug text;
  receiving_address text;
  job_id uuid := gen_random_uuid();
  result jsonb;
begin
  if tenant_id is distinct from public.helix_current_org_id() then
    raise insufficient_privilege using message = 'Account offboarding tenant context mismatch.';
  end if;
  -- ponytail: serialize rare account handoffs per tenant; split locks if bulk provisioning needs it.
  perform pg_advisory_xact_lock(hashtextextended('actor-offboarding:' || tenant_id::text, 0));
  perform 1 from actors where org_id = tenant_id and id in (source_id, successor_id) order by id for update;
  perform 1 from mail_outbound_messages where org_id = tenant_id and actor_id = source_id
    and status in ('queued', 'sending') order by id for update;
  preview := public.helix_actor_offboard_preview(tenant_id, source_id, successor_id, keep_addresses, archive_without_successor);
  if preview is null then return null; end if;
  if jsonb_array_length(preview->'blockers') > 0 then
    raise check_violation using message = preview->'blockers'->>0;
  end if;
  if not archive_without_successor and expected_token is distinct from preview->>'confirmationToken' then
    raise serialization_failure using message = 'Account data or eligibility changed. Review the handoff again.';
  end if;
  select email, disabled_at is not null into source_email, actor_was_disabled from actors
    where org_id = tenant_id and id = source_id;
  -- Retain the tenant actor and global identity as historical attribution records.
  update actors set disabled_at = coalesce(disabled_at, now()), updated_at = now(),
    metadata = metadata || jsonb_build_object('offboarding', jsonb_build_object(
      'successorActorId', successor_id, 'performedByActorId', public.helix_current_actor_id(),
      'at', now(), 'preserveReceivingAddresses', keep_addresses))
    where org_id = tenant_id and id = source_id;
  update organization_memberships set status = 'deprovisioned', suspended_at = null,
    ended_at = coalesce(ended_at, now()), updated_at = now() where org_id = tenant_id and actor_id = source_id;

  if successor_id is not null then
    update objects set owner_actor_id = successor_id, updated_at = now()
      where org_id = tenant_id and owner_actor_id = source_id and kind <> 'mail_source';
    update drive_folders set owner_actor_id = successor_id, updated_at = now()
      where org_id = tenant_id and owner_actor_id = source_id;
    insert into cal_calendar_memberships(org_id, calendar_id, actor_id, role, visible, sort_order)
      select org_id, id, successor_id, 'owner', true, 0 from cal_calendars
      where org_id = tenant_id and owner_actor_id = source_id
      on conflict (actor_id, calendar_id) do update set role = 'owner', updated_at = now();
    update cal_calendars set owner_actor_id = successor_id, updated_at = now()
      where org_id = tenant_id and owner_actor_id = source_id;
    update carddav_addressbooks set owner_actor_id = successor_id, is_default = false, updated_at = now()
      where org_id = tenant_id and owner_actor_id = source_id;
    update carddav_contacts set owner_actor_id = successor_id, updated_at = now()
      where org_id = tenant_id and owner_actor_id = source_id;
    update assistant_conversations set actor_id = successor_id, updated_at = now(),
      metadata = metadata || jsonb_build_object('handoffSourceActorId', source_id)
      where org_id = tenant_id and actor_id = source_id;
    update memory_items set actor_id = successor_id,
      metadata = metadata || jsonb_build_object('handoffSourceActorId', source_id)
      where org_id = tenant_id and actor_id = source_id;
    update vector_items set owner_actor_id = successor_id, updated_at = now()
      where org_id = tenant_id and owner_actor_id = source_id;

    -- Each transferred mailbox keeps its Inbox/Sent provenance without changing the sender.
    insert into mail_message_deliveries(org_id, message_id, actor_id, delivered_at, received_at, sent_at)
      select message.org_id, message.id, successor_id, coalesce(delivery.delivered_at, message.sent_at),
        case when message.actor_id = source_id and message.metadata->>'direction' = 'outbound'
          then delivery.received_at else coalesce(delivery.received_at, message.sent_at) end,
        case when message.actor_id = source_id and message.metadata->>'direction' = 'outbound'
          then message.sent_at else delivery.sent_at end
      from messages message left join mail_message_deliveries delivery
        on delivery.org_id = message.org_id and delivery.message_id = message.id and delivery.actor_id = source_id
      where message.org_id = tenant_id and message.kind = 'mail'
        and (message.actor_id = source_id or delivery.actor_id is not null)
      on conflict (message_id, actor_id) do update set
        received_at = coalesce(mail_message_deliveries.received_at, excluded.received_at),
        sent_at = coalesce(mail_message_deliveries.sent_at, excluded.sent_at);
    for label_record in select * from mail_labels where org_id = tenant_id and owner_actor_id = source_id loop
      moved_slug := label_record.slug;
      if exists (select 1 from mail_labels where org_id = tenant_id and owner_actor_id = successor_id
        and lower(slug) = lower(label_record.slug) and deleted_at is null) then
        moved_slug := 'handoff-' || label_record.id::text;
        update mail_thread_state set labels = array_replace(labels, label_record.slug, moved_slug)
          where org_id = tenant_id and actor_id = source_id;
      end if;
      update mail_labels set owner_actor_id = successor_id, slug = moved_slug, updated_at = now() where id = label_record.id;
    end loop;
    insert into mail_thread_state(org_id, actor_id, thread_id, labels, archived_at, deleted_at,
      snoozed_until, read_at, starred, spam_at, trash_purge_after, updated_at)
      select tenant_id, successor_id, mail_thread.id, coalesce(state.labels, '{}'), state.archived_at,
        state.deleted_at, state.snoozed_until, state.read_at, coalesce(state.starred, false), state.spam_at,
        state.trash_purge_after, now()
      from threads mail_thread left join mail_thread_state state
        on state.org_id = tenant_id and state.thread_id = mail_thread.id and state.actor_id = source_id
      where mail_thread.org_id = tenant_id and mail_thread.kind = 'mail' and exists (
        select 1 from messages message join mail_message_deliveries delivery
          on delivery.org_id = message.org_id and delivery.message_id = message.id and delivery.actor_id = successor_id
        where message.org_id = tenant_id and message.thread_id = mail_thread.id
          and (message.actor_id = source_id or exists (select 1 from mail_message_deliveries original
            where original.org_id = tenant_id and original.message_id = message.id and original.actor_id = source_id))
      ) on conflict (actor_id, thread_id) do update set
        labels = array(select distinct unnest(mail_thread_state.labels || excluded.labels)),
        starred = mail_thread_state.starred or excluded.starred, updated_at = now();
    update mail_drafts set actor_id = successor_id, idempotency_key = gen_random_uuid(),
      envelope = envelope - 'from', revision = revision + 1, updated_at = now()
      where org_id = tenant_id and actor_id = source_id;
  end if;

  -- Retire old sending authority. Explicitly retained addresses only receive.
  update mail_aliases set enabled = false, disabled_at = coalesce(disabled_at, now()),
    send_as_enabled = false, updated_at = now() where org_id = tenant_id and actor_id = source_id;
  if keep_addresses then
    for receiving_address in select address from jsonb_array_elements_text(preview->'receivingAddresses') address
      order by (address = lower(source_email)) desc, address loop
      if exists (select 1 from mail_aliases existing where existing.org_id = tenant_id and existing.actor_id = successor_id
        and existing.enabled and existing.disabled_at is null and existing.receive_domain_aliases
        and coalesce(public.helix_canonical_login_email(tenant_id, existing.email), lower(existing.email))
          = coalesce(public.helix_canonical_login_email(tenant_id, receiving_address), receiving_address)) then continue; end if;
      select * into alias_record from mail_aliases where org_id = tenant_id and actor_id = source_id
        and lower(email) = receiving_address order by created_at limit 1;
      if found then
        update mail_aliases set actor_id = successor_id, enabled = true, disabled_at = null,
          receive_enabled = true, send_as_enabled = false, is_primary = false,
          receive_domain_aliases = receiving_address = lower(source_email), updated_at = now()
          where id = alias_record.id;
      elsif receiving_address <> lower(coalesce((select email from actors where id = successor_id), '')) then
        insert into mail_aliases(org_id, actor_id, email, enabled, receive_enabled, send_as_enabled, is_primary, receive_domain_aliases)
          values (tenant_id, successor_id, receiving_address, true, true, false, false, receiving_address = lower(source_email));
      end if;
    end loop;
  end if;
  update mail_filters set enabled = false, updated_at = now() where org_id = tenant_id and actor_id = source_id;
  update mail_vacation set enabled = false, updated_at = now() where org_id = tenant_id and actor_id = source_id;
  update mail_outbound_messages set status = 'cancelled', cancelled_at = now(),
    last_error = 'Account offboarded before delivery', lease_owner = null, lease_token = null, lease_expires_at = null,
    updated_at = now() where org_id = tenant_id and actor_id = source_id and status = 'queued';
  delete from admin_group_members where org_id = tenant_id and actor_id = source_id;
  delete from permissions where org_id = tenant_id and actor_id = source_id;
  delete from cal_calendar_memberships where org_id = tenant_id and actor_id = source_id;
  delete from chat_websocket_tickets where org_id = tenant_id and actor_id = source_id;
  update pending_actions set status = 'cancelled', decided_at = now(), error = 'Actor offboarded'
    where org_id = tenant_id and actor_id = source_id and status = 'pending_confirmation';
  update app_passwords set revoked_at = now() where actor_id = source_id and revoked_at is null;
  get diagnostics app_password_count = row_count;
  update agent_credentials set revoked_at = now(), revocation_epoch = revocation_epoch + 1
    where org_id = tenant_id and actor_id = source_id and revoked_at is null;
  get diagnostics credential_count = row_count;
  update oauth_access_tokens set revoked_at = coalesce(revoked_at, now()) where org_id = tenant_id and actor_id = source_id;
  update oauth_refresh_tokens set revoked_at = coalesce(revoked_at, now()) where org_id = tenant_id and actor_id = source_id;
  update oauth_grants set revoked_at = coalesce(revoked_at, now()), updated_at = now() where org_id = tenant_id and actor_id = source_id;
  delete from oauth_authorization_codes where org_id = tenant_id and actor_id = source_id;
  delete from oauth_consent_nonces where org_id = tenant_id and actor_id = source_id;
  -- Index projections are derived. Canonical ACL checks deny stale results immediately.
  insert into search_reindex_jobs(id, org_id, requested_by_actor_id, types, batch_size,
    shadow_index_uid, start_mutation_id, replay_mutation_id, next_attempt_at)
    values (job_id, tenant_id, coalesce(public.helix_current_actor_id(), source_id),
      array['mail','chat','drive','calendar'], 100, 'helix_search_shadow_' || replace(job_id::text, '-', ''),
      coalesce((select last_mutation_id from search_index_checkpoints where consumer = 'live'), 0),
      coalesce((select last_mutation_id from search_index_checkpoints where consumer = 'live'), 0), now());
  result := jsonb_build_object('actorId', source_id, 'orgId', tenant_id, 'disabled', not actor_was_disabled,
    'sessionsRevoked', 0, 'appPasswordsRevoked', app_password_count, 'agentCredentialsRevoked', credential_count,
    'successorActorId', successor_id, 'counts', preview->'counts', 'preserveReceivingAddresses', keep_addresses,
    'searchReindexJobId', job_id);
  insert into activity(org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash)
    values (tenant_id, public.helix_current_actor_id(), 'identity.actor.offboarded', 'actor', source_id, result, null, '');
  insert into outbox(subject, payload) values ('activity.identity.actor.offboarded', result);
  return result;
end;
$$;
alter function helix_offboard_actor(uuid, uuid, uuid, boolean, text, boolean) owner to helix_migration_owner;
revoke all on function helix_offboard_actor(uuid, uuid, uuid, boolean, text, boolean) from public;
grant execute on function helix_offboard_actor(uuid, uuid, uuid, boolean, text, boolean) to helix_app;

create or replace function helix_resolve_non_group_inbound_mailboxes(
  requested_address text, requested_domain text, max_recipient_count integer default 100
)
returns table (org_id uuid, actor_id uuid, address text, quota_exceeded boolean)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if exists (
    select 1 from public.admin_domains domain
    left join public.admin_domains target on target.org_id = domain.org_id
      and target.id = domain.alias_target_domain_id
    join public.admin_groups group_record on group_record.org_id = domain.org_id
    join public.admin_domains group_domain on group_domain.org_id = group_record.org_id
      and group_domain.domain = split_part(lower(group_record.email), '@', 2)
    left join public.admin_domains group_target on group_target.org_id = group_domain.org_id
      and group_target.id = group_domain.alias_target_domain_id
    where domain.domain = lower(btrim(requested_domain)) and domain.status <> 'released'
      and domain.domain = split_part(lower(btrim(requested_address)), '@', 2)
      and group_record.kind = 'mailing_list'
      and split_part(lower(group_record.email), '@', 1) = split_part(lower(btrim(requested_address)), '@', 1)
      and case group_domain.identity_mode when 'alias' then group_target.domain else group_domain.domain end
        = case domain.identity_mode when 'alias' then target.domain else domain.domain end
  ) then
    raise insufficient_privilege using message = 'mail_group_unavailable';
  end if;
  return query select alias.org_id, alias.actor_id, lower(alias.email),
    coalesce(public.helix_authoritative_storage_usage_bytes(alias.org_id) >= public.helix_storage_limit_bytes(alias.org_id), false)
    from public.admin_domains domain join public.mail_aliases alias on alias.org_id = domain.org_id
    where domain.domain = lower(btrim(requested_domain)) and domain.status = 'verified'
      and domain.domain = split_part(lower(btrim(requested_address)), '@', 2)
      and domain.verified_at is not null and domain.mail_enabled and domain.aliases_enabled
      and alias.enabled and alias.disabled_at is null and alias.receive_enabled
      and public.helix_mailbox_principal_is_active(alias.org_id, alias.actor_id)
      and (lower(alias.email) = lower(btrim(requested_address)) or (alias.receive_domain_aliases
        and coalesce(public.helix_canonical_login_email(alias.org_id, alias.email), lower(alias.email))
          = coalesce(public.helix_canonical_login_email(alias.org_id, requested_address), lower(btrim(requested_address)))))
    limit max_recipient_count;
  if found then return; end if;
  if exists (
    select 1 from public.admin_domains domain join public.actors retired on retired.org_id = domain.org_id
    where domain.domain = lower(btrim(requested_domain)) and domain.status <> 'released'
      and retired.disabled_at is not null and retired.metadata ? 'offboarding'
      and (coalesce(public.helix_canonical_login_email(retired.org_id, retired.email), lower(retired.email))
        = coalesce(public.helix_canonical_login_email(retired.org_id, requested_address), lower(btrim(requested_address)))
        or exists (select 1 from public.mail_aliases alias where alias.org_id = retired.org_id
          and alias.actor_id = retired.id and (lower(alias.email) = lower(btrim(requested_address))
            or (alias.receive_domain_aliases and coalesce(public.helix_canonical_login_email(alias.org_id, alias.email), lower(alias.email))
              = coalesce(public.helix_canonical_login_email(alias.org_id, requested_address), lower(btrim(requested_address)))))))
      and not exists (select 1 from public.actors active where active.org_id = domain.org_id
        and public.helix_mailbox_principal_is_active(active.org_id, active.id)
        and coalesce(public.helix_canonical_login_email(active.org_id, active.email), lower(active.email))
          = coalesce(public.helix_canonical_login_email(active.org_id, requested_address), lower(btrim(requested_address))))
  ) then raise insufficient_privilege using message = 'mail_account_offboarded'; end if;
  return query select * from public.helix_resolve_legacy_inbound_mailboxes(
    requested_address, requested_domain, max_recipient_count
  );
end;
$$;
