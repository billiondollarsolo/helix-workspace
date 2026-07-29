-- Rollback for 0075_mail_receiving_domains.sql.
-- This is intentionally outside the forward migration directory and must be
-- invoked explicitly after confirming inbound SMTP is stopped.

drop trigger if exists mail_receiving_domains_catch_all_same_org
  on mail_receiving_domains;
drop trigger if exists mail_receiving_domains_guard_actor_org_change on actors;
drop function if exists mail_receiving_domains_guard_actor_org_change();
drop function if exists mail_receiving_domains_validate_catch_all();
drop table if exists mail_receiving_domains;
drop type if exists mail_receiving_domain_status;
