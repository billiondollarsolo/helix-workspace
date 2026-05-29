/* seed-corpus.ts
 *
 * Hydrates docs / drive folders from the curated manifest at
 * apps/helix/seed/corpus/manifest.json, using content previously cached by
 * db:fetch:corpus into apps/helix/seed/corpus-cache/<manifestId>/.
 *
 * Design goals (per dev steer):
 *   * REAL public content — Wikipedia summaries, SEC excerpts, NASA reports
 *     — not fabricated fake-name data baked into the project.
 *   * Random UUIDs for every entity. Stable cross-run identity comes from
 *     `seed_corpus_assets.manifest_id`, not from predictable UUID patterns.
 *   * Varied ownership and ACL: each manifest entry declares an owner and a
 *     share spec (org / users / private), resolved against the actors table.
 *   * Idempotent: re-running with the same manifest+cache is a no-op; a
 *     changed content hash updates the entity in place; a removed manifest
 *     entry leaves the row alone (we don't garbage-collect).
 *   * Uses the production persistence paths — threads, docs_documents,
 *     objects, permissions — so the seeded data flows through `drive.list`
 *     / `docs.list` / `docs.get` exactly like user-created content.
 *
 * Run with:  pnpm db:seed:corpus   (after db:fetch:corpus has populated the
 *                                  local cache, and db:seed:logins has
 *                                  created the org + actors)
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type postgres from "postgres";
import { createSqlClient } from "./client.js";
import { buildDocsBodyState } from "./seed-docs-body.js";

const MANIFEST_PATH = resolve(import.meta.dirname, "..", "..", "seed", "corpus", "manifest.json");
const CACHE_ROOT = resolve(import.meta.dirname, "..", "..", "seed", "corpus-cache");

type SeedSql = postgres.Sql | postgres.TransactionSql;

// -------------------------------------------------------------------------
// Manifest types
// -------------------------------------------------------------------------

/** Per-actor role on a Drive entry — mirrors Google Drive sharing model.
 *
 *  - `owner`    full control, can delete + reshare
 *  - `editor`   read + write
 *  - `commenter` read + suggest, no direct edit
 *  - `viewer`   read-only */
type ShareRole = "owner" | "editor" | "commenter" | "viewer";

interface ShareSpec {
  readonly kind: "org" | "users" | "private";
  /** Legacy: a flat list of actors, all granted "viewer". Kept for
   *  backwards-compat with the older manifest entries; new entries
   *  should use `grants` for per-actor role variety. */
  readonly actors?: readonly string[];
  /** Per-actor role grants — used when `kind: "users"` and you want
   *  mixed view/comment/edit access. */
  readonly grants?: readonly { readonly actor: string; readonly role: ShareRole }[];
  /** Default role for `kind: "org"` — viewer (default) gives the org
   *  read access; bump to "commenter" or "editor" for org-wide collab. */
  readonly orgRole?: ShareRole;
  /** Per-actor role overrides on top of the org-wide default. */
  readonly orgOverrides?: readonly { readonly actor: string; readonly role: ShareRole }[];
}

interface FolderSpec {
  readonly manifestId: string;
  readonly name: string;
  readonly parent: string | null;
  readonly owner: string;
  readonly share: ShareSpec;
}

interface ItemSpec {
  readonly manifestId: string;
  /** `"doc"` = native Helix doc (Yjs editor body); `"drive_file"` = raw
   *  binary (PDF, DOCX, XLSX, PPTX, CSV, ZIP, image, etc.) uploaded to
   *  RustFS as-is. */
  readonly kind: "doc" | "drive_file";
  readonly title: string;
  readonly owner: string;
  readonly share: ShareSpec;
  /** Manifest id of the parent folder, or null / omitted for root. */
  readonly folder?: string | null;
  readonly tags?: readonly string[];
  readonly source: { readonly url?: string };
  /** For `drive_file`: mime type to send on download. */
  readonly mimeType?: string;
  /** For `drive_file`: short uppercase chip label (DOCX, PDF, etc.). */
  readonly originalFormat?: string;
}

interface Manifest {
  readonly version: number;
  readonly folders: readonly FolderSpec[];
  readonly items: readonly ItemSpec[];
}

// -------------------------------------------------------------------------
// Loaders
// -------------------------------------------------------------------------

async function loadManifest(): Promise<Manifest> {
  const raw = await readFile(MANIFEST_PATH, "utf8");
  return JSON.parse(raw) as Manifest;
}

interface CachedMetadata {
  readonly manifestId: string;
  readonly sha256: string;
  readonly extension: string;
}

async function loadCachedContent(manifestId: string): Promise<{ body: Buffer; hash: string; extension: string }> {
  const metaPath = resolve(CACHE_ROOT, manifestId, "metadata.json");
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as CachedMetadata;
  const contentPath = resolve(CACHE_ROOT, manifestId, `content.${meta.extension}`);
  const body = await readFile(contentPath);
  return { body, hash: meta.sha256, extension: meta.extension };
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

// -------------------------------------------------------------------------
// Actor + org resolution
// -------------------------------------------------------------------------

interface Actor {
  readonly id: string;
  readonly orgId: string;
  readonly email: string;
  readonly displayName: string;
}

async function resolveActors(sql: SeedSql, emails: readonly string[]): Promise<ReadonlyMap<string, Actor>> {
  if (emails.length === 0) {
    return new Map();
  }
  const rows = (await sql`
    select id, org_id, email, display_name
    from actors
    where email in ${sql(emails)}
  `) as unknown as readonly {
    readonly id: string;
    readonly org_id: string;
    readonly email: string;
    readonly display_name: string;
  }[];
  const map = new Map<string, Actor>();
  for (const row of rows) {
    if (row.email) {
      map.set(row.email, {
        id: row.id,
        orgId: row.org_id,
        email: row.email,
        displayName: row.display_name,
      });
    }
  }
  return map;
}

async function loadOrgMemberActors(sql: SeedSql, orgId: string): Promise<readonly string[]> {
  const rows = (await sql`
    select id from actors where org_id = ${orgId} and type = 'user'
  `) as unknown as readonly { readonly id: string }[];
  return rows.map((r) => r.id);
}

// -------------------------------------------------------------------------
// Grant helpers
// -------------------------------------------------------------------------

async function grant(
  sql: SeedSql,
  orgId: string,
  actorId: string,
  resourceType: "thread" | "object" | "document" | "drive_folder",
  resourceId: string,
  role: "owner" | "editor" | "viewer" | "member" | "commenter",
  grantedBy: string,
): Promise<void> {
  await sql`
    insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    values (${orgId}, ${actorId}, ${resourceType}, ${resourceId}, ${role}, ${grantedBy})
    on conflict do nothing
  `;
}

interface ShareTarget {
  readonly actorId: string;
  readonly role: ShareRole;
}

/** Resolve a ShareSpec to a list of `(actorId, role)` grants in addition
 *  to the owner. Supports four authoring styles:
 *
 *   • `kind:"private"`              → no grants
 *   • `kind:"users", actors:[...]`  → legacy flat list, all viewer
 *   • `kind:"users", grants:[...]`  → per-actor role variety
 *   • `kind:"org"`                  → every org member at `orgRole`
 *                                     (default viewer) + per-actor
 *                                     overrides via `orgOverrides` */
async function resolveShareTargets(
  sql: SeedSql,
  share: ShareSpec,
  ownerActorId: string,
  orgId: string,
  emailToActor: ReadonlyMap<string, Actor>,
): Promise<readonly ShareTarget[]> {
  if (share.kind === "private") {
    return [];
  }
  if (share.kind === "users") {
    const byActor = new Map<string, ShareRole>();
    for (const email of share.actors ?? []) {
      const actor = emailToActor.get(email);
      if (actor && actor.id !== ownerActorId) byActor.set(actor.id, "viewer");
    }
    for (const grantSpec of share.grants ?? []) {
      const actor = emailToActor.get(grantSpec.actor);
      if (actor && actor.id !== ownerActorId) byActor.set(actor.id, grantSpec.role);
    }
    return [...byActor].map(([actorId, role]) => ({ actorId, role }));
  }
  // share.kind === "org": grant `orgRole` (default viewer) to every org
  // member except the owner; per-actor overrides win.
  const defaultRole: ShareRole = share.orgRole ?? "viewer";
  const overrides = new Map<string, ShareRole>();
  for (const o of share.orgOverrides ?? []) {
    const actor = emailToActor.get(o.actor);
    if (actor) overrides.set(actor.id, o.role);
  }
  const all = await loadOrgMemberActors(sql, orgId);
  return all
    .filter((id) => id !== ownerActorId)
    .map((actorId) => ({ actorId, role: overrides.get(actorId) ?? defaultRole }));
}

// -------------------------------------------------------------------------
// Folder + doc creation
// -------------------------------------------------------------------------

interface ManifestRegistration {
  readonly manifestId: string;
  readonly entityId: string;
  readonly entityKind: "document" | "drive_folder" | "drive_file";
  readonly contentHash: string;
}

async function lookupRegistration(
  sql: SeedSql,
  manifestId: string,
): Promise<{ entityId: string; contentHash: string } | null> {
  const rows = (await sql`
    select entity_id, content_hash from seed_corpus_assets where manifest_id = ${manifestId}
  `) as unknown as readonly { readonly entity_id: string; readonly content_hash: string }[];
  const row = rows[0];
  return row ? { entityId: row.entity_id, contentHash: row.content_hash } : null;
}

async function recordRegistration(
  sql: SeedSql,
  reg: ManifestRegistration & { orgId: string; ownerActorId: string; sourceUrl?: string; driveObjectId?: string },
): Promise<void> {
  await sql`
    insert into seed_corpus_assets (
      manifest_id, org_id, entity_kind, entity_id, drive_object_id,
      owner_actor_id, content_hash, source_url, imported_at, updated_at
    ) values (
      ${reg.manifestId}, ${reg.orgId}, ${reg.entityKind}, ${reg.entityId},
      ${reg.driveObjectId ?? null}, ${reg.ownerActorId}, ${reg.contentHash},
      ${reg.sourceUrl ?? null}, now(), now()
    )
    on conflict (manifest_id) do update set
      entity_id = excluded.entity_id,
      entity_kind = excluded.entity_kind,
      drive_object_id = excluded.drive_object_id,
      owner_actor_id = excluded.owner_actor_id,
      content_hash = excluded.content_hash,
      source_url = excluded.source_url,
      updated_at = now()
  `;
}

async function createFolder(
  sql: SeedSql,
  spec: FolderSpec,
  ownerActor: Actor,
  parentId: string | null,
  shareTargets: readonly ShareTarget[],
): Promise<string> {
  const folderId = randomUUID();
  await sql`
    insert into drive_folders (id, org_id, name, parent_folder_id, owner_actor_id, created_by_actor_id, metadata)
    values (
      ${folderId}, ${ownerActor.orgId}, ${spec.name}, ${parentId},
      ${ownerActor.id}, ${ownerActor.id},
      ${sql.json({ source: "corpus", manifestId: spec.manifestId })}
    )
  `;
  await grant(sql, ownerActor.orgId, ownerActor.id, "drive_folder", folderId, "owner", ownerActor.id);
  if (spec.share.kind === "private") {
    // Private folder stays private — only the owner gets a grant. The
    // contents would also be private unless explicitly shared.
    return folderId;
  }
  // Folder visibility is wider than its contents by design: the folder
  // is a navigation handle, and each file inside has its own ACL. So
  // grant ALL org members read on non-private folders — files inside
  // gate access individually. (Matches Google Drive: a team folder
  // being browsable doesn't expose files that haven't been shared.)
  const orgMembers = await loadOrgMemberActors(sql, ownerActor.orgId);
  const explicitTargets = new Set(shareTargets.map((t) => t.actorId));
  for (const memberId of orgMembers) {
    if (memberId === ownerActor.id) continue;
    if (explicitTargets.has(memberId)) continue;
    await grant(sql, ownerActor.orgId, memberId, "drive_folder", folderId, "viewer", ownerActor.id);
  }
  for (const target of shareTargets) {
    await grant(sql, ownerActor.orgId, target.actorId, "drive_folder", folderId, "viewer", ownerActor.id);
  }
  return folderId;
}

async function createDocFromMarkdown(
  sql: SeedSql,
  item: ItemSpec,
  ownerActor: Actor,
  folderId: string | null,
  markdown: string,
  shareTargets: readonly ShareTarget[],
): Promise<{ documentId: string; objectId: string }> {
  const documentId = randomUUID();
  const threadId = randomUUID();
  const body = buildDocsBodyState(markdown);

  // 1. thread row (the cross-feature parent for activity / comments)
  await sql`
    insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
    values (${threadId}, ${ownerActor.orgId}, 'doc', ${item.title}, ${ownerActor.id},
            ${sql.json({ documentTitle: item.title, source: "corpus" })})
  `;

  // 2. docs_documents row (the typed Yjs editor state + version log root)
  await sql`
    insert into docs_documents (
      id, org_id, title, thread_id, owner_actor_id, created_by_actor_id,
      ydoc_state, ydoc_state_vector, update_seq, metadata
    ) values (
      ${documentId}, ${ownerActor.orgId}, ${item.title}, ${threadId},
      ${ownerActor.id}, ${ownerActor.id},
      ${body.state}, ${body.stateVector}, 0,
      ${sql.json({
        source: "corpus",
        manifestId: item.manifestId,
        plainText: markdown,
        tags: item.tags ?? [],
        sourceUrl: item.source.url ?? null,
      })}
    )
  `;

  // 3. matching objects row so it shows up in drive.list with app="docs"
  const objectId = documentId; // shared-PK convention used everywhere else
  await sql`
    insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
    values (
      ${objectId}, ${ownerActor.orgId}, ${ownerActor.id}, 'file',
      ${`docs/${ownerActor.orgId}/${objectId}`},
      'application/vnd.helix.document', ${body.state.byteLength}, null,
      ${sql.json({
        source: "corpus",
        app: "docs",
        docId: documentId,
        name: `${item.title}.helixdoc`,
        title: item.title,
        originalFormat: "md",
        // Place the doc INSIDE its organizational folder so /drive shows
        // it when navigating into the folder. /docs, /sheets, /slides
        // use `acrossFolders: true` to flatten across all folders, so
        // app-shaped pages still surface it.
        folderId,
      })}
    )
  `;

  // 4. grants — owner gets owner role on all three resource types; share
  // targets get viewer. drive.list filters on `object`, docs.get filters on
  // `document`, and the thread grant unlocks comments / activity.
  await grant(sql, ownerActor.orgId, ownerActor.id, "thread", threadId, "owner", ownerActor.id);
  await grant(sql, ownerActor.orgId, ownerActor.id, "document", documentId, "owner", ownerActor.id);
  await grant(sql, ownerActor.orgId, ownerActor.id, "object", objectId, "owner", ownerActor.id);
  // Per-actor roles: viewer = read-only; commenter = read + suggest;
  // editor = full read+write. Native helix editors project these into
  // edit/comment/review permission bits + view/edit mode.
  for (const target of shareTargets) {
    await grant(sql, ownerActor.orgId, target.actorId, "thread", threadId, "member", ownerActor.id);
    await grant(sql, ownerActor.orgId, target.actorId, "document", documentId, target.role, ownerActor.id);
    await grant(sql, ownerActor.orgId, target.actorId, "object", objectId, target.role, ownerActor.id);
  }

  return { documentId, objectId };
}

/** Insert a Drive file row carrying its content inline in metadata
 *  (`metadata.inlineBody` is base64, `metadata.inlineMime` is the MIME).
 *  For local dev we avoid the RustFS virtual-host-vs-path-style headache
 *  by serving these bytes straight from Postgres via the
 *  `/api/drive/objects/:id/content` route. Production code stays on RustFS;
 *  the read path falls back to the inline body when RustFS has nothing. */
async function createDriveFile(
  sql: SeedSql,
  item: ItemSpec,
  ownerActor: Actor,
  folderId: string | null,
  body: Buffer,
  shareTargets: readonly ShareTarget[],
  extension: string,
): Promise<{ objectId: string }> {
  const objectId = randomUUID();
  const mimeType = item.mimeType ?? mimeFromExtension(extension);
  const storageKey = `corpus/${ownerActor.orgId}/${objectId}`;
  const sha = createHash("sha256").update(body).digest("hex");

  await sql`
    insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
    values (
      ${objectId}, ${ownerActor.orgId}, ${ownerActor.id}, 'file',
      ${storageKey}, ${mimeType}, ${body.byteLength}, ${sha},
      ${sql.json({
        source: "corpus",
        name: deriveFileName(item, extension),
        title: item.title,
        // Place inside the organizational folder — /drive surfaces it
        // when you navigate in; /docs|sheets|slides use acrossFolders.
        folderId,
        originalFormat: (item.originalFormat ?? extension).toUpperCase(),
        inlineMime: mimeType,
        inlineBody: body.toString("base64"),
      })}
    )
  `;

  await grant(sql, ownerActor.orgId, ownerActor.id, "object", objectId, "owner", ownerActor.id);
  for (const target of shareTargets) {
    await grant(sql, ownerActor.orgId, target.actorId, "object", objectId, target.role, ownerActor.id);
  }
  return { objectId };
}

function deriveFileName(item: ItemSpec, extension: string): string {
  const base = item.title.replace(/[\\/:*?"<>|]+/g, "-").trim();
  return base.toLowerCase().endsWith(`.${extension.toLowerCase()}`) ? base : `${base}.${extension}`;
}

const EXTENSION_TO_MIME: ReadonlyMap<string, string> = new Map([
  ["pdf", "application/pdf"],
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ["csv", "text/csv; charset=utf-8"],
  ["txt", "text/plain; charset=utf-8"],
  ["md", "text/markdown; charset=utf-8"],
  ["json", "application/json"],
  ["zip", "application/zip"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["gif", "image/gif"],
  ["svg", "image/svg+xml"],
  ["mp4", "video/mp4"],
  ["html", "text/html; charset=utf-8"],
]);

function mimeFromExtension(extension: string): string {
  return EXTENSION_TO_MIME.get(extension.toLowerCase()) ?? "application/octet-stream";
}

// -------------------------------------------------------------------------
// Driver
// -------------------------------------------------------------------------

interface CorpusStats {
  folders: { created: number; updated: number };
  docs: { created: number; updated: number; skipped: number };
  files: { created: number; updated: number; skipped: number };
}

async function seedCorpus(sql: postgres.Sql): Promise<CorpusStats> {
  const stats: CorpusStats = {
    folders: { created: 0, updated: 0 },
    docs: { created: 0, updated: 0, skipped: 0 },
    files: { created: 0, updated: 0, skipped: 0 },
  };

  const manifest = await loadManifest();

  // Resolve every email referenced by the manifest to an actor record.
  const emails = new Set<string>();
  for (const folder of manifest.folders) {
    emails.add(folder.owner);
    for (const a of folder.share.actors ?? []) emails.add(a);
  }
  for (const item of manifest.items) {
    emails.add(item.owner);
    for (const a of item.share.actors ?? []) emails.add(a);
  }
  const emailToActor = await resolveActors(sql, [...emails]);

  // Every actor must resolve — otherwise seed-logins hasn't run yet.
  const missing = [...emails].filter((email) => !emailToActor.has(email));
  if (missing.length > 0) {
    throw new Error(
      `seed-corpus: unknown actor emails (run db:seed:logins first?): ${missing.join(", ")}`,
    );
  }
  const anyActor = emailToActor.values().next().value;
  if (!anyActor) {
    throw new Error("seed-corpus: no actors resolved");
  }
  const orgId = anyActor.orgId;

  // -------- folders --------
  // Two-pass: create roots first, then children (so parent_folder_id refers
  // to a row that already exists).
  const folderIdByManifestId = new Map<string, string>();
  const folderOrder = orderFolders(manifest.folders);
  for (const spec of folderOrder) {
    const owner = emailToActor.get(spec.owner);
    if (!owner) {
      throw new Error(`folder ${spec.manifestId}: owner ${spec.owner} not resolvable`);
    }
    const parentId = spec.parent === null ? null : (folderIdByManifestId.get(spec.parent) ?? null);
    const targets = await resolveShareTargets(sql, spec.share, owner.id, orgId, emailToActor);

    const existing = await lookupRegistration(sql, spec.manifestId);
    const contentHash = sha256(Buffer.from(`folder:${spec.name}:${parentId ?? "root"}`, "utf8"));

    if (existing && existing.contentHash === contentHash) {
      folderIdByManifestId.set(spec.manifestId, existing.entityId);
      continue;
    }

    const folderId = existing?.entityId ?? (await createFolder(sql, spec, owner, parentId, targets));
    if (existing) {
      stats.folders.updated += 1;
    } else {
      stats.folders.created += 1;
    }
    folderIdByManifestId.set(spec.manifestId, folderId);

    await recordRegistration(sql, {
      manifestId: spec.manifestId,
      entityKind: "drive_folder",
      entityId: folderId,
      contentHash,
      orgId,
      ownerActorId: owner.id,
    });
  }

  // -------- drive_file (raw binaries) --------
  for (const item of manifest.items) {
    if (item.kind !== "drive_file") {
      continue;
    }
    const owner = emailToActor.get(item.owner);
    if (!owner) {
      throw new Error(`item ${item.manifestId}: owner ${item.owner} not resolvable`);
    }
    // null/omitted folder → file lives at the drive root. Otherwise look
    // up the corpus folder id; an unknown folder ref is a manifest typo.
    const folderId: string | null = item.folder === undefined || item.folder === null
      ? null
      : (folderIdByManifestId.get(item.folder) ?? null);
    if (item.folder !== undefined && item.folder !== null && folderId === null) {
      throw new Error(`item ${item.manifestId}: unknown folder ${String(item.folder)}`);
    }

    let cached;
    try {
      cached = await loadCachedContent(item.manifestId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `  ! ${item.manifestId}: cache miss (run pnpm helix db:fetch:corpus first) → ${message}\n`,
      );
      stats.files.skipped += 1;
      continue;
    }

    const existing = await lookupRegistration(sql, item.manifestId);
    if (existing && existing.contentHash === cached.hash) {
      stats.files.skipped += 1;
      continue;
    }

    const targets = await resolveShareTargets(sql, item.share, owner.id, orgId, emailToActor);

    if (existing) {
      // Update path: re-encode bytes inline + bump metadata. Keep the same
      // object id so any other references survive.
      const sha = createHash("sha256").update(cached.body).digest("hex");
      const mimeType = item.mimeType ?? mimeFromExtension(cached.extension);
      await sql`
        update objects
        set byte_size = ${cached.body.byteLength},
            sha256 = ${sha},
            mime_type = ${mimeType},
            metadata = metadata || ${sql.json({
              originalFormat: (item.originalFormat ?? cached.extension).toUpperCase(),
              title: item.title,
              inlineMime: mimeType,
              inlineBody: cached.body.toString("base64"),
            })},
            updated_at = now()
        where id = ${existing.entityId}
      `;
      stats.files.updated += 1;
      await recordRegistration(sql, {
        manifestId: item.manifestId,
        entityKind: "drive_file",
        entityId: existing.entityId,
        contentHash: cached.hash,
        orgId,
        ownerActorId: owner.id,
        ...(item.source.url === undefined ? {} : { sourceUrl: item.source.url }),
        driveObjectId: existing.entityId,
      });
    } else {
      const { objectId } = await createDriveFile(
        sql,
        item,
        owner,
        folderId,
        cached.body,
        targets,
        cached.extension,
      );
      stats.files.created += 1;
      await recordRegistration(sql, {
        manifestId: item.manifestId,
        entityKind: "drive_file",
        entityId: objectId,
        contentHash: cached.hash,
        orgId,
        ownerActorId: owner.id,
        ...(item.source.url === undefined ? {} : { sourceUrl: item.source.url }),
        driveObjectId: objectId,
      });
    }
  }

  // -------- docs --------
  for (const item of manifest.items) {
    if (item.kind !== "doc") {
      continue;
    }
    const owner = emailToActor.get(item.owner);
    if (!owner) {
      throw new Error(`item ${item.manifestId}: owner ${item.owner} not resolvable`);
    }
    // null/omitted folder → file lives at the drive root. Otherwise look
    // up the corpus folder id; an unknown folder ref is a manifest typo.
    const folderId: string | null = item.folder === undefined || item.folder === null
      ? null
      : (folderIdByManifestId.get(item.folder) ?? null);
    if (item.folder !== undefined && item.folder !== null && folderId === null) {
      throw new Error(`item ${item.manifestId}: unknown folder ${String(item.folder)}`);
    }

    let cached;
    try {
      cached = await loadCachedContent(item.manifestId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `  ! ${item.manifestId}: cache miss (run pnpm helix db:fetch:corpus first) → ${message}\n`,
      );
      stats.docs.skipped += 1;
      continue;
    }
    const markdown = cached.body.toString("utf8");
    const contentHash = cached.hash;

    const existing = await lookupRegistration(sql, item.manifestId);
    if (existing && existing.contentHash === contentHash) {
      stats.docs.skipped += 1;
      continue;
    }

    const targets = await resolveShareTargets(sql, item.share, owner.id, orgId, emailToActor);

    if (existing) {
      // Content changed — rewrite the body in place, keep the same id so
      // outside references survive.
      const body = buildDocsBodyState(markdown);
      await sql`
        update docs_documents
        set ydoc_state = ${body.state},
            ydoc_state_vector = ${body.stateVector},
            update_seq = update_seq + 1,
            metadata = metadata || ${sql.json({ plainText: markdown, sourceUrl: item.source.url ?? null })},
            updated_at = now()
        where id = ${existing.entityId}
      `;
      await sql`
        update objects
        set byte_size = ${body.state.byteLength},
            metadata = metadata || ${sql.json({ folderId, title: item.title, name: `${item.title}.helixdoc` })},
            updated_at = now()
        where id = ${existing.entityId}
      `;
      stats.docs.updated += 1;
      await recordRegistration(sql, {
        manifestId: item.manifestId,
        entityKind: "document",
        entityId: existing.entityId,
        contentHash,
        orgId,
        ownerActorId: owner.id,
        ...(item.source.url === undefined ? {} : { sourceUrl: item.source.url }),
        driveObjectId: existing.entityId,
      });
    } else {
      const { documentId, objectId } = await createDocFromMarkdown(sql, item, owner, folderId, markdown, targets);
      stats.docs.created += 1;
      await recordRegistration(sql, {
        manifestId: item.manifestId,
        entityKind: "document",
        entityId: documentId,
        contentHash,
        orgId,
        ownerActorId: owner.id,
        ...(item.source.url === undefined ? {} : { sourceUrl: item.source.url }),
        driveObjectId: objectId,
      });
    }
  }

  return stats;
}

/** Topologically order folders so each child's parent is created first. */
function orderFolders(folders: readonly FolderSpec[]): readonly FolderSpec[] {
  const remaining = [...folders];
  const placed = new Set<string>();
  const ordered: FolderSpec[] = [];
  while (remaining.length > 0) {
    const idx = remaining.findIndex((f) => f.parent === null || placed.has(f.parent));
    if (idx < 0) {
      throw new Error(
        `seed-corpus: folder cycle or unknown parent reference among: ${remaining.map((f) => f.manifestId).join(", ")}`,
      );
    }
    const spec = remaining.splice(idx, 1)[0]!;
    ordered.push(spec);
    placed.add(spec.manifestId);
  }
  return ordered;
}

async function main(): Promise<void> {
  const sql = createSqlClient();
  try {
    const stats = await seedCorpus(sql);
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          folders: stats.folders,
          docs: stats.docs,
          files: stats.files,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`seed-corpus FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export { seedCorpus };
