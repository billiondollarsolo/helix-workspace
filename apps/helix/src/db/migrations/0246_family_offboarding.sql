-- Readmission needs a new application assignment, even if no directory delivery
-- happened between suspension and reactivation.
create function helix_family_remove_assignments() returns trigger language plpgsql
set search_path=pg_catalog,public as $$
begin
  if tg_table_name='organization_memberships' then
    if tg_op='DELETE' then
      delete from family_app_assignments where org_id=old.org_id and actor_id=old.actor_id;
    elsif new.status<>'active' then
      delete from family_app_assignments where org_id=new.org_id and actor_id=new.actor_id;
    end if;
  elsif new.disabled_at is not null then
    delete from family_app_assignments where org_id=new.org_id and actor_id=new.id;
  end if;
  return null;
end $$;
create trigger family_membership_offboarded after update of status or delete on organization_memberships
  for each row execute function helix_family_remove_assignments();
create trigger family_actor_offboarded after update of disabled_at on actors
  for each row execute function helix_family_remove_assignments();
