create table mail_user_settings (
  org_id uuid not null,
  actor_id uuid not null,
  signature_text text not null default '',
  signature_html text,
  include_signature_on_replies boolean not null default true,
  blocked_senders text[] not null default '{}',
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (org_id, actor_id),
  foreign key (org_id, actor_id) references actors(org_id, id) on delete cascade,
  check (octet_length(signature_text) <= 40000),
  check (signature_html is null or octet_length(signature_html) <= 100000),
  check (cardinality(blocked_senders) <= 1000),
  check (array_position(blocked_senders, '') is null)
);

alter table mail_user_settings enable row level security;
alter table mail_user_settings force row level security;
create policy helix_mail_user_settings_isolation on mail_user_settings
  using (org_id = helix_current_org_id() and actor_id = helix_current_actor_id())
  with check (org_id = helix_current_org_id() and actor_id = helix_current_actor_id());

alter table mail_user_settings owner to helix_migration_owner;
revoke all on mail_user_settings from public, helix_app, helix_worker, helix_readonly;
grant select, insert, update, delete on mail_user_settings to helix_app;
grant select on mail_user_settings to helix_readonly;
