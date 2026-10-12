-- Answer the mailbox read predicates from the caller's own mailbox first.
--
-- Every mail row a query touches passes through these RLS predicates before
-- any search or folder filter runs, so their per-call cost bounds mail list
-- and search latency.
--
-- helix_can_read_mail_thread probed the thread's mailbox rows in arbitrary
-- order and ran helix_can_access_mailbox on each until one passed. A thread
-- delivered to a whole team has one mailbox row per member, so a member's own
-- read could evaluate the access predicate for every recipient, and with no
-- (org_id, thread_id) index the probe read every mailbox row in the tenant.
-- helix_can_read_mail_message looked up whether the caller is a service actor
-- before delegating to the thread predicate, which looked it up again.
--
-- The thread predicate now first probes the caller's own mailbox row, then
-- falls back to its unchanged definition, which the new index confines to the
-- thread's own mailbox rows. The index carries actor_id so the own-row probe
-- reads one entry whichever index the planner picks. The message predicate
-- and helix_can_access_mailbox now evaluate their cheapest disjunct first.
-- The own-mailbox probe is a subset of the fallback, and OR is commutative
-- (including over NULL), so every input yields the same result as before:
-- only the evaluation order changes.
--
-- mail_outbound_messages had no index on its (org_id, message_id) foreign key,
-- so the per-message outbound and cancelled-send lookups in mail search and
-- folder views, and message deletes, scanned every outbound row in the tenant.

create index if not exists mail_thread_state_org_thread_actor_idx
  on mail_thread_state (org_id, thread_id, actor_id);

create index if not exists mail_outbound_messages_org_message_idx
  on mail_outbound_messages (org_id, message_id);

create or replace function helix_can_access_mailbox(
  mailbox_org_id uuid,
  mailbox_actor_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    mailbox_org_id = public.helix_current_org_id()
    and exists (
      select 1
      from public.actors mailbox
      where mailbox.org_id = mailbox_org_id
        and mailbox.id = mailbox_actor_id
        and mailbox.disabled_at is null
    )
    and (
      mailbox_actor_id = public.helix_current_actor_id()
      or public.helix_mail_service_context(mailbox_org_id)
      or exists (
        select 1
        from public.permissions permission
        join public.actors delegate
          on delegate.org_id = permission.org_id
         and delegate.id = permission.actor_id
         and delegate.disabled_at is null
        where permission.org_id = mailbox_org_id
          and permission.actor_id = public.helix_current_actor_id()
          and permission.resource_type = 'mailbox'
          and permission.resource_id = mailbox_actor_id
          and permission.role = 'manager'
          and permission.status = 'active'
          and permission.valid_from <= statement_timestamp()
          and (permission.expires_at is null or permission.expires_at > statement_timestamp())
          and permission.revoked_at is null
          and permission.revocation_epoch = 0
      )
    )
$$;

create or replace function helix_can_read_mail_thread(
  mailbox_org_id uuid,
  mailbox_thread_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    exists (
      select 1
      from public.mail_thread_state mailbox
      where mailbox.actor_id = public.helix_current_actor_id()
        and mailbox.thread_id = mailbox_thread_id
        and mailbox.org_id = mailbox_org_id
        and public.helix_can_access_mailbox(mailbox.org_id, mailbox.actor_id)
    )
    or public.helix_mail_service_context(mailbox_org_id)
    or exists (
      select 1
      from public.mail_thread_state mailbox
      where mailbox.org_id = mailbox_org_id
        and mailbox.thread_id = mailbox_thread_id
        and public.helix_can_access_mailbox(mailbox.org_id, mailbox.actor_id)
    )
$$;

create or replace function helix_can_read_mail_message(
  mailbox_org_id uuid,
  mailbox_message_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    exists (
      select 1
      from public.messages message
      where message.org_id = mailbox_org_id
        and message.id = mailbox_message_id
        and message.kind = 'mail'
        and public.helix_can_read_mail_thread(message.org_id, message.thread_id)
    )
    or public.helix_mail_service_context(mailbox_org_id)
$$;

do $$
declare
  routine regprocedure;
begin
  foreach routine in array array[
    'helix_can_access_mailbox(uuid,uuid)'::regprocedure,
    'helix_can_read_mail_thread(uuid,uuid)'::regprocedure,
    'helix_can_read_mail_message(uuid,uuid)'::regprocedure
  ]
  loop
    execute format('alter function %s owner to helix_migration_owner', routine);
    execute format('revoke all on function %s from public', routine);
    execute format(
      'grant execute on function %s to helix_app, helix_worker, helix_readonly',
      routine
    );
  end loop;
end
$$;
