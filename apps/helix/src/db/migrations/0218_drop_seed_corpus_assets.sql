-- The corpus importer that kept this idempotency registry is gone; the demo
-- seed (src/db/demo-seed) writes through the product stores and records its
-- state on the org instead. Nothing reads or writes this table any more.
drop table if exists seed_corpus_assets;
