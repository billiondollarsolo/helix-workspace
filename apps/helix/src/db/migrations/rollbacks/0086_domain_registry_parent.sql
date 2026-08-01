-- Roll back 0086_domain_registry_parent.
--
-- Dropping the columns restores the three disconnected registries. The parent
-- rows this migration created in admin_domains are NOT removed: by the time a
-- rollback runs an operator may have attached DNS records to them, and there is
-- no way to tell a backfilled parent from one they registered themselves.
-- Leaving them is the recoverable direction -- an extra row in a list beats
-- deleting a domain someone is using.

drop index if exists mail_sending_domains_org_parent_idx;
drop index if exists mail_receiving_domains_org_parent_idx;
drop index if exists mail_sending_domains_parent_idx;
drop index if exists mail_receiving_domains_parent_idx;

alter table mail_sending_domains drop column if exists admin_domain_id;
alter table mail_receiving_domains drop column if exists admin_domain_id;
