alter table federation_applications
  drop column private_target_error,
  drop column private_target_checked_at,
  drop column private_target_source,
  drop column private_target;
