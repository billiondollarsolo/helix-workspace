-- Preserve an already-deployed local queue before the production branch creates its legacy queue.
do $$
declare index_row record;
begin
  if exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'drive_scan_jobs' and column_name = 'attempt_count') then
    alter table drive_scan_jobs rename to drive_scan_jobs_v1;
    for index_row in select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'drive_scan_jobs_v1'
    loop
      execute format('alter index public.%I rename to %I', index_row.indexname,
        left(index_row.indexname, 49) || '_v1');
    end loop;
  end if;
end;
$$;
