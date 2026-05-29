#!/usr/bin/env tsx
/* Helix test corpus — seed.
 *
 * Walks ./apache-tika /commonmark /libreoffice /picsum and uploads every file
 * into the running Helix backend's Drive using the same two-phase pattern the
 * web client uses (Google-Drive / Dropbox / OneDrive style):
 *
 *   1. POST /api/tools/drive.upload   — reserve an object + storage key
 *   2. POST /api/tools/drive.finalize — commit the first immutable version
 *
 * This matches the production ingest path exactly so seeded files behave the
 * same as user-uploaded files (versioning, permissions, virus scanning hooks,
 * search indexing, etc.).
 *
 * Folder layout in Drive:
 *   /test-corpus/
 *     apache-tika/{microsoft,pdf,miscoffice,image,html}/<file>
 *     commonmark/<file>
 *     picsum/<file>
 *     libreoffice/<file>   (optional)
 *
 * Idempotent: skips files already present (matched by name + folder + sha256).
 *
 * Env overrides:
 *   HELIX_BACKEND_URL   default http://localhost:3000
 *   HELIX_SEED_EMAIL    default local-admin@helix.local
 *   HELIX_SEED_PASSWORD default helix-local-dev-password (or HELIX_LOCAL_DEMO_PASSWORD)
 *   HELIX_SEED_ROOT     default "test-corpus" (folder name at Drive root)
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const BACKEND = process.env.HELIX_BACKEND_URL ?? "http://localhost:3000";
const EMAIL = process.env.HELIX_SEED_EMAIL ?? "admin@helix.local";
const PASSWORD = process.env.HELIX_SEED_PASSWORD ?? "helix-admin-password";
const ROOT_FOLDER = process.env.HELIX_SEED_ROOT ?? "test-corpus";
const DRY = process.argv.includes("--dry-run");
const CONCURRENCY = Number(process.env.HELIX_SEED_CONCURRENCY ?? "6");

interface DiscoveredFile {
  abs: string;
  rel: string; // path under HERE, e.g. "apache-tika/microsoft/foo.docx"
  size: number;
}

interface SignedInSession {
  cookie: string;
}

async function main() {
  console.log(`Helix corpus seed → ${BACKEND}`);
  console.log(`  user: ${EMAIL}`);
  console.log(`  root: /${ROOT_FOLDER}/`);
  if (DRY) console.log("  --dry-run: counting only, no uploads");

  await healthCheck();
  const session: SignedInSession = DRY ? { cookie: "" } : await signIn();
  if (!DRY) console.log("  ✓ authenticated\n");

  const sources = ["apache-tika", "commonmark", "libreoffice", "picsum", "generated"];
  const files: DiscoveredFile[] = [];
  for (const src of sources) {
    const dir = path.join(HERE, src);
    if (!existsSync(dir)) continue;
    await walk(dir, dir, files, src);
  }
  console.log(`Discovered ${files.length} files (${formatBytes(totalSize(files))} total)\n`);
  if (DRY) {
    printByExtension(files);
    return;
  }

  // Build folder tree so every parent exists before we upload children.
  const folderCache = new Map<string, string | null>(); // path → folderId (null = root)
  folderCache.set("", null);
  await ensureFolderPath(session, ROOT_FOLDER, folderCache);
  for (const f of files) {
    const parentRel = path.dirname(f.rel);
    if (parentRel === "." || parentRel === "") continue;
    await ensureFolderPath(session, `${ROOT_FOLDER}/${parentRel}`, folderCache);
  }
  console.log(`  ✓ ${folderCache.size - 1} folders ready\n`);

  const stats = { ok: 0, exists: 0, fail: 0 };
  const queue = [...files];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => worker(session, queue, folderCache, stats, files.length)),
  );

  console.log(
    `\n\nDone. uploaded=${stats.ok} already-existed=${stats.exists} failed=${stats.fail}`,
  );
  printByExtension(files);
}

async function worker(
  session: SignedInSession,
  queue: DiscoveredFile[],
  folderCache: Map<string, string | null>,
  stats: { ok: number; exists: number; fail: number },
  total: number,
) {
  while (queue.length > 0) {
    const file = queue.shift();
    if (!file) break;
    try {
      const parentRel = path.dirname(file.rel) === "." ? "" : path.dirname(file.rel);
      const folderKey = parentRel.length > 0 ? `${ROOT_FOLDER}/${parentRel}` : ROOT_FOLDER;
      const folderId = folderCache.get(folderKey) ?? null;
      const name = path.basename(file.rel);
      const outcome = await uploadOne(session, name, folderId, file.abs);
      if (outcome === "exists") stats.exists += 1;
      else stats.ok += 1;
    } catch (err) {
      stats.fail += 1;
      console.warn(`  ✗ ${file.rel}: ${(err as Error).message}`);
    }
    const done = stats.ok + stats.exists + stats.fail;
    if (done % 25 === 0 || done === total) {
      process.stdout.write(
        `  ${done}/${total} (uploaded=${stats.ok} existed=${stats.exists} failed=${stats.fail})\r`,
      );
    }
  }
}

async function uploadOne(
  session: SignedInSession,
  name: string,
  folderId: string | null,
  abs: string,
): Promise<"ok" | "exists"> {
  const body = readFileSync(abs);
  const sha256 = sha256Hex(body);
  const mimeType = guessContentType(abs);

  // Phase 1 (reserve): drive.upload returns { objectId, storageKey, uploadUrl,
  // uploadHeaders }. When uploadUrl is non-null the storage backend supports
  // presigned PUT (RustFS does); we PUT bytes directly to it — the same pattern
  // Google Drive / OneDrive / Dropbox use. The API server never proxies bytes.
  // Falls back to inline base64 when uploadUrl is null (test env without
  // RustFS, BYO storage that doesn't support presign, etc).
  const reserve = await driveTool<{
    objectId: string;
    storageKey: string;
    uploadUrl: string | null;
    uploadHeaders?: Record<string, string>;
    alreadyExists?: boolean;
  }>(session, "drive.upload", {
    name,
    folderId,
    mimeType,
    byteSize: body.byteLength,
    sha256,
    metadata: { source: "corpus-seed" },
  });

  if (reserve.alreadyExists === true) return "exists";

  // Phase 2 (bytes): direct-to-storage if presigned URL available, else inline.
  let finalizePayload: Record<string, unknown>;
  if (reserve.uploadUrl) {
    const putRes = await fetch(reserve.uploadUrl, {
      method: "PUT",
      headers: { ...(reserve.uploadHeaders ?? {}), "content-type": mimeType },
      body: new Uint8Array(body),
    });
    if (!putRes.ok) {
      const text = await putRes.text().catch(() => "");
      throw new Error(`presigned PUT → HTTP ${putRes.status} ${text.slice(0, 200)}`);
    }
    finalizePayload = {
      objectId: reserve.objectId,
      byteSize: body.byteLength,
      sha256,
      mimeType,
      storageKey: reserve.storageKey,
      metadata: { source: "corpus-seed" },
    };
  } else {
    finalizePayload = {
      objectId: reserve.objectId,
      byteSize: body.byteLength,
      sha256,
      mimeType,
      storageKey: reserve.storageKey,
      contentBase64: body.toString("base64"),
      metadata: { source: "corpus-seed" },
    };
  }

  // Phase 3 (commit): drive.finalize verifies the object, creates the immutable
  // version row, fires the `drive.upload.finalized` audit event, and emits the
  // storage-delta metric. Identical signal whether bytes came inline or via
  // presigned URL — auditing/metrics parity is preserved.
  await driveTool(session, "drive.finalize", finalizePayload);
  return "ok";
}

/* Ensures a / -separated folder path exists under Drive root. Caches each
   intermediate path → folderId mapping. */
async function ensureFolderPath(
  session: SignedInSession,
  pathStr: string,
  cache: Map<string, string | null>,
): Promise<string> {
  if (cache.has(pathStr)) return cache.get(pathStr)!;
  const parts = pathStr.split("/").filter((p) => p.length > 0);
  let parentId: string | null = null;
  let cumulative = "";
  for (const part of parts) {
    cumulative = cumulative.length === 0 ? part : `${cumulative}/${part}`;
    if (cache.has(cumulative)) {
      parentId = cache.get(cumulative)!;
      continue;
    }
    const res = await driveTool<{ id: string }>(session, "drive.create", {
      kind: "folder",
      name: part,
      parentId,
    });
    parentId = res.id;
    cache.set(cumulative, parentId);
  }
  return parentId!;
}

async function driveTool<T = unknown>(
  session: SignedInSession,
  tool: string,
  payload: unknown,
): Promise<T> {
  const res = await fetch(`${BACKEND}/api/tools/${tool}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: session.cookie,
      origin: BACKEND,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${tool} → HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

async function healthCheck() {
  try {
    const res = await fetch(`${BACKEND}/healthz`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(`\n✗ Backend not reachable at ${BACKEND}: ${(err as Error).message}`);
    console.error(`  Start it with: pnpm --filter @helix/app dev`);
    process.exit(2);
  }
}

async function signIn(): Promise<SignedInSession> {
  const res = await fetch(`${BACKEND}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BACKEND },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(`Sign-in failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("Sign-in succeeded but no set-cookie header returned");
  }
  const cookie = setCookie
    .split(",")
    .map((c) => c.trim().split(";")[0]!)
    .join("; ");
  return { cookie };
}

async function walk(
  root: string,
  current: string,
  out: DiscoveredFile[],
  topLevel: string,
) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(current, e.name);
    if (e.isDirectory()) {
      await walk(root, abs, out, topLevel);
    } else if (e.isFile()) {
      const rel = path.join(topLevel, path.relative(root, abs)).replaceAll(path.sep, "/");
      out.push({ abs, rel, size: statSync(abs).size });
    }
  }
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function totalSize(files: ReadonlyArray<{ size: number }>): number {
  return files.reduce((acc, f) => acc + f.size, 0);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function printByExtension(files: ReadonlyArray<{ abs: string; size: number }>) {
  const byExt = new Map<string, { count: number; bytes: number }>();
  for (const f of files) {
    const ext = path.extname(f.abs).toLowerCase().slice(1) || "(none)";
    const cur = byExt.get(ext) ?? { count: 0, bytes: 0 };
    cur.count += 1;
    cur.bytes += f.size;
    byExt.set(ext, cur);
  }
  const rows = [...byExt.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log("\nBy extension:");
  console.log(`  ${"ext".padEnd(10)} ${"count".padStart(6)} ${"size".padStart(10)}`);
  for (const [ext, s] of rows.slice(0, 20)) {
    console.log(`  ${ext.padEnd(10)} ${String(s.count).padStart(6)} ${formatBytes(s.bytes).padStart(10)}`);
  }
}

function guessContentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".html": "text/html",
    ".htm": "text/html",
    ".xml": "application/xml",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".rtf": "application/rtf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".odp": "application/vnd.oasis.opendocument.presentation",
  };
  return map[ext] ?? "application/octet-stream";
}

main().catch((err) => {
  console.error("\nseed failed:", err);
  process.exit(1);
});
