-- Orphan-proof folder hierarchy: FK parent_folder_id → drive_folders(id).
update drive_folders f
set parent_folder_id = null
where parent_folder_id is not null
  and not exists (select 1 from drive_folders p where p.id = f.parent_folder_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'drive_folders_parent_fk'
  ) then
    alter table drive_folders
      add constraint drive_folders_parent_fk
      foreign key (parent_folder_id) references drive_folders(id) on delete set null;
  end if;
end $$;
