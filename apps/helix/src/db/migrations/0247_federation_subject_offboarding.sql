-- A global suspension must invalidate old app assignments even when reactivation
-- happens before any tenant worker observes it. No cross-tenant trigger writes.
alter table identity_subjects add column federation_generation bigint not null default 0;
alter table federation_app_assignments add column identity_generation bigint not null default 0;
create function helix_federation_subject_generation() returns trigger language plpgsql
set search_path=pg_catalog,public as $$
begin
  if old.status='active' and new.status<>'active' then
    new.federation_generation=old.federation_generation+1;
  end if;
  return new;
end $$;
create trigger federation_subject_offboarded before update of status on identity_subjects
  for each row execute function helix_federation_subject_generation();
