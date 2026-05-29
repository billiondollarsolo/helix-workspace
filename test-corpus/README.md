# Helix test corpus

A reseedable, gitignored corpus of publicly-available test files for local dev.
Used to populate Drive / Docs / Sheets / Slides with realistic content so the
editors, viewers, search, and parser pipelines can be validated without
hand-creating sample data.

## Layout

```
test-corpus/
├── README.md           # this file (tracked)
├── manifest.json       # source URLs, licenses, expected file counts (tracked)
├── fetch.ts            # downloads everything from the manifest (tracked)
├── seed.ts             # uploads everything to the local Helix backend (tracked)
├── apache-tika/        # downloaded — Apache 2.0 (gitignored)
├── commonmark/         # downloaded — CC0 (gitignored)
├── libreoffice/        # downloaded — MPL 2.0 (gitignored)
└── picsum/             # downloaded — Unsplash license (gitignored)
```

## Usage

```sh
# 1) Download everything (one-time, ~10-15 min, ~90 MB)
pnpm corpus:fetch

# 2) Seed into the running local Helix backend (requires backend healthy +
#    RUSTFS storage reachable)
pnpm corpus:seed

# Re-running fetch is idempotent — it skips files already present.
# Re-running seed is idempotent — drive.upload reports alreadyExists by sha256.
```

## How seeding works (production ingest parity)

The seed uses the **same two-phase upload pattern** the Helix web client uses
(modeled on Google Drive's resumable / Dropbox upload_session pattern):

```
1. POST /api/auth/sign-in/email          ← authenticate, capture session cookie
2. POST /api/tools/drive.create          ← create the /test-corpus/ folder tree
3. for each file:
   a. POST /api/tools/drive.upload       ← reserve objectId + storage key (by sha256)
   b. POST /api/tools/drive.finalize     ← commit the first immutable version
```

Files seeded this way behave identically to user-uploaded files — same
versioning, same permissions model, same storage backend (RustFS), same
search indexing hooks.

This is **not** WebDAV. WebDAV is supported separately at `/dav/files/*` for
OS-level Finder / Nextcloud-style mount, but the modern programmatic ingest
path is the two-phase `drive.upload` + `drive.finalize`.

## Verified contents (post-fetch)

Total: **1272 files / ~86 MB** across 30+ extensions.

| Ext | Count | Size |
|---|---:|---:|
| md   | 655 | 215 KB |
| jpg  | 106 | 12.1 MB |
| docx |  56 | 1.5 MB |
| pdf  |  52 | 7.1 MB |
| doc  |  42 | 4.5 MB |
| rtf  |  40 | 2.1 MB |
| xlsx |  33 | 12.7 MB |
| xls  |  28 | 1.8 MB |
| pptx |  27 | 2.1 MB |
| html |  24 | 156 KB |
| ppt  |  21 | 2.5 MB |
| odt  |  15 | 3.9 MB |
| chm, msg, one, xps, xlsb, xmp, bpg, mdb, … | rest | — |

## Licenses

All sources are explicitly trusted public-domain or permissive-license
distributions. See `manifest.json` for per-source license + URL.

| Source | License | Format coverage |
|---|---|---|
| Apache Tika test docs | Apache 2.0 | docx, xlsx, pptx, odt, ods, odp, pdf, rtf, txt, html, eml, png, jpg, gif, chm, msg, one |
| LibreOffice samples (optional) | MPL 2.0 / LGPLv3 | docx, xlsx, pptx, odt, ods, odp |
| CommonMark spec examples | CC0 | md |
| Lorem Picsum | Unsplash license | jpg, png |

## Seed prerequisites

1. **Helix backend running**: `pnpm --filter @helix/app dev`
2. **RustFS reachable**: `docker compose up -d rustfs` (port 28437)
3. **Backend has `RUSTFS_ENDPOINT` env set** (or `RUSTFS_API_PORT` — `server.ts:1426`
   now derives the endpoint from `RUSTFS_API_PORT` when `RUSTFS_ENDPOINT` is absent)
4. **Local-demo user provisioned** (`local-admin@helix.local` / `helix-local-dev-password`)

Without (3), uploads will fail with `Tenant storage resolver did not resolve storage`.

## v2 follow-ups (not in this pass)

- **Native Doc/Sheet/Slide conversion**: today every file lands in Drive as a raw
  blob. A v2 seed would call `docs.import` / `sheets.import` / `slides.import` for
  the matching .docx/.xlsx/.pptx files so they appear as native editable items in
  the respective list pages.
- **Tarball cache**: the apache-tika fetch currently re-downloads the 165 MB
  tarball once per sub-source. A `.cache/` directory keyed by `ref` would
  download once and reuse for all 5 Tika sub-sources.
- **Tags/folders**: organize the seeded files into Drive folders by source +
  format (e.g. `/test-corpus/apache-tika/microsoft/docx/`) — script puts them
  flat by source today.

## Adding a new source

1. Add a `sources[]` entry to `manifest.json` with `url`, `license`, target
   directory, and a deterministic fetch strategy (`tarball`, `zip`, `repo`,
   `generated`, or `each-url`).
2. Add per-format ingestion logic to `seed.ts` if the format isn't already
   handled.
3. Run `pnpm corpus:fetch && pnpm corpus:seed`.
