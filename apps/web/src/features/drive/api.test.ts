import { describe, expect, it, vi } from "vitest";
import {
  createDriveShareLink,
  deleteDriveObject,
  driveDownloadResult,
  drivePublicShareUrl,
  finalizeDriveUpload,
  listDrive,
  listDriveAccess,
  listDriveShareLinks,
  listDriveVersions,
  prepareDriveUpload,
  removeDriveAccess,
  renameDriveObject,
  revertDriveVersion,
  revokeDriveShareLink,
  searchDrive,
  shareDrive,
  trashDriveObject,
  updateDriveAccessRole,
  uploadDriveFile,
  type DriveApiEntry,
} from "./api";
import { driveItemsInputFromRouteSearch, validateDriveRouteSearch } from "./queries";

describe("drive API", () => {
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
        }),
      ),
    );

    await expect(listDrive({ folderId: null }, fetchImpl)).resolves.toMatchObject([
      {
        id: "33333333-3333-4333-8333-333333333333",
        preview: { kind: "pdf", status: "available", url: "https://cdn.example/report.pdf" },
      },
    ]);
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
          status: "prepared",
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
          storageKey: "drive/111/report.pdf",
          contentBase64: "cGRm",
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
        storageKey: "drive/111/report.pdf",
        contentBase64: "cGRm",
        metadata: { source: "web-shell" },
      }),
    });
  });

  it("commits browser uploads through finalize when presigned storage PUT is unavailable", async () => {
    const storageFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
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
          status: "prepared",
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

    try {
      await expect(
        uploadDriveFile(
          { file: new File(["png"], "Roadmap_photo.png", { type: "image/png" }), folderId: null },
          fetchImpl,
        ),
      ).resolves.toMatchObject({ objectId: "33333333-3333-4333-8333-333333333333" });

      expect(storageFetch).toHaveBeenCalledWith("https://storage.example/upload", {
        method: "PUT",
        headers: { "content-type": "image/png" },
        body: expect.any(ArrayBuffer),
      });
      const finalizeBody = JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string) as Record<
        string,
        unknown
      >;
      expect(finalizeBody).toMatchObject({
        objectId: "33333333-3333-4333-8333-333333333333",
        byteSize: 3,
        mimeType: "image/png",
        storageKey: "drive/111/Roadmap_photo.png",
        contentBase64: "cG5n",
        metadata: { source: "web-shell" },
      });
      expect(finalizeBody.sha256).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      storageFetch.mockRestore();
    }
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
      token: "pubtoken123",
      role: "reader",
      expiresAt: null,
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

    await expect(renameDriveObject({ objectId, name: "renamed.pdf" }, fetchImpl)).resolves.toMatchObject({
      name: "renamed.pdf",
    });
    await expect(listDriveVersions(objectId, fetchImpl)).resolves.toEqual([version]);
    await expect(revertDriveVersion(objectId, 2, fetchImpl)).resolves.toMatchObject({ versionNumber: 2 });
    await expect(createDriveShareLink({ objectId, role: "reader" }, fetchImpl)).resolves.toMatchObject({
      token: "pubtoken123",
    });
    await expect(listDriveShareLinks(objectId, fetchImpl)).resolves.toEqual([link]);
    await expect(revokeDriveShareLink(link.id, fetchImpl)).resolves.toEqual({
      id: link.id,
      revoked: true,
    });
    expect(drivePublicShareUrl("pubtoken123", "https://app.example")).toBe(
      "https://app.example/api/drive/share/pubtoken123",
    );

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/drive.rename", expect.anything());
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/tools/drive.versions.list", expect.anything());
    expect(fetchImpl).toHaveBeenNthCalledWith(3, "/api/tools/drive.versions.revert", expect.anything());
    expect(fetchImpl).toHaveBeenNthCalledWith(4, "/api/tools/drive.link.create", expect.anything());
    expect(fetchImpl).toHaveBeenNthCalledWith(5, "/api/tools/drive.link.list", expect.anything());
    expect(fetchImpl).toHaveBeenNthCalledWith(6, "/api/tools/drive.link.revoke", expect.anything());
  });

  it("resolves PDFs to the native viewer and other raw files to preview URLs", () => {
    const pdf: DriveApiEntry = {
      id: "obj-1",
      type: "file",
      name: "report.pdf",
      folderId: null,
      ownerActorId: null,
      mimeType: "application/pdf",
      metadata: {},
      deletedAt: null,
      createdAt: "2026-05-20T12:00:00.000Z",
      updatedAt: "2026-05-20T12:00:00.000Z",
    };
    expect(driveDownloadResult(pdf).url).toBe("/pdf/obj-1");
    expect(
      driveDownloadResult({
        ...pdf,
        folderId: "folder-eng",
      }).url,
    ).toBe("/pdf/obj-1?folder=folder-eng");
    expect(
      driveDownloadResult({
        ...pdf,
        preview: {
          kind: "pdf",
          status: "available",
          mimeType: "application/pdf",
          url: "https://cdn.example/report.pdf",
        },
      }).url,
    ).toBe("/pdf/obj-1");
    expect(
      driveDownloadResult({
        ...pdf,
        id: "text-1",
        name: "notes.txt",
        mimeType: "text/plain",
      }).url,
    ).toBe("/api/drive/objects/text-1/preview");
    expect(
      driveDownloadResult({
        ...pdf,
        id: "fake-pdf",
        name: "notes.pdf",
        mimeType: "text/plain",
      }).url,
    ).toBe("/api/drive/objects/fake-pdf/preview");
    expect(
      driveDownloadResult({
        ...pdf,
        id: "generic-pdf",
        name: "scanned-form.pdf",
        mimeType: "application/octet-stream",
      }).url,
    ).toBe("/api/drive/objects/generic-pdf/preview");
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
          contentBase64: "cGRm",
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
