# Mail body storage and migration

Full immutable mail text and HTML live in the tenant's existing encrypted object
storage as gzip-compressed, versioned JSON. PostgreSQL keeps `mail_message_bodies`
references with compressed SHA-256, compressed size and uncompressed size. These
references are private mail records, separate from Drive objects and file sharing.
Mailbox authorization and tenant RLS run before the body is fetched and verified.

PostgreSQL also keeps addresses, threading, dates, delivery state, flags, labels
and previews capped at 240 characters. Inbox listing does not fetch body objects.
Active drafts remain transactional database records. Original RFC822 sources and
attachments continue using their existing storage and scanning paths.

New delivery queues and durable search mutations contain references instead of
full bodies. Optional semantic indexing embeds the text but keeps only source
identity and passage offsets in vector metadata for externally stored mail. Search
reloads authorized source text before returning passages. Embeddings still consume
space in the configured vector backend; pgvector therefore still contributes to
PostgreSQL growth. Qdrant remains an available separate backend.

## Upgrade and backfill

1. Take and verify a consistent database **and object-store** backup, including
   encryption keys. Keep the previous image and deployment configuration.
2. Apply migrations `0231_mail_body_storage.sql` and `0232_mail_body_lifecycle.sql`
   through the migration runner. These add storage references and lifecycle
   functions; they do not remove existing bodies.
3. Deploy the new reader/writer together with the existing object-store and
   Meilisearch configuration. Verify new inbound/outbound writes and reads, then
   build or repair the mail search index before clearing inline bodies.
4. Using the migration credential and the same storage configuration and tenant
   secret backend as the API, run one tenant at a time:

   ```sh
   pnpm --filter @helix/app db:backfill:mail-bodies -- --org-id <tenant-uuid>
   ```

   In the runtime image use `node /app/dist/db/backfill-mail-bodies.js --org-id
<tenant-uuid>`. Supply credentials through the deployment's secret files; never
   put passwords in shell history. The operator connection must be allowed to
   assume `helix_migration_owner`.

5. Compare pre/post content fingerprints, mailbox counts, representative thread
   reads, scheduled-send reads, AI source reads and body-only search. Re-run the
   command: already migrated messages are skipped. A failure leaves unconverted
   content inline; verified objects are linked and inline copies removed in one
   transaction. It is safe to resume after fixing the reported failure.
   Each converted message queues an index refresh in that same transaction for
   its authorized mailboxes. This also rebuilds AI passage offsets when canonical
   plain text replaces indexed HTML. Let the durable search queue drain before
   treating keyword/AI search validation as complete; failed storage reads retry.
6. Take another backup and verify body objects against the new reference hashes.
   Backup inventories and tenant storage migration inventories include bodies.

The backfill uploads and reads back each object before changing PostgreSQL. It
refuses to discard an outbound body that differs from the canonical message.
Existing journaled or reviewed messages, and tenants with active legal holds, are
conservatively left inline. Historical journal, audit, approval and exported
snapshots are not rewritten to save space. Investigate retained counts through
the normal governance process; do not bypass preservation rules.

The command also compacts historical mail search mutations and removes redundant
passage text from pgvector metadata for migrated messages. It does not delete
embeddings or AI summaries. Normal PostgreSQL vacuum makes old row space reusable;
this does not guarantee that database files immediately become smaller. Do not
run blocking `VACUUM FULL` on the live service merely to shrink files.

## Failure handling and rollback

An upload cleanup intent commits before the upload. Linking the body consumes the
intent atomically with the message transaction. Failed or abandoned uploads are
retried by the existing object cleanup worker; completed message bodies are
retained. Message retention and legal-hold checks run before cascading removal of
the reference queues the object for deletion.

Missing, truncated, mismatched or malformed bodies produce an actionable error;
Helix does not silently return an empty email. Compressed and expanded payloads
are bounded at 50 MiB. Sender retries reuse canonical messages, and delivery
acknowledgements reuse the already-loaded body so an object-store outage after
SMTP acceptance cannot turn a successful handoff into a storage-read failure.

After the first external-body write, an old image that reads only `messages.body`
is **not a valid rollback**. Keep a compatible reader or restore the matched
pre-upgrade database/object backup into an isolated deployment, validate it, then
switch traffic. A restore loses writes after that backup unless separately
reconciled. Do not delete new objects or undo only the schema migration.

## Search and capacity limits

Full-body mailbox search uses Meilisearch's token/phrase matching, rather than
PostgreSQL substring matching. Address, subject, date, folder and state operators
remain SQL filters. Search candidates are scoped by tenant and mailbox owner,
then SQL checks current visibility again. Indexing is asynchronous, so a newly
received message can appear in the inbox before body search finds it.

Each free-text term or phrase has a 10,000-candidate limit. A broader match returns
an explicit request to narrow the word or phrase; results are not silently
truncated. Metadata-only operators and inbox browsing work without body searches.
A missing or unavailable search service makes full-body search fail explicitly.
Compliance searches use authorized object content directly and can scan many
messages; they do not borrow the administrator's personal mailbox search scope.

Track PostgreSQL metadata/index size, retained evidence, draft and AI artifact
size, vector size, object-store bytes, cleanup backlog and backup capacity
separately. This split reduces body-driven PostgreSQL growth; it does not eliminate
metadata growth or object storage capacity needs. On the development host,
PostgreSQL and the object store still share the same physical server.

## Development deployment evidence

The 2026-10-15 deployment uses API image `mail-storage-r15`. All 24 original
message bodies were migrated and verified against their pre-migration hashes.
PostgreSQL contains no inline message or delivery-queue body bytes in this tenant.
A private Atlas fixture brings the verified object count to 25. Public MCP and CLI
reads/search, human mailbox reads and an isolated database/body-object recovery
passed. See the [validation evidence](../reviews/evidence/2026-10-15-mail-body-storage-validation.json)
for check counts, backup scope and remaining development limits.

The follow-up image `mail-storage-r16` makes search refresh part of each backfill
transaction. All 25 existing mailbox projections were refreshed successfully, and
MCP/CLI plus 11 human-mailbox reads passed again. See the
[index recovery evidence](../reviews/evidence/2026-10-15-mail-index-recovery-validation.json).
