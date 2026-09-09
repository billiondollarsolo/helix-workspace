do $$
declare
  role_name text;
begin
  foreach role_name in array array['helix_app', 'helix_worker', 'helix_readonly']
  loop
    if not exists (select 1 from pg_roles where rolname = role_name) then
      execute format(
        'create role %I login nosuperuser nobypassrls noinherit nocreatedb nocreaterole noreplication password %L',
        role_name,
        role_name || '_local'
      );
    end if;
  end loop;
end
$$;
