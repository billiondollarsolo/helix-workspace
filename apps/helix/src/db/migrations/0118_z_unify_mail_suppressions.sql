-- Keep legacy event references and removal evidence for migration and audit.
do $$
declare index_row record;
begin
  if exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mail_suppressions' and column_name = 'normalized_recipient') then
    alter table mail_suppressions rename to mail_suppressions_legacy;
    for index_row in select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'mail_suppressions_legacy'
    loop
      execute format('alter index public.%I rename to %I', index_row.indexname,
        left(index_row.indexname, 49) || '_legacy');
    end loop;
  end if;
end;
$$;
do $$
begin
  if to_regclass('public.mail_suppressions_v1') is not null then
    alter table mail_suppressions_v1 rename to mail_suppressions;
  end if;
end;
$$;
