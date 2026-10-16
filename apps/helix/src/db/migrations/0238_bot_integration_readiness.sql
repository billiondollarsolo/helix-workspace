alter table bot_account_requests add column credential_expires_at timestamptz;
update bot_account_requests r set credential_expires_at=c.expires_at
from agent_credentials c where c.org_id=r.org_id and c.id=r.credential_id;

-- The API process hosts supervised workers on its runtime pool. These discovery
-- functions expose IDs only and reject any active tenant/request context.
grant execute on function helix_mail_productivity_work(integer) to helix_app;
grant execute on function helix_meet_transcript_work_orgs(integer) to helix_app;

create or replace function helix_mail_productivity_work(batch_limit integer)
returns table(org_id uuid,actor_id uuid)
language plpgsql security definer set search_path=pg_catalog,public set row_security=off as $$
begin
  if batch_limit not between 1 and 100 then raise exception 'Invalid productivity batch'; end if;
  if nullif(current_setting('helix.org_id',true),'') is not null or nullif(current_setting('helix.actor_id',true),'') is not null then
    raise exception 'Productivity discovery is restricted to the worker';
  end if;
  return query select p.org_id,p.actor_id from mail_productivity_preferences p
    where p.next_run_at<=now() order by p.next_run_at limit batch_limit;
end $$;
