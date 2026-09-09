-- Archive the old queue intact; the v1 worker uses the durable finalization queue.
do $$
declare index_row record;
begin
  if exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'drive_scan_jobs' and column_name = 'requested_by_actor_id') then
    alter table drive_scan_jobs rename to drive_scan_jobs_legacy;
    for index_row in select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'drive_scan_jobs_legacy'
    loop
      execute format('alter index public.%I rename to %I', index_row.indexname,
        left(index_row.indexname, 49) || '_legacy');
    end loop;
  end if;
end;
$$;
do $$
begin
  if to_regclass('public.drive_scan_jobs_v1') is not null then
    alter table drive_scan_jobs_v1 rename to drive_scan_jobs;
  end if;
end;
$$;
