import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDriveShareLink,
  createDriveWorkflow,
  deleteDriveObject,
  driveDownloadResult,
  drivePublicShareUrl,
  finalizeDriveUpload,
  listDrive,
  listDriveAccess,
  listDriveShareLinks,
  listDriveVersions,
  listDriveWorkflows,
  prepareDriveUpload,
  removeDriveAccess,
  renameDriveObject,
  revertDriveVersion,
  revokeDriveShareLink,
  searchDrive,
  shareDrive,
  trashDriveObject,
  transitionDriveWorkflow,
  updateDriveAccessRole,
  uploadDriveFile,
  type DriveApiEntry,
} from "./api";
import { driveItemsInputFromRouteSearch, validateDriveRouteSearch } from "./queries";

const localValues = new Map<string, string>();
const DRIVE_OBJECT_ID = "33333333-3333-4333-8333-333333333333";

function preparedBrowserUpload(
  file: File,
  input: {
    readonly storageKey: string;
    readonly uploadUrl?: string | null;
    readonly multipart?: {
      readonly uploadId: string;
      readonly partSize: number;
      readonly partCount: number;
      readonly partUrls: readonly string[];
      readonly expiresAt: string;
    };
  },
) {
  return {
    objectId: DRIVE_OBJECT_ID,
    orgId: "11111111-1111-4111-8111-111111111111",
    ownerActorId: "22222222-2222-4222-8222-222222222222",
    name: file.name,
    folderId: null,
    storageKey: input.storageKey,
    mimeType: file.type,
    byteSize: file.size,
    sha256: null,
    status: "prepared",
    uploadUrl: input.uploadUrl ?? null,
    uploadHeaders: {},
    metadata: {},
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
    ...(input.multipart === undefined ? {} : { multipart: input.multipart }),
  };
}

beforeEach(() => {
  localValues.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => localValues.set(key, value),
    removeItem: (key: string) => localValues.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("drive API", () => {
  it("uses the shared Drive workflow tool contract", async () => {
    const record = {
      id: "99999999-9999-4999-8999-999999999999",
      kind: "approval",
      resourceType: "object",
      resourceId: DRIVE_OBJECT_ID,
      requestedByActorId: "22222222-2222-4222-8222-222222222222",
      assignedToActorId: "66666666-6666-4666-8666-666666666666",
      state: "open",
      version: "1",
      payload: {},
      policySnapshot: {},
      dueAt: null,
      decidedAt: null,
      createdAt: "2026-09-03T12:00:00.000Z",
      updatedAt: "2026-09-03T12:00:00.000Z",
    } as const;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(record))
      .mockResolvedValueOnce(Response.json({ workflows: [record] }))
      .mockResolvedValueOnce(Response.json({ ...record, state: "approved", version: "2" }));

    const created = await createDriveWorkflow(
      {
        kind: "approval",
        resourceType: "object",
        resourceId: DRIVE_OBJECT_ID,
        assignedToActorId: record.assignedToActorId,
      },
      fetchImpl,
    );
    await expect(listDriveWorkflows("open", fetchImpl)).resolves.toEqual([record]);
    await expect(
      transitionDriveWorkflow(created, "approved", {}, fetchImpl),
    ).resolves.toMatchObject({
      state: "approved",
      version: "2",
    });
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "/api/tools/drive.workflow.create",
      "/api/tools/drive.workflow.list",
      "/api/tools/drive.workflow.transition",
    ]);
  });

  it("lists Drive entries through the drive.list tool", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          entries: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              type: "file",
              name: "report.pdf",
              folderId: null,
              ownerActorId: "22222222-2222-4222-8222-222222222222",
              mimeType: "application/pdf",
              byteSize: 128,
              preview: {
                kind: "pdf",
                status: "available",
                mimeType: "application/pdf",
                url: "https://cdn.example/report.pdf",
                pageCount: 3,
              },
              metadata: {},
              deletedAt: null,
              createdAt: "2026-05-20T12:00:00.000Z",
              updatedAt: "2026-05-20T12:00:00.000Z",
            },
          ],
          nextCursor: "next-page",
        }),
      ),
    );

    await expect(listDrive({ folderId: null }, fetchImpl)).resolves.toMatchObject({
      entries: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          preview: { kind: "pdf", status: "available", url: "https://cdn.example/report.pdf" },
        },
      ],
      nextCursor: "next-page",
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/drive.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folderId: null, includeTrashed: false, limit: 100 }),
    });
  });

  it("searches Drive and sends write-tool payloads", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({ hits: [] })));

    await expect(searchDrive({ query: "report" }, fetchImpl)).resolves.toEqual([]);
    await shareDrive(
      {
        objectId: "33333333-3333-4333-8333-333333333333",
        actorIds: ["66666666-6666-4666-8666-666666666666"],
        role: "reader",
      },
      fetchImpl,
    );
    await trashDriveObject("33333333-3333-4333-8333-333333333333", fetchImpl);

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/drive.search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "report", folderId: null, limit: 50 }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/tools/drive.share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objectId: "33333333-3333-4333-8333-333333333333",
        actorIds: ["66666666-6666-4666-8666-666666666666"],
        actorRefs: [],
        role: "reader",
        expiresAt: null,
      }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(3, "/api/tools/drive.trash", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objectId: "33333333-3333-4333-8333-333333333333" }),
    });
  });

  it("prepares and finalizes uploads with typed backend payloads", async () => {
    const sha256 = "a".repeat(64);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          objectId: "33333333-3333-4333-8333-333333333333",
          orgId: "11111111-1111-4111-8111-111111111111",
          ownerActorId: "22222222-2222-4222-8222-222222222222",
          name: "report.pdf",
          folderId: null,
          storageKey: "drive/111/report.pdf",
          mimeType: "application/pdf",
          byteSize: 128,
          sha256,
          status: "pending_upload",
          uploadUrl: "https://storage.example/upload",
          uploadHeaders: { "content-type": "application/pdf" },
          metadata: { source: "web-shell" },
          createdAt: "2026-05-20T12:00:00.000Z",
          updatedAt: "2026-05-20T12:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: "44444444-4444-4444-8444-444444444444",
          orgId: "11111111-1111-4111-8111-111111111111",
          objectId: "33333333-3333-4333-8333-333333333333",
          versionNumber: 1,
          storageKey: "drive/111/report.pdf",
          mimeType: "application/pdf",
          byteSize: 128,
          sha256,
          metadata: { source: "web-shell" },
          createdByActorId: "22222222-2222-4222-8222-222222222222",
          createdAt: "2026-05-20T12:01:00.000Z",
        }),
      );

    await expect(
      prepareDriveUpload(
        {
          name: "report.pdf",
          folderId: null,
          mimeType: "application/pdf",
          byteSize: 128,
          sha256,
          metadata: { source: "web-shell" },
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({ objectId: "33333333-3333-4333-8333-333333333333", sha256 });
    await expect(
      finalizeDriveUpload(
        {
          objectId: "33333333-3333-4333-8333-333333333333",
          byteSize: 128,
          sha256,
          mimeType: "application/pdf",
          metadata: { source: "web-shell" },
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({
      objectId: "33333333-3333-4333-8333-333333333333",
      versionNumber: 1,
      sha256,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/drive.upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "report.pdf",
        folderId: null,
        mimeType: "application/pdf",
        byteSize: 128,
        sha256,
        metadata: { source: "web-shell" },
      }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/tools/drive.finalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objectId: "33333333-3333-4333-8333-333333333333",
        byteSize: 128,
        sha256,
        mimeType: "application/pdf",
        metadata: { source: "web-shell" },
      }),
    });
  });

  it("streams browser uploads directly to storage without hashing or a base64 fallback", async () => {
    const storageFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          objectId: "33333333-3333-4333-8333-333333333333",
          orgId: "11111111-1111-4111-8111-111111111111",
          ownerActorId: "22222222-2222-4222-8222-222222222222",
          name: "Roadmap_photo.png",
          folderId: null,
          storageKey: "drive/111/Roadmap_photo.png",
          mimeType: "image/png",
          byteSize: 3,
          sha256: "0".repeat(64),
          status: "pending_upload",
          uploadUrl: "https://storage.example/upload",
          uploadHeaders: { "content-type": "image/png" },
          metadata: { source: "web-shell" },
          createdAt: "2026-05-20T12:00:00.000Z",
          updatedAt: "2026-05-20T12:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: "44444444-4444-4444-8444-444444444444",
          orgId: "11111111-1111-4111-8111-111111111111",
          objectId: "33333333-3333-4333-8333-333333333333",
          versionNumber: 1,
          storageKey: "drive/111/Roadmap_photo.png",
          mimeType: "image/png",
          byteSize: 3,
          sha256: "0".repeat(64),
          metadata: { source: "web-shell" },
          createdByActorId: "22222222-2222-4222-8222-222222222222",
          createdAt: "2026-05-20T12:01:00.000Z",
        }),
      );

    const file = new File(["png"], "Roadmap_photo.png", { type: "image/png" });
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");
    try {
      await expect(uploadDriveFile({ file, folderId: null }, fetchImpl)).resolves.toMatchObject({
        objectId: "33333333-3333-4333-8333-333333333333",
      });

      expect(storageFetch).toHaveBeenCalledWith("https://storage.example/upload", {
        method: "PUT",
        headers: { "content-type": "image/png" },
        body: file,
      });
      const finalizeBody = JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string) as Record<
        string,
        unknown
      >;
      expect(finalizeBody).toEqual({
        objectId: "33333333-3333-4333-8333-333333333333",
        byteSize: 3,
        mimeType: "image/png",
        idempotencyKey: "upload:33333333-3333-4333-8333-333333333333",
        metadata: { source: "web-shell" },
      });
      expect(arrayBuffer).not.toHaveBeenCalled();
    } finally {
      storageFetch.mockRestore();
    }
  });

  it("uploads Blob slices with bounded concurrency, retry, and authoritative part ETags", async () => {
    const file = new File(["abcdefghijklmn"], "archive.bin", {
      type: "application/octet-stream",
      lastModified: 1,
    });
    const urls = [
      "https://storage.example/1",
      "https://storage.example/2",
      "https://storage.example/3",
      "https://storage.example/4",
    ];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          preparedBrowserUpload(file, {
            storageKey: "drive/111/archive.bin",
            multipart: {
              uploadId: "upload-1",
              partSize: 4,
              partCount: 4,
              partUrls: urls,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          }),
        ),
      )
      .mockResolvedValueOnce(Response.json({}));
    const attempts = new Map<string, number>();
    const bodies: Blob[] = [];
    let active = 0;
    let maxActive = 0;
    const storageFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url =
        typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      attempts.set(url, (attempts.get(url) ?? 0) + 1);
      bodies.push(init?.body as Blob);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      if (url === urls[1] && attempts.get(url) === 1) {
        return new Response(null, { status: 503 });
      }
      return new Response(null, {
        headers: { etag: `"etag-${String(urls.indexOf(url) + 1)}"` },
      });
    });
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");

    try {
      await uploadDriveFile({ file, folderId: null }, fetchImpl);

      expect(maxActive).toBeLessThanOrEqual(3);
      expect(attempts.get(urls[1] ?? "")).toBe(2);
      expect(bodies.every((body) => body instanceof Blob && body.size <= 4)).toBe(true);
      expect(arrayBuffer).not.toHaveBeenCalled();
      const completion = JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string) as {
        parts: readonly { partNumber: number; etag: string }[];
        sha256?: string;
      };
      expect(completion.parts).toEqual([
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 3, etag: '"etag-3"' },
        { partNumber: 4, etag: '"etag-4"' },
      ]);
      expect(completion).not.toHaveProperty("sha256");
      expect(localValues.size).toBe(0);
    } finally {
      storageFetch.mockRestore();
    }
  });

  it("persists multipart progress, resumes without preparing again, and rejects a missing ETag", async () => {
    const file = new File(["abcdefgh"], "resume.bin", {
      type: "application/octet-stream",
      lastModified: 2,
    });
    const urls = ["https://storage.example/resume-1", "https://storage.example/resume-2"];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          preparedBrowserUpload(file, {
            storageKey: "drive/111/resume.bin",
            multipart: {
              uploadId: "upload-resume",
              partSize: 4,
              partCount: 2,
              partUrls: urls,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          }),
        ),
      )
      .mockResolvedValueOnce(Response.json({}));
    const attempts = new Map<string, number>();
    const storageFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      const url =
        typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      attempts.set(url, (attempts.get(url) ?? 0) + 1);
      if (url === urls[1] && attempts.get(url) === 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return new Response(null);
      }
      return new Response(null, {
        headers: { etag: url === urls[0] ? '"etag-1"' : '"etag-2"' },
      });
    });

    try {
      await expect(uploadDriveFile({ file, folderId: null }, fetchImpl)).rejects.toThrow(
        "did not return an ETag",
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(localValues.size).toBe(1);
      const saved = JSON.parse([...localValues.values()][0] ?? "{}") as {
        completed?: readonly { partNumber: number; etag: string }[];
      };
      expect(saved.completed).toEqual([{ partNumber: 1, etag: '"etag-1"' }]);

      await expect(uploadDriveFile({ file, folderId: null }, fetchImpl)).resolves.toMatchObject({
        objectId: "33333333-3333-4333-8333-333333333333",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[1]?.[0]).toBe("/api/tools/drive.upload.complete");
      expect(attempts.get(urls[0] ?? "")).toBe(1);
      expect(attempts.get(urls[1] ?? "")).toBe(2);
      expect(localValues.size).toBe(0);
    } finally {
      storageFetch.mockRestore();
    }
  });

  it("cancels an active storage upload and refuses an upload without a storage URL", async () => {
    const file = new File(["x"], "cancel.bin", { type: "application/octet-stream" });
    const controller = new AbortController();
    const cancelledFetch = vi.fn().mockResolvedValueOnce(
      Response.json(
        preparedBrowserUpload(file, {
          storageKey: "drive/111/cancel.bin",
          uploadUrl: "https://storage.example/cancel",
        }),
      ),
    );
    const storageFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_request, init) => {
        expect(init?.signal).toBe(controller.signal);
        await Promise.resolve();
        controller.abort();
        init?.signal?.throwIfAborted();
        return new Response(null);
      });

    try {
      await expect(
        uploadDriveFile({ file, folderId: null, signal: controller.signal }, cancelledFetch),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(cancelledFetch).toHaveBeenCalledTimes(1);
      expect(storageFetch).toHaveBeenCalledTimes(1);
    } finally {
      storageFetch.mockRestore();
    }

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(preparedBrowserUpload(file, { storageKey: "drive/111/cancel.bin" })),
      );
    await expect(uploadDriveFile({ file, folderId: null }, fetchImpl)).rejects.toThrow(
      "did not provide an upload URL",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("approves a confirmation-gated share inline and uses the executed output", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            status: "pending_confirmation",
            pending: { id: "55555555-5555-4555-8555-555555555555" },
          },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ status: "executed", output: { shared: true } }));

    await expect(
      shareDrive(
        {
          objectId: "33333333-3333-4333-8333-333333333333",
          actorIds: ["66666666-6666-4666-8666-666666666666"],
        },
        fetchImpl,
      ),
    ).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/drive.share", expect.anything());
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/api/tools/pending/55555555-5555-4555-8555-555555555555/approve",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
  });

  it("sends Drive share email/name refs for server-side actor resolution", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({ shared: true })));

    await shareDrive(
      {
        objectId: "33333333-3333-4333-8333-333333333333",
        actorRefs: ["maya@helix.local", "Maya Chen"],
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/drive.share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objectId: "33333333-3333-4333-8333-333333333333",
        actorIds: [],
        actorRefs: ["maya@helix.local", "Maya Chen"],
        role: "reader",
        expiresAt: null,
      }),
    });
  });

  it("lists and removes Drive access grants", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          grants: [
            {
              actorId: "66666666-6666-4666-8666-666666666666",
              role: "reader",
              displayName: "Maya Chen",
              email: "maya@helix.local",
              grantedByActorId: "22222222-2222-4222-8222-222222222222",
              expiresAt: null,
              createdAt: "2026-05-20T12:00:00.000Z",
              updatedAt: "2026-05-20T12:00:00.000Z",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          objectId: "33333333-3333-4333-8333-333333333333",
          actorId: "66666666-6666-4666-8666-666666666666",
          removed: true,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          objectId: "33333333-3333-4333-8333-333333333333",
          actorId: "66666666-6666-4666-8666-666666666666",
          grant: {
            actorId: "66666666-6666-4666-8666-666666666666",
            role: "editor",
            displayName: "Maya Chen",
            email: "maya@helix.local",
            grantedByActorId: "22222222-2222-4222-8222-222222222222",
            expiresAt: null,
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:01:00.000Z",
          },
        }),
      );

    await expect(
      listDriveAccess("33333333-3333-4333-8333-333333333333", fetchImpl),
    ).resolves.toHaveLength(1);
    await expect(
      removeDriveAccess(
        "33333333-3333-4333-8333-333333333333",
        "66666666-6666-4666-8666-666666666666",
        fetchImpl,
      ),
    ).resolves.toMatchObject({ removed: true });
    await expect(
      updateDriveAccessRole(
        "33333333-3333-4333-8333-333333333333",
        "66666666-6666-4666-8666-666666666666",
        "editor",
        fetchImpl,
      ),
    ).resolves.toMatchObject({ grant: { role: "editor" } });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/drive.access.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objectId: "33333333-3333-4333-8333-333333333333" }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/tools/drive.access.remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objectId: "33333333-3333-4333-8333-333333333333",
        actorId: "66666666-6666-4666-8666-666666666666",
      }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(3, "/api/tools/drive.access.update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objectId: "33333333-3333-4333-8333-333333333333",
        actorId: "66666666-6666-4666-8666-666666666666",
        role: "editor",
        expiresAt: null,
      }),
    });
  });

  it("approves a confirmation-gated permanent delete inline", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            status: "pending_confirmation",
            pending: { id: "55555555-5555-4555-8555-555555555555" },
          },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ status: "executed", output: { deleted: true } }));

    await expect(
      deleteDriveObject("33333333-3333-4333-8333-333333333333", fetchImpl),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces the Helix error envelope message", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json(
          { error: { code: "forbidden", message: "missing drive scope", traceId: "t1" } },
          { status: 403 },
        ),
      ),
    );

    await expect(listDrive({}, fetchImpl)).rejects.toThrow("missing drive scope");
  });

  it("renames, lists versions, reverts, and manages share links via tools", async () => {
    const objectId = "33333333-3333-4333-8333-333333333333";
    const version = {
      id: "44444444-4444-4444-8444-444444444444",
      orgId: "11111111-1111-4111-8111-111111111111",
      objectId,
      versionNumber: 2,
      storageKey: "drive/111/report.pdf",
      mimeType: "application/pdf",
      byteSize: 128,
      sha256: "a".repeat(64),
      metadata: {},
      createdByActorId: "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-05-20T12:01:00.000Z",
    };
    const link = {
      id: "55555555-5555-4555-8555-555555555555",
      orgId: "11111111-1111-4111-8111-111111111111",
      objectId,
      token: "p".repeat(43),
      role: "reader",
      expiresAt: null,
      passwordProtected: false,
      oneTime: false,
      allowedDomains: [],
      allowDownload: true,
      consumedAt: null,
      createdByActorId: "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-05-20T12:02:00.000Z",
      revokedAt: null,
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          id: objectId,
          type: "file",
          name: "renamed.pdf",
          folderId: null,
          ownerActorId: "22222222-2222-4222-8222-222222222222",
          metadata: {},
          deletedAt: null,
          createdAt: "2026-05-20T12:00:00.000Z",
          updatedAt: "2026-05-20T12:03:00.000Z",
        }),
      )
      .mockResolvedValueOnce(Response.json({ versions: [version] }))
      .mockResolvedValueOnce(Response.json(version))
      .mockResolvedValueOnce(Response.json(link))
      .mockResolvedValueOnce(Response.json({ links: [link] }))
      .mockResolvedValueOnce(Response.json({ id: link.id, revoked: true }));

    await expect(
      renameDriveObject({ objectId, name: "renamed.pdf" }, fetchImpl),
    ).resolves.toMatchObject({
      name: "renamed.pdf",
    });
    await expect(listDriveVersions(objectId, fetchImpl)).resolves.toEqual([version]);
    await expect(revertDriveVersion(objectId, 2, fetchImpl)).resolves.toMatchObject({
      versionNumber: 2,
    });
    await expect(createDriveShareLink({ objectId }, fetchImpl)).resolves.toMatchObject({
      token: "p".repeat(43),
    });
    await expect(listDriveShareLinks(objectId, fetchImpl)).resolves.toEqual([link]);
    await expect(revokeDriveShareLink(link.id, fetchImpl)).resolves.toEqual({
      id: link.id,
      revoked: true,
    });
    expect(drivePublicShareUrl("p".repeat(43), "https://app.example")).toBe(
      `https://app.example/v1/api/drive/share/${"p".repeat(43)}`,
    );

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/drive.rename", expect.anything());
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/api/tools/drive.versions.list",
      expect.anything(),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "/api/tools/drive.versions.revert",
      expect.anything(),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(4, "/api/tools/drive.link.create", expect.anything());
    expect(fetchImpl).toHaveBeenNthCalledWith(5, "/api/tools/drive.link.list", expect.anything());
    expect(fetchImpl).toHaveBeenNthCalledWith(6, "/api/tools/drive.link.revoke", expect.anything());
  });

  it("downloads stored files without a viewer or conversion", () => {
    const entry = {
      id: "folder/file",
      name: "Report.xlsx",
      mimeType: "application/octet-stream",
    } as DriveApiEntry;
    expect(driveDownloadResult(entry).url).toBe(
      "/v1/api/drive/objects/folder%2Ffile/content?download=1",
    );
  });

  it("surfaces backend tool errors", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ error: "missing drive scope" }, { status: 403 })),
    );

    await expect(listDrive({}, fetchImpl)).rejects.toThrow("missing drive scope");
  });

  it("surfaces backend upload errors", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ error: "invalid sha256" }, { status: 400 })),
    );

    await expect(
      finalizeDriveUpload(
        {
          objectId: "33333333-3333-4333-8333-333333333333",
          byteSize: 128,
          sha256: "not-a-sha",
        },
        fetchImpl,
      ),
    ).rejects.toThrow("invalid sha256");
  });
});

describe("drive route search", () => {
  it("normalizes route search params for Drive list prefetching", () => {
    const search = validateDriveRouteSearch({
      file: " ",
      id: "33333333-3333-4333-8333-333333333333",
      folder: " root ",
      includeTrashed: "true",
      q: "  budget  ",
    });

    expect(search).toEqual({
      file: "33333333-3333-4333-8333-333333333333",
      folder: undefined,
      includeTrashed: true,
      q: "budget",
    });
    expect(driveItemsInputFromRouteSearch(search)).toEqual({
      folderId: null,
      includeTrashed: true,
      query: "budget",
      limit: 50,
      scope: "trash",
    });
  });

  it("keeps folder route state in the same shape used by Drive queries", () => {
    const search = validateDriveRouteSearch({
      folder: "44444444-4444-4444-8444-444444444444",
      includeTrashed: "0",
      q: "",
    });

    expect(search).toEqual({
      file: undefined,
      folder: "44444444-4444-4444-8444-444444444444",
      includeTrashed: undefined,
      q: undefined,
    });
    expect(driveItemsInputFromRouteSearch(search)).toEqual({
      folderId: "44444444-4444-4444-8444-444444444444",
      includeTrashed: false,
      query: "",
      limit: 100,
      scope: "my",
    });
  });

  it("keeps Workspace-style Drive scopes from route state", () => {
    const search = validateDriveRouteSearch({
      folder: "44444444-4444-4444-8444-444444444444",
      scope: "starred",
    });

    expect(search).toEqual({
      file: undefined,
      folder: "44444444-4444-4444-8444-444444444444",
      includeTrashed: undefined,
      q: undefined,
      scope: "starred",
    });
    expect(driveItemsInputFromRouteSearch(search)).toEqual({
      folderId: null,
      includeTrashed: false,
      query: "",
      limit: 100,
      scope: "starred",
    });
  });

  it("keeps folder navigation inside Shared with me", () => {
    const search = validateDriveRouteSearch({
      folder: "44444444-4444-4444-8444-444444444444",
      scope: "shared",
    });
    expect(driveItemsInputFromRouteSearch(search)).toEqual({
      folderId: "44444444-4444-4444-8444-444444444444",
      includeTrashed: false,
      query: "",
      limit: 100,
      scope: "shared",
    });
  });

  it("ignores folder filters when route state is scoped to trash", () => {
    expect(
      driveItemsInputFromRouteSearch({
        folder: "44444444-4444-4444-8444-444444444444",
        includeTrashed: true,
      }),
    ).toEqual({
      folderId: null,
      includeTrashed: true,
      query: "",
      limit: 100,
      scope: "trash",
    });
  });
});
