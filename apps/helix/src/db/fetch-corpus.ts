/* fetch-corpus.ts
 *
 * Downloads each manifest entry's source content into seed/corpus-cache/.
 * Idempotent: skips items whose cached content hash matches the manifest's
 * last-known hash. Run this once after a manifest change; the cached files
 * are then replayed offline by seed-corpus.ts on every db reset.
 *
 * Each fetcher writes:
 *   seed/corpus-cache/<manifestId>/content.{ext}    -- the raw payload
 *   seed/corpus-cache/<manifestId>/metadata.json    -- url, content-type,
 *                                                     sha256, fetched_at
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_PATH = resolve(import.meta.dirname, "..", "..", "seed", "corpus", "manifest.json");
const CACHE_ROOT = resolve(import.meta.dirname, "..", "..", "seed", "corpus-cache");

interface ManifestSource {
  readonly type: "wikipedia" | "url";
  readonly article?: string;
  readonly url?: string;
  readonly license?: string;
}

interface ManifestItem {
  readonly manifestId: string;
  readonly kind: string;
  readonly title: string;
  readonly source: ManifestSource;
}

interface Manifest {
  readonly version: number;
  readonly items: readonly ManifestItem[];
}

interface CachedMetadata {
  readonly manifestId: string;
  readonly url: string;
  readonly contentType: string;
  readonly fetchedAt: string;
  readonly sha256: string;
  readonly extension: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

interface FetchResult {
  readonly url: string;
  readonly contentType: string;
  readonly body: Buffer;
  readonly extension: string;
}

/** Fetch a Wikipedia article via the REST API. Returns clean plain-text
 *  extract (no wikitext markup) which is what we want to feed into the docs
 *  editor's Yjs state via the existing markdown→Yjs converter. */
async function fetchWikipedia(article: string): Promise<FetchResult> {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(article)}`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "helix-seed-corpus/1.0 (https://helix.local; dev@helix.local)",
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`wikipedia ${article} → HTTP ${String(response.status)}`);
  }
  const json = (await response.json()) as {
    readonly title?: string;
    readonly description?: string;
    readonly extract?: string;
    readonly content_urls?: { readonly desktop?: { readonly page?: string } };
  };
  // Compose a markdown document from the summary fields. Real text, clearly
  // attributable, no fabricated facts.
  const lines = [
    `# ${json.title ?? article}`,
    "",
    json.description ? `_${json.description}_` : null,
    "",
    "## Summary",
    "",
    json.extract ?? "_(no summary available)_",
    "",
    "---",
    "",
    "**Source:** Wikipedia, [the free encyclopedia](" +
      (json.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${article}`) +
      ")",
    "**License:** Content is available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) unless otherwise noted.",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");

  return {
    url,
    contentType: "text/markdown; charset=utf-8",
    body: Buffer.from(lines, "utf8"),
    extension: "md",
  };
}

interface ManifestItemWithFormat extends ManifestItem {
  readonly mimeType?: string;
  readonly originalFormat?: string;
}

async function fetchItem(item: ManifestItemWithFormat): Promise<FetchResult> {
  if (item.source.type === "wikipedia" && item.source.article !== undefined) {
    return fetchWikipedia(item.source.article);
  }
  if (item.source.type === "url" && item.source.url !== undefined) {
    const response = await fetch(item.source.url, {
      redirect: "follow",
      headers: {
        // Wikimedia and other public CDNs reject bare or generic UAs.
        // Use the conventional bot identifier with a contact handle.
        "user-agent": "HelixSeedBot/1.0 (https://helix.local; mailto:dev@helix.local)",
        accept: "*/*",
      },
    });
    if (!response.ok) {
      throw new Error(`${item.manifestId} → HTTP ${String(response.status)} from ${item.source.url}`);
    }
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const body = Buffer.from(await response.arrayBuffer());
    // Prefer the manifest's explicit `originalFormat` for the cached file
    // extension; otherwise sniff the URL path; otherwise fall back to the
    // content-type → extension table.
    const extension =
      item.originalFormat?.toLowerCase() ??
      extensionFromUrl(item.source.url) ??
      extensionFromContentType(contentType) ??
      "bin";
    return { url: item.source.url, contentType, body, extension };
  }
  throw new Error(`${item.manifestId}: unsupported source.type ${item.source.type}`);
}

function extensionFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf(".");
    if (dot < 0) return null;
    const ext = pathname.slice(dot + 1).toLowerCase();
    if (ext.length === 0 || ext.length > 6 || !/^[a-z0-9]+$/i.test(ext)) return null;
    return ext;
  } catch {
    return null;
  }
}

function extensionFromContentType(contentType: string): string | null {
  if (contentType.includes("pdf")) return "pdf";
  if (contentType.includes("officedocument.wordprocessingml")) return "docx";
  if (contentType.includes("officedocument.spreadsheetml")) return "xlsx";
  if (contentType.includes("officedocument.presentationml")) return "pptx";
  if (contentType.includes("csv")) return "csv";
  if (contentType.includes("zip")) return "zip";
  if (contentType.includes("json")) return "json";
  if (contentType.includes("html")) return "html";
  if (contentType.includes("text/plain")) return "txt";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg")) return "jpg";
  return null;
}

async function ensureCached(item: ManifestItem): Promise<{ skipped: boolean; hash: string }> {
  const itemDir = resolve(CACHE_ROOT, item.manifestId);
  const metaPath = resolve(itemDir, "metadata.json");
  // Cheap idempotency: if metadata exists and content file matches its hash,
  // skip the network fetch entirely.
  if (await exists(metaPath)) {
    const cached = JSON.parse(await readFile(metaPath, "utf8")) as CachedMetadata;
    const contentPath = resolve(itemDir, `content.${cached.extension}`);
    if (await exists(contentPath)) {
      const buf = await readFile(contentPath);
      if (sha256(buf) === cached.sha256) {
        return { skipped: true, hash: cached.sha256 };
      }
    }
  }

  const fetched = await fetchItem(item);
  const hash = sha256(fetched.body);
  const contentPath = resolve(itemDir, `content.${fetched.extension}`);
  await mkdir(dirname(contentPath), { recursive: true });
  await writeFile(contentPath, fetched.body);
  const meta: CachedMetadata = {
    manifestId: item.manifestId,
    url: fetched.url,
    contentType: fetched.contentType,
    fetchedAt: new Date().toISOString(),
    sha256: hash,
    extension: fetched.extension,
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
  return { skipped: false, hash };
}

async function main(): Promise<void> {
  const manifestRaw = await readFile(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(manifestRaw) as Manifest;
  const stats = { fetched: 0, skipped: 0, failed: 0 };
  for (const item of manifest.items) {
    try {
      const result = await ensureCached(item);
      if (result.skipped) {
        stats.skipped += 1;
        process.stdout.write(`  ${item.manifestId.padEnd(50)} (cached, sha256 ${result.hash.slice(0, 12)}…)\n`);
      } else {
        stats.fetched += 1;
        process.stdout.write(`✓ ${item.manifestId.padEnd(50)} fetched (sha256 ${result.hash.slice(0, 12)}…)\n`);
      }
    } catch (error) {
      stats.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`✗ ${item.manifestId}: ${message}\n`);
    }
  }
  process.stdout.write(
    `\nfetch-corpus: fetched=${String(stats.fetched)} skipped=${String(stats.skipped)} failed=${String(stats.failed)} (total ${String(manifest.items.length)})\n`,
  );
  if (stats.failed > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
