import { afterEach, describe, expect, it, vi } from "vitest";
import { docsListFromDriveQueryOptions } from "./queries";
import { filterDocuments } from "./doc-list";
import type { DocSummary } from "./data";

describe("docsListFromDriveQueryOptions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps external document extensions even when metadata has an extensionless title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          Response.json({
            entries: [
              driveEntry({
                id: "11111111-1111-4111-8111-111111111111",
                app: "docs",
                name: "Native brief.helixdoc",
                metadata: { title: "Native brief" },
              }),
              driveEntry({
                id: "22222222-2222-4222-8222-222222222222",
                app: "docs",
                name: "Uploaded brief.docx",
                mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                metadata: { title: "Uploaded brief", starred: true, sharedCount: 3 },
                preview: {
                  kind: "pdf",
                  status: "available",
                  mimeType: "application/pdf",
                  url: "https://cdn.example/uploaded-brief.pdf",
                },
              }),
              driveEntry({
                id: "33333333-3333-4333-8333-333333333333",
                app: null,
                name: "Legacy contract.doc",
                mimeType: "application/msword",
              }),
              driveEntry({
                id: "44444444-4444-4444-8444-444444444444",
                app: null,
                name: "Macro report.docm",
                mimeType: "application/vnd.ms-word.document.macroEnabled.12",
              }),
              driveEntry({
                id: "55555555-5555-4555-8555-555555555555",
                app: null,
                name: "Template.dotx",
                mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
              }),
              driveEntry({
                id: "66666666-6666-4666-8666-666666666666",
                app: null,
                name: "Policy.odt",
                mimeType: "application/vnd.oasis.opendocument.text",
              }),
              driveEntry({
                id: "77777777-7777-4777-8777-777777777777",
                app: null,
                name: "Rich notes.rtf",
                mimeType: "application/rtf",
              }),
              driveEntry({
                id: "88888888-8888-4888-8888-888888888888",
                app: null,
                name: "Plain notes.txt",
                mimeType: "text/plain",
              }),
              driveEntry({
                id: "99999999-9999-4999-8999-999999999999",
                app: null,
                name: "Export.html",
                mimeType: "text/html",
              }),
              driveEntry({
                id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                app: null,
                name: "Notes.md",
                mimeType: "text/markdown",
              }),
              driveEntry({
                id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                app: null,
                name: "Exported email.eml",
                mimeType: "message/rfc822",
              }),
              driveEntry({
                id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                app: null,
                name: "Deleted brief.docx",
                mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                deletedAt: "2026-05-22T12:00:00.000Z",
              }),
              driveEntry({
                id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                app: null,
                name: "Budget.xlsx",
                mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              }),
            ],
          }),
        ),
      ),
    );

    const options = docsListFromDriveQueryOptions({ limit: 10 });
    const rows = await (
      options.queryFn as unknown as () => Promise<
        readonly {
          readonly title: string;
          readonly mimeType?: string;
          readonly openMode?: "native" | "office";
          readonly preview?: { readonly url?: string };
          readonly starred?: boolean;
          readonly shared?: number;
          readonly deletedAt?: string | null;
        }[]
      >
    )();

    expect(rows.map((row) => row.title)).toEqual([
      "Native brief",
      "Uploaded brief.docx",
      "Legacy contract.doc",
      "Macro report.docm",
      "Template.dotx",
      "Policy.odt",
      "Rich notes.rtf",
      "Plain notes.txt",
      "Export.html",
      "Notes.md",
      "Exported email.eml",
      "Deleted brief.docx",
    ]);
    expect(rows.map((row) => row.openMode)).toEqual([
      "native",
      "office",
      "office",
      "office",
      "office",
      "office",
      "office",
      "office",
      "office",
      "office",
      "office",
      "office",
    ]);
    expect(rows[1]?.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(rows[1]?.preview?.url).toBe("https://cdn.example/uploaded-brief.pdf");
    expect(rows[1]?.starred).toBe(true);
    expect(rows[1]?.shared).toBe(3);
    expect(rows.at(-1)?.deletedAt).toBe("2026-05-22T12:00:00.000Z");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/tools/drive.list", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        folderId: null,
        includeTrashed: true,
        limit: 10,
        app: "docs",
        acrossFolders: true,
      }),
    });
  });

  it("filters live, shared, starred, and trashed documents from Drive metadata", () => {
    const documents: readonly DocSummary[] = [
      docRow({ id: "mine", title: "Mine", mine: true }),
      docRow({ id: "shared", title: "Shared", mine: false, owner: "Maya Chen" }),
      docRow({ id: "starred", title: "Starred", starred: true }),
      docRow({ id: "trash", title: "Trashed", deletedAt: "2026-05-22T12:00:00.000Z" }),
    ];

    expect(filterDocuments(documents, "all", "").map((document) => document.id)).toEqual([
      "mine",
      "shared",
      "starred",
    ]);
    expect(filterDocuments(documents, "shared", "").map((document) => document.id)).toEqual([
      "shared",
    ]);
    expect(filterDocuments(documents, "starred", "").map((document) => document.id)).toEqual([
      "starred",
    ]);
    expect(filterDocuments(documents, "trash", "").map((document) => document.id)).toEqual([
      "trash",
    ]);
  });

  it("uses Drive search for app search so matches outside the first page are visible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          Response.json({
            hits: [
              searchHit({
                objectId: "11111111-1111-4111-8111-111111111111",
                name: "Hidden proposal.docx",
                mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              }),
              searchHit({
                objectId: "22222222-2222-4222-8222-222222222222",
                name: "Hidden budget.xlsx",
                mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              }),
            ],
          }),
        ),
      ),
    );

    const options = docsListFromDriveQueryOptions({ limit: 51, query: "hidden" });
    const rows = await (options.queryFn as () => Promise<readonly DocSummary[]>)();

    expect(rows.map((row) => row.title)).toEqual(["Hidden proposal.docx"]);
    expect(rows[0]?.openMode).toBe("office");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/tools/drive.search", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "hidden",
        folderId: null,
        limit: 51,
      }),
    });
  });
});

function docRow(
  overrides: Partial<DocSummary> & { readonly id: string; readonly title: string },
): DocSummary {
  return {
    id: overrides.id,
    title: overrides.title,
    owner: overrides.owner ?? "You",
    modified: overrides.modified ?? "May 20",
    shared: overrides.shared ?? 1,
    folder: overrides.folder ?? "Product",
    starred: overrides.starred ?? false,
    mine: overrides.mine ?? true,
    deletedAt: overrides.deletedAt ?? null,
    source: overrides.source ?? "backend",
    formatLabel: overrides.formatLabel ?? "DOC",
    ...(overrides.mimeType === undefined ? {} : { mimeType: overrides.mimeType }),
    ...(overrides.preview === undefined ? {} : { preview: overrides.preview }),
    ...(overrides.editorEngine === undefined ? {} : { editorEngine: overrides.editorEngine }),
    ...(overrides.formatVersion === undefined ? {} : { formatVersion: overrides.formatVersion }),
    ...(overrides.openMode === undefined ? {} : { openMode: overrides.openMode }),
  };
}

function driveEntry(overrides: {
  readonly id: string;
  readonly app: string | null;
  readonly name: string;
  readonly mimeType?: string;
  readonly metadata?: Record<string, unknown>;
  readonly preview?: unknown;
  readonly deletedAt?: string | null;
}) {
  return {
    id: overrides.id,
    type: "file",
    name: overrides.name,
    folderId: null,
    ownerActorId: null,
    app: overrides.app,
    mimeType: overrides.mimeType ?? "application/vnd.helix.document",
    metadata: overrides.metadata ?? {},
    ...(overrides.preview === undefined ? {} : { preview: overrides.preview }),
    deletedAt: overrides.deletedAt ?? null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
  };
}

function searchHit(overrides: {
  readonly objectId: string;
  readonly name: string;
  readonly mimeType: string;
}) {
  return {
    objectId: overrides.objectId,
    name: overrides.name,
    mimeType: overrides.mimeType,
    byteSize: 1024,
    sha256: null,
    folderId: null,
    preview: "",
    updatedAt: "2026-05-20T12:00:00.000Z",
  };
}
