create or replace function orgs_tenant_config_audit()
returns trigger
language plpgsql
as $$
declare
  changed_by_setting text := nullif(current_setting('helix.tenant_config_changed_by', true), '');
  reason_setting text := nullif(current_setting('helix.tenant_config_reason', true), '');
  changed_by_value uuid := null;
  audit_reason text := coalesce(
    reason_setting,
    case when TG_OP = 'INSERT' then 'org.create' else 'tenant-config:update' end
  );
begin
  if changed_by_setting ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    changed_by_value := changed_by_setting::uuid;
  end if;

  if TG_OP = 'INSERT' then
    insert into tenant_config_audit (org_id, key, old_value, new_value, changed_by, changed_at, reason)
    values
      (
        NEW.id,
        'byo_config',
        null,
        NEW.byo_config,
        changed_by_value,
        clock_timestamp(),
        audit_reason
      ),
      (
        NEW.id,
        'feature_flags',
        null,
        NEW.feature_flags,
        changed_by_value,
        clock_timestamp(),
        audit_reason
      ),
      (NEW.id, 'quotas', null, NEW.quotas, changed_by_value, clock_timestamp(), audit_reason),
      (NEW.id, 'branding', null, NEW.branding, changed_by_value, clock_timestamp(), audit_reason);
    return NEW;
  end if;

  if NEW.byo_config is distinct from OLD.byo_config then
    insert into tenant_config_audit (org_id, key, old_value, new_value, changed_by, changed_at, reason)
    values (NEW.id, 'byo_config', OLD.byo_config, NEW.byo_config, changed_by_value, clock_timestamp(), audit_reason);
  end if;

  if NEW.feature_flags is distinct from OLD.feature_flags then
    insert into tenant_config_audit (org_id, key, old_value, new_value, changed_by, changed_at, reason)
    values (NEW.id, 'feature_flags', OLD.feature_flags, NEW.feature_flags, changed_by_value, clock_timestamp(), audit_reason);
  end if;

  if NEW.quotas is distinct from OLD.quotas then
    insert into tenant_config_audit (org_id, key, old_value, new_value, changed_by, changed_at, reason)
    values (NEW.id, 'quotas', OLD.quotas, NEW.quotas, changed_by_value, clock_timestamp(), audit_reason);
  end if;

  if NEW.branding is distinct from OLD.branding then
    insert into tenant_config_audit (org_id, key, old_value, new_value, changed_by, changed_at, reason)
    values (NEW.id, 'branding', OLD.branding, NEW.branding, changed_by_value, clock_timestamp(), audit_reason);
  end if;

  return NEW;
end;
$$;

drop trigger if exists orgs_tenant_config_audit_insert on orgs;
create trigger orgs_tenant_config_audit_insert
after insert on orgs
for each row
execute function orgs_tenant_config_audit();

drop trigger if exists orgs_tenant_config_audit_update on orgs;
create trigger orgs_tenant_config_audit_update
after update of byo_config, feature_flags, quotas, branding on orgs
for each row
execute function orgs_tenant_config_audit();
