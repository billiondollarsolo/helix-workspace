do $$
begin
  if exists (
    select 1 from drive_share_links
    where token is null and token_hash is not null
  ) then
    raise exception
      'Cannot roll back 0084: raw Drive share tokens were irreversibly removed; revoke/recreate links instead';
  end if;
end $$;

drop index if exists objects_drive_trash_expiry_idx;
drop table if exists drive_lifecycle_policies;
alter table objects
  drop column if exists trash_expires_at,
  drop column if exists drive_legal_hold;
drop index if exists drive_share_links_token_hash_idx;
alter table drive_share_links
  drop constraint if exists drive_share_links_rate_count_check,
  drop constraint if exists drive_share_links_rate_limit_check,
  drop constraint if exists drive_share_links_download_count_check,
  drop constraint if exists drive_share_links_max_downloads_check,
  drop column if exists last_used_at,
  drop column if exists rate_window_count,
  drop column if exists rate_window_started_at,
  drop column if exists rate_limit_per_hour,
  drop column if exists download_count,
  drop column if exists max_downloads,
  drop column if exists password_hash,
  drop column if exists token_hash;
alter table drive_share_links alter column token set not null;
