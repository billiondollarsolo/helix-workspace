-- Keep the v1 suppression list intact while importing the legacy provider schema.
do $$
declare index_row record;
begin
  if exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mail_suppressions' and column_name = 'address') then
    alter table mail_suppressions rename to mail_suppressions_v1;
    for index_row in select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'mail_suppressions_v1'
    loop
      execute format('alter index public.%I rename to %I', index_row.indexname,
        left(index_row.indexname, 49) || '_v1');
    end loop;
  end if;
end;
$$;
