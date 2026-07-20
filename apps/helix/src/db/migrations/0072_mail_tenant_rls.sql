-- Defense-in-depth RLS for mail_* tables (extends 0033_tenant_rls_foundation).
-- The foundation already enabled RLS for tables with org_id at migration time;
-- this re-applies policies for mail tables that may have been created later.

create or replace function helix_current_org_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('helix.org_id', true), '')::uuid
$$;

do $$
declare
  tenant_table text;
begin
  foreach tenant_table in array array[
    'mail_filters',
    'mail_aliases',
    'mail_vacation',
    'mail_vacation_responses',
    'mail_thread_state',
    'mail_outbound_messages',
    'mail_outbound_providers',
    'mail_sending_domains',
    'mail_dkim_keys',
    'mail_dmarc_reports',
    'mail_inbound_routing_rules',
    'mail_drafts'
  ]
  loop
    if to_regclass(format('public.%I', tenant_table)) is null then
      continue;
    end if;
    execute format('alter table %I enable row level security', tenant_table);
    execute format('drop policy if exists helix_tenant_isolation on %I', tenant_table);
    execute format(
      'create policy helix_tenant_isolation on %I using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id())',
      tenant_table
    );
  end loop;
end
$$;
