-- Private link to a federated app: Workspace connects to this host:port while still
-- verifying the app's public hostname over TLS. Discovered automatically or set by an admin.
alter table federation_applications
  add column private_target text check (private_target is null or private_target ~ '^[A-Za-z0-9.-]{1,253}:[0-9]{1,5}$'),
  add column private_target_source text check (private_target_source is null or private_target_source in ('discovered', 'manual')),
  add column private_target_checked_at timestamptz,
  add column private_target_error text check (private_target_error is null or length(private_target_error) <= 500);
