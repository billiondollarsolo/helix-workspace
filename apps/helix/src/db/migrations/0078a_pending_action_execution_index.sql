-- PostgreSQL requires enum values added by 0078 to be committed before they
-- can be referenced by an index predicate. Keep this as a separate migration
-- so each migration remains atomic while preserving the selective worker index.

create index if not exists pending_actions_execution_recovery_idx
  on pending_actions (status, execution_lease_expires_at)
  where status = 'executing';
