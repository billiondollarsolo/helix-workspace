# Drive — Senior Review

## Summary
The Drive subsystem is a solid v1 — multi-tenant object storage with presigned uploads, immutable versioning, WebDAV interop, OnlyOffice integration, PDF form state, comments, and AI auto-tagging are all wired end-to-end. However, several critical gaps remain: no public/anonymous share links, no virus scanning, no MIME sniffing (server trusts the client's `content-type` for every upload), in-process WebDAV locks that don't survive a restart, a long-running quota query that opens a `for update` row lock on `orgs` for every upload, and the entire content path buffers files into memory rather than streaming. Several role/permission strings are inconsistent between layers and "Starred" / "Recent" rely on un-indexed metadata lookups that won't scale.

## Scorecard
- Security: 2.5/5 — Tenant isolation through the storage prefix is correct, but missing virus scan + server-side MIME sniff + dev `inlineBody` codepath in prod-shaped routes + role enum drift across layers make this materially weaker than peers.
- Correctness: 3/5 — Versioning, range responses, ETag/`If-Match`, and quota math are well-tested; but WebDAV locks/parsers, the `app=…` filter, the `acrossFolders` semantics, and orphaned-blob handling on partial finalize have real bugs.
- Feature completeness: 3/5 — Trash/restore, versions, comments, PDF forms, OnlyOffice + WebDAV are present. Missing: rename, copy/duplicate, multi-select bulk ops, real share dialog (just an actor-id textbox), public share links, real-time collaboration signals, mobile uploader, drag-and-drop folder upload, granular permissions UI.
- Code quality: 3/5 — Backend `store.ts` (2 460 LOC) and frontend `drive-shell.tsx` (1 941 LOC) are well past the comfortable split point. The store mixes 6+ unrelated concerns (uploads, comments, PDF forms, search projection, enrichment, audit hashing) in one class. Otherwise types are tight, tests are extensive (~7 000 LOC of tests).

## Findings

### S1: Server trusts client-supplied `mimeType`; no sniffing or allow-list · severity: HIGH · category: security
**File**: `apps/helix/src/platform/drive/store.ts:340-398` and `apps/helix/src/platform/drive/tools.ts:236-263`
**What's wrong**: `prepareUpload` accepts any string ≥1 char as `mimeType` and stores it verbatim on the object row, on the presigned PUT URL, and on the eventual `content-disposition`. The preview route (`server.ts:2669-2687`) inlines anything matching `text/html` or `image/*` straight into the browser with no Content-Security-Policy and no `X-Content-Type-Options: nosniff` — a user can upload `evil.html` declared as `text/plain`, then re-upload another version with `text/html`, and the response is rendered as HTML in-origin. No MIME sniffing against actual bytes is performed at any point.
**Fix**: Add `X-Content-Type-Options: nosniff` to every `/api/drive/objects/*/content` and `/preview` response. For HTML preview, render through a sandboxed iframe (`sandbox="allow-same-origin"` is *not* enough — use `sandbox=""` and serve from a separate cookieless subdomain, or wrap the content in a server-rendered `<iframe srcdoc="">`). Validate `mimeType` against an allow-list and run `file-type`-style magic-byte sniffing on `finalizeUpload`, comparing it to the claimed type.
**Effort**: M

### S2: No virus / malware scanning on upload · severity: HIGH · category: security
**File**: `apps/helix/src/platform/drive/store.ts:401-501`
**What's wrong**: Drive is a multi-tenant file dropbox with WebDAV PUT, browser PUT, and inline `contentBase64` paths. None of them scan content. `grep -r "virus\|clamav\|scan"` across the drive tree returns nothing. Any tenant can host malware and serve it to other tenant users via a `drive.share` grant.
**Fix**: Hook a scanning step into `finalizeUpload` (and the WebDAV PUT handler) that either (a) blocks the finalize until ClamAV / VirusTotal scans pass, or (b) marks the version `metadata.status = "scanning"` until a worker promotes it, and the content endpoint refuses to serve until status flips to `ready`. Same plumbing should support content moderation later.
**Effort**: L

### S3: No public / anonymous share links · severity: HIGH · category: missing
**File**: `apps/helix/src/platform/drive/store.ts:706-737`, `apps/helix/src/platform/drive/tools.ts:337-357`
**What's wrong**: `drive.share` only accepts a list of `actorIds`. There's no concept of a tokenized public/unlisted share link, no expiry on the link itself (only on the per-actor grant), and no password-protect option. Every Drive competitor (Google, Dropbox, OneDrive, Box) ships this as table-stakes.
**Fix**: Add a `drive_share_links` table with `(id, token, object_id, role, expires_at, password_hash, created_by, revoked_at)`, a `drive.share.link.create` tool, and a `/d/:token` public route that validates the token, then proxies the `readFile` path with a synthetic actor (or scoped read grant). Audit every access.
**Effort**: L

### S4: Drive content endpoint buffers entire file into memory · severity: HIGH · category: bug
**File**: `apps/helix/src/server.ts:2576-2627` and `apps/helix/src/platform/drive/store.ts:686-704, 1405-1414`
**What's wrong**: `readFile` calls `readObjectBytes` which calls `toUint8Array` (store.ts:2427-2443), copying the entire blob into a single `Buffer`. `sendBytesWithRangeSupport` (range-response.ts:27-60) then slices the in-memory buffer. A user requesting a single 4 GB video pegs Node's old-space heap and the process OOMs at the default 1.7 GB cap; multiple concurrent downloads compound the problem. Range requests don't save anything because the full body is already in RAM before the slice.
**Fix**: Add a `getStream(key, { range })` to the storage client and wire it through `readFile` so the S3 GET passes the `Range` header directly to RustFS/S3 and pipes the response into the Fastify reply. Keep the buffered path only for the `≤10 MB` legacy seed fallback.
**Effort**: M

### S5: Role enum drift between tools schema and store types · severity: MEDIUM · category: bug
**File**: `apps/helix/src/platform/drive/tools.ts:64` vs `apps/helix/src/platform/drive/types.ts:6`
**What's wrong**: `DriveShareRole = "viewer" | "commenter" | "editor" | "owner"`, but the share tool schema accepts `"reader" | "commenter" | "editor" | "owner"` and defaults to `"reader"`. The permissions row is inserted with the literal string from the tool input, so production rows carry the role `"reader"` while folder-access checks (e.g. `canReadFolderSql`) and any UI filtering keyed on `"viewer"` won't match. Effectively this means *no current data has the `viewer` role* — all "viewers" are stored as `"reader"`, and any role-keyed feature added later will silently miss them.
**Fix**: Pick one name (`viewer` matches Google Drive; `reader` matches FS lingo). Add a migration to rewrite existing rows. Tighten the share tool to use the canonical enum and remove the divergence at the type boundary.
**Effort**: S

### S6: WebDAV locks live in a process-local `Map` · severity: MEDIUM · category: bug
**File**: `apps/helix/src/platform/drive/routes.ts:42, 172-203, 532-566`
**What's wrong**: `const locks = new Map<string, WebDavLock>()` is closed-over per Fastify instance. With more than one Helix replica (i.e. any production deployment) the lock granted by replica A is invisible to replica B, so the WebDAV LOCK precondition is a no-op across the cluster — concurrent Office/Finder writes silently win-last. Lock state is also wiped on restart.
**Fix**: Persist locks in Postgres (`drive_webdav_locks` table keyed by `(org_id, path)` with a `token`, `expires_at`, and `actor_id`), or use Redis if low-latency is critical. Same fix should de-duplicate the `LOCK` `pathKey` collision risk for siblings differing only by URI encoding.
**Effort**: M

### S7: WebDAV PUT body is fully buffered + the body parser reads everything to memory · severity: MEDIUM · category: bug
**File**: `apps/helix/src/platform/drive/routes.ts:38-40, 700-714` and `routes.ts:783-791`
**What's wrong**: `addContentTypeParser("application/octet-stream", { parseAs: "buffer" })` reads the entire PUT body into a Node Buffer before the handler runs, then `bodyToBuffer` re-allocates for hashing. A WebDAV client uploading a 2 GB ZIP holds that buffer twice. Fastify has a default `bodyLimit` of 1 MB so files >1 MB are rejected outright unless someone has bumped it — meaning WebDAV likely doesn't work for typical files today.
**Fix**: Switch to a streaming content-type parser (`raw-body` with a `Readable` passthrough); compute the SHA-256 incrementally with `createHash("sha256")` piped into the request stream; pipe the same stream into the storage client's streaming `put`. Confirm/raise `bodyLimit` for `/dav/*` routes only.
**Effort**: M

### S8: `assertStorageQuotaAvailable` does `for update of orgs` on every prepare/finalize · severity: MEDIUM · category: quality
**File**: `apps/helix/src/platform/drive/store.ts:1503-1570`
**What's wrong**: The quota check holds a row lock on the org for the duration of `prepareUpload`'s transaction *and* the duration of `finalizeUpload`'s transaction. Finalize also issues a synchronous S3 PUT *inside that same transaction* (store.ts:425-435). With many concurrent uploads to the same org, every upload serializes on the `orgs` row lock, and the S3 PUT latency now blocks Postgres connections. Under load this will deadlock the connection pool.
**Fix**: Move the S3 PUT out of the transaction (the version row insert can stay transactional, but the blob upload should happen *before* the tx opens or after it commits, with reconciliation for the rare orphan). Use an advisory lock keyed on `(org_id, 'drive_quota')` instead of `for update` so it doesn't conflict with non-quota updates to `orgs`. Cache the org's `storage_bytes_limit` resolution in memory with a short TTL.
**Effort**: M

### S9: Inline-body dev fallback still wired into the prod `/content` and `/preview` routes · severity: MEDIUM · category: security
**File**: `apps/helix/src/server.ts:2612-2626, 2657-2664` and `apps/helix/src/platform/drive/inline-body.ts:24-42`
**What's wrong**: The guard in `allowInlineBodyFallback` rejects when `env.NODE_ENV === "production"`, but a) `NODE_ENV` is not always set in containers, b) the markers `source === "corpus"`, `backfilled === true`, `migratedFromNative === true`, `inlineBodyDevFallback === true` are user-controllable metadata keys (callers pass `metadata` into both `drive.upload` and `drive.finalize`) — a non-prod environment then exposes arbitrary base64 content as the served body even if storage was wiped. The check is also too easy to misconfigure: a missing `NODE_ENV` opens the door.
**Fix**: Require an explicit `HELIX_ALLOW_INLINE_BODY_DEV_FALLBACK=1` env opt-in and refuse to honor user metadata; the markers should only be set by the seed/migration scripts directly on the DB row, never accepted from API input. Strip `inlineBody`/`inlineMime` from `metadata` in `prepareUpload`/`finalizeUpload` before persisting.
**Effort**: S

### S10: `drive.share` permission insert ignores existing role conflicts · severity: MEDIUM · category: bug
**File**: `apps/helix/src/platform/drive/store.ts:721-727`
**What's wrong**: The insert is `on conflict do nothing`. So sharing a file to actor X as `editor` when X already has it as `reader` is a silent no-op — the higher role is *not* granted. Same problem when re-sharing with a longer expiry: the old expiry sticks. There's no `drive.unshare` tool at all (the only way to revoke is to call permission-store APIs directly), and no way to *change* a role.
**Fix**: `on conflict (org_id, actor_id, resource_type, resource_id) do update set role = excluded.role, expires_at = excluded.expires_at, granted_by_actor_id = excluded.granted_by_actor_id`. Add a `drive.unshare` tool. Surface the existing grants in the UI so users can see who has access.
**Effort**: S

### S11: `share` doesn't validate the target actor belongs to the same org · severity: MEDIUM · category: security
**File**: `apps/helix/src/platform/drive/store.ts:706-737`
**What's wrong**: `targetActorIds` is taken verbatim from `drive.share` input and inserted into `permissions` with the caller's `orgId`. The schema only requires UUIDs. A caller can grant access to *any* UUID — including the actor id of a user from another tenant — and the permissions row will be created. Whether the cross-tenant actor can then actually read depends on whether the read path also enforces `org_id` on the actor lookup (it does, but the *grant being possible* is the bug — it leaks structural information and creates phantom grants that future code might trust).
**Fix**: Resolve each `targetActorId` against `actors where org_id = ${input.orgId}` before inserting, and throw on miss.
**Effort**: S

### S12: Trashing a file leaves the storage blob (and its versions) indefinitely · severity: MEDIUM · category: bug
**File**: `apps/helix/src/platform/drive/store.ts:752-780`
**What's wrong**: `trash` only sets `deleted_at`; bytes stay in object storage. There's no garbage collection / retention sweeper, and `restore` (store.ts:782-793) doesn't restore deleted versions. Combined with no purge after N days, a tenant who uploads/trashes a 1 GB file every day will pay storage forever. Quota accounting in `assertStorageQuotaAvailable` filters out `deleted_at is not null`, so the user doesn't see the trashed storage in their quota — meaning they can fill the bucket without ever hitting the quota wall.
**Fix**: Quota math should count trashed bytes against the tenant (Google Drive includes Trash in quota). Add a configurable retention sweeper that deletes trashed objects + storage after N days. Audit the delete.
**Effort**: M

### S13: PROPFIND lists at most 250 children, silently truncates · severity: MEDIUM · category: bug
**File**: `apps/helix/src/platform/drive/routes.ts:81-87, 346-352`
**What's wrong**: `findChild` and `resolveTarget` call `store.list({ limit: 250 })`. A folder with 251+ children produces an incomplete WebDAV listing and `findChild` may return `null` for a file that genuinely exists — leading to 404 on PUT/GET for files in busy folders. No pagination loop, no warning.
**Fix**: Either iterate `list` with a cursor until exhausted, or push the lookup into a dedicated `findChildByName(folderId, name)` SQL query so it doesn't depend on the list slice.
**Effort**: S

### S14: `acrossFolders` mode skips folder access check entirely · severity: MEDIUM · category: security
**File**: `apps/helix/src/platform/drive/store.ts:518-574`
**What's wrong**: When `acrossFolders` is true *or* `kind !== "file"` (which forces it true), the code path skips `requireFolderAccess`. The SQL then filters files by `owner_actor_id = actorId OR exists permission`, which is correct for files — but a caller passing a `folderId` together with `acrossFolders=true` gets that parameter silently ignored (the SQL `${acrossFolders}` short-circuits the folder filter). The contract is unclear and easy to misuse, e.g. a future caller relying on `folderId` to scope a recording lookup will see results from every folder.
**Fix**: Make `folderId` + `acrossFolders=true` a validation error in the tool schema. Document the semantics in `DriveStore.list` jsdoc.
**Effort**: S

### S15: No file rename / copy / duplicate · severity: MEDIUM · category: missing
**File**: `apps/helix/src/platform/drive/store.ts` (no `rename` or `copy` methods); `apps/helix/src/platform/drive/tools.ts` (no `drive.rename` / `drive.copy`)
**What's wrong**: Files can be created, moved between folders, trashed, restored, deleted — but never renamed (the `name` lives in `metadata.name` and there's no setter) and never copied. WebDAV MOVE/COPY methods are also not registered (`routes.ts:28, 56` lists only `PROPFIND/GET/PUT/DELETE/MKCOL/LOCK/UNLOCK`). Users in the SPA have no way to rename a file after upload.
**Fix**: Add `drive.rename` (object + folder), `drive.copy`, and WebDAV `MOVE`/`COPY`. Update the search projection on rename.
**Effort**: M

### S16: No drag-and-drop folder upload / no chunked uploads · severity: MEDIUM · category: missing
**File**: `apps/web/src/features/drive/drive-shell.tsx:318-400, 654-662` and `apps/web/src/features/drive/api.ts:160-220`
**What's wrong**: The file input is single-file (`fileInputRef.current?.click()`, `event.target.files?.[0]`). `uploadDriveFile` reads the whole file into an `ArrayBuffer` then base64-encodes it for the fallback path, so >100 MB uploads will block the main thread / blow the heap. No multipart/chunked upload, no resumable upload (S3 multipart not exposed), no folder upload, and no progress indicator.
**Fix**: Multi-file `<input multiple>`, drag-and-drop with `webkitGetAsEntry` for folders, chunked direct-to-S3 via multipart with the prepared URL pattern extended to `presignMultipartUpload`. Progress events via `XMLHttpRequest` upload.onprogress.
**Effort**: L

### S17: Share dialog is a freeform "Actor ID(s) to share with" textbox · severity: MEDIUM · category: missing
**File**: `apps/web/src/features/drive/drive-shell.tsx:1889-1905`
**What's wrong**: To share a file the user types UUIDs into an input box. There's no people picker, no email lookup, no role selector (always hardcoded `role: "reader"` at drive-shell.tsx:444), no visibility into existing shares, no unshare control. This is unusable in practice.
**Fix**: Build a proper share modal — autocomplete against the actors directory (existing platform feature), role dropdown, list of current grants with remove buttons, copy-link affordance once S3 is implemented.
**Effort**: M

### S18: `drive.list` `app` filter discards entries the SQL did pass · severity: LOW · category: bug
**File**: `apps/helix/src/platform/drive/store.ts:554`
**What's wrong**: `coalesce(o.metadata->>'app', 'file') = ${input.app ?? null}` — when `app` is `null` (the common case from the tool), this becomes `coalesce(...) = null` which is always `null` (i.e. NOT TRUE). The outer `(${input.app ?? null}::text is null or ...)` rescues the case, so it's correct — but the implicit null-vs-text comparison is fragile and one mis-edit away from filtering out every file. Also, there's no index on `(org_id, metadata->>'app')` so filtering by app does a full scan of `objects`.
**Fix**: Use an explicit `is null` instead of `coalesce(... = null)`. Add a partial index `objects (org_id, (metadata->>'app')) where kind = 'file' and deleted_at is null`.
**Effort**: S

### S19: `Starred` and `Recent` rely on `metadata.starred` and ILIKE — no indexes · severity: LOW · category: quality
**File**: `apps/helix/src/platform/drive/store.ts:851-883` and `apps/web/src/features/drive/queries.ts:195-199`
**What's wrong**: Search is `coalesce(metadata->>'name', storage_key) ilike '%query%'` — no trigram index, no full-text. Starred is a client-side `entry.metadata?.starred === true` filter on whatever the server happened to return — so a starred file outside the top 100 entries is invisible. There is also no server-side concept of "starred" — no toggle tool, no column.
**Fix**: Promote `starred` to a per-actor table `drive_object_stars (org_id, actor_id, object_id)` with a real query path; add a pg_trgm GIN index on `objects.metadata->>'name'` (or a generated column). Use the search projection from `getDriveSearchRecord` consistently — it already builds the right index document.
**Effort**: M

### S20: Frontend `drive-shell.tsx` is 1 941 LOC in a single component · severity: LOW · category: quality
**File**: `apps/web/src/features/drive/drive-shell.tsx`
**What's wrong**: Sidebar, breadcrumbs, file/folder grid, list view, FAB, details panel, importing-modal, sharing form, and all eight mutations live in one default export. Test file is 1 136 LOC. Hard to navigate, hard to extend (e.g. when adding the proper share dialog from S17 you'd be editing the file again).
**Fix**: Split into `DriveSidebar`, `DriveContent`, `DriveDetailsPanel`, `DriveImportingOverlay`, `useDriveActions` (the mutation cluster). Each can co-locate its tests.
**Effort**: M

### S21: Backend `store.ts` is 2 460 LOC, mixes uploads / comments / PDF forms / search projection / enrichment · severity: LOW · category: quality
**File**: `apps/helix/src/platform/drive/store.ts`
**What's wrong**: `PostgresDriveStore` implements `DriveStore & DriveSearchProjectionStore & DriveEnrichmentProjectionStore`, plus inlines audit-hash chaining, notification fanout, mention parsing, and quota math. The audit/notification helpers (lines 1751-1958) could live in `audit/drive-activity.ts`; comments belong in `drive-comments-store.ts`; PDF form state in `drive-pdf-form-store.ts`; search projection in `drive-search-store.ts`.
**Fix**: Extract the four domains into their own files with their own narrow stores; have `PostgresDriveStore` compose them.
**Effort**: M

### S22: `delete` does S3 deletes inside the Postgres transaction · severity: LOW · category: bug
**File**: `apps/helix/src/platform/drive/store.ts:795-850`
**What's wrong**: The transaction `await tx.begin(...)` covers the loop `await storageForOrg(...).delete(storageKey)` over every version's storage key. If S3 fails mid-loop, the tx rolls back (rows reappear) but some blobs are already gone — and the next "delete" attempt will fail on the missing blobs. Also `for of` with `await` serializes the deletes; a file with 50 versions waits 50 RTTs to S3 holding a DB transaction open.
**Fix**: Compute the storage-key set in the tx, commit, *then* fire deletes in parallel (or via an outbox-driven background job that's idempotent on missing keys).
**Effort**: S

### S23: PROPFIND XML parser is regex-based, fragile against namespaces · severity: LOW · category: bug
**File**: `apps/helix/src/platform/drive/routes.ts:654-669, 605-612`
**What's wrong**: `propfindRequest` and `lockOwner` parse XML with regexes. Real WebDAV clients (Cyberduck, gvfs, davfs2) send namespaced elements like `<a:prop xmlns:a="DAV:">` — the regex `<[^>]*prop\b[^>]*>(?<body>...)</[^>]*prop>` happens to work for most prefixes, but breaks on prefix-less `<prop>` with mixed-case (HTTP names are case-sensitive, but the spec says XML local names are too). One bad client = silent allprop fallback.
**Fix**: Use a real XML parser (`fast-xml-parser` is already a transitive dep in many Node projects, or `@xmldom/xmldom`) with namespace awareness.
**Effort**: S

### S24: `metadata` from API input is JSON-merged into the object record without an allow-list · severity: LOW · category: security
**File**: `apps/helix/src/platform/drive/store.ts:351-372, 449, 1283-1294`
**What's wrong**: `prepareUpload` accepts arbitrary metadata and JSON-merges it with platform-controlled fields (`name`, `folderId`, `status`). A caller passing `metadata: { status: "ready", latestVersionId: "<uuid>", versionNumber: 99 }` will overwrite those keys after the JSON spread `...input.metadata` precedes the trusted keys (line 351-355 spreads first, then sets — so this case is safe), but `recordDriveEnrichment` (line 1259-1273) and `setDriveAutoTags` (line 1276-1295) merge directly into `metadata` with no key filtering. Future writes that don't carefully order their spreads will silently let a tenant overwrite `folderId` (and thus reparent the file).
**Fix**: Whitelist metadata keys callers can set (e.g. `tags`, `description`, `source`); reject reserved keys (`status`, `latestVersionId`, `versionNumber`, `folderId`, `preview`, `enrichments`, `autoTag`) with a 400 error.
**Effort**: S

### S25: No realtime / SSE updates — UI is stale until a manual refetch · severity: LOW · category: missing
**File**: `apps/web/src/features/drive/drive-shell.tsx` (every mutation calls `invalidateDrive()`)
**What's wrong**: When user B uploads to a folder user A is viewing, A sees nothing until the next route change or focus event. The activity outbox already publishes `activity.drive.upload.finalized` events; the SPA could subscribe via SSE/WS but doesn't. Comments are even more affected (collaborators' replies don't appear).
**Fix**: A minimal SSE endpoint `/api/drive/events?folderId=…` filtering activity by folder + actor visibility; React Query invalidation on event receipt. Same channel can power the comments thread.
**Effort**: M

### S26: `notifyDriveCommentMentions` resolves recipients by display-name substring · severity: LOW · category: bug
**File**: `apps/helix/src/platform/drive/store.ts:1798-1957`
**What's wrong**: Mentions are tokenized from `@…` substrings and matched against `displayName.toLowerCase()`, `email.split("@")[0]`, and first-name. Two users named "Alex Chen" both get notified for `@alex`. Worse, `displayName.replace(/[^a-z0-9]+/gu, "")` collapses "Avery Park" and "Avery-Park" to the same alias, so unintended recipients get notified. The mentions text from `metadata.mentionsText` is trusted from the client — a malicious client can spam any user with notifications by passing a `mentionsText` array including arbitrary aliases.
**Fix**: Mentions metadata should be `{ actorId: string }[]` resolved client-side via the actor directory, and the server should ignore string-based `@token` resolution entirely — only accept actor ids and verify each id has read access on the object.
**Effort**: M

### S27: Storage-key validation rejects only the *finalize* override, not the *prepare* path · severity: LOW · category: security
**File**: `apps/helix/src/platform/drive/store.ts:2180-2203`
**What's wrong**: `assertProvidedFinalizeStorageKey` catches path traversal in `finalizeUpload`. But the storage key is generated by `driveStorageKey(orgId, objectId, …, input.name)` in `prepareUpload`, and the only sanitization on `name` is the `[^A-Za-z0-9._-]/g → _` filter — that's safe but the `safeName.slice(0, 180)` truncation is silent (no error) and the resulting key isn't checked against the same `assertProvidedFinalizeStorageKey` invariants (e.g. doesn't enforce that `orgId` is a valid UUID, doesn't reject `objectId` collisions). Defense in depth missing.
**Fix**: Run the same invariant validation on the generated key. Reject if `orgId` doesn't match a UUID. Make the name truncation explicit (return a 400 if the encoded name is > N chars after sanitization, rather than silently clipping).
**Effort**: S

### S28: `formatLabelFromEntry` extension regex matches up to 6 chars, then uppercases the user-supplied tail · severity: LOW · category: quality
**File**: `apps/web/src/features/drive/drive-data.ts:98-108, 134-157`
**What's wrong**: A file named `report.XSSXSS` produces a 6-char label that gets rendered as-is via React (so safe from XSS, but visually ugly). More importantly, `.tar.gz`-style double extensions show only `gz`, and `originalFormat` from `metadata` is rendered with no allow-list. Since metadata is settable from the API (see S24), a tenant can stuff `originalFormat: "🤡🤡🤡"` into the label and have other org members see it in the file row.
**Fix**: Allow-list `originalFormat` to a fixed set; collapse double extensions deterministically.
**Effort**: S
