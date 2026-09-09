alter table mail_drafts
  add column revision bigint not null default 1,
  add column idempotency_key uuid not null default gen_random_uuid(),
  add column attachment_object_ids uuid[] not null default '{}',
  add column expires_at timestamptz not null default (now() + interval '30 days'),
  add constraint mail_drafts_revision_check check (revision > 0);

create unique index mail_drafts_idempotency_idx
  on mail_drafts (org_id, actor_id, idempotency_key);
create index mail_drafts_expiry_idx on mail_drafts (expires_at, id);

create function helix_expire_mail_drafts(batch_limit integer, due_before timestamptz)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  deleted_count integer;
begin
  if batch_limit not between 1 and 500 then
    raise exception 'invalid mail draft cleanup batch size';
  end if;
  if nullif(current_setting('helix.org_id', true), '') is not null
    or nullif(current_setting('helix.actor_id', true), '') is not null
  then
    raise insufficient_privilege using
      message = 'mail draft cleanup requires an unscoped worker context';
  end if;

  with due as (
    select id from public.mail_drafts
    where expires_at <= due_before
    order by expires_at, id
    limit batch_limit for update skip locked
  )
  delete from public.mail_drafts draft using due where draft.id = due.id;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end
$$;

revoke all on function helix_expire_mail_drafts(integer, timestamptz)
  from public, helix_readonly;
grant execute on function helix_expire_mail_drafts(integer, timestamptz)
  to helix_app, helix_worker;
