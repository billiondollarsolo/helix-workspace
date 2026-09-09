# Search projection lag

Check `helix_search_projection_lag_seconds` and `helix_search_projection_errors_total` by indexer,
then inspect undelivered `activity.*` outbox rows and worker errors. Restore the consumer, replay
undelivered rows, and run the scoped `/api/admin/search/reindex` reconciliation with stale pruning.
