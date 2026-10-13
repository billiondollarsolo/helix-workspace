import { describe, expect, it, vi } from "vitest";
import {
  createDriveShareLink,
  createDriveWorkflow,
  deleteDriveObject,
  driveItemUrl,
  driveRawDownloadUrl,
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
} from "./api";

const DRIVE_OBJECT_ID = "33333333-3333-4333-8333-333333333333";

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
        notify: true,
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
        notify: true,
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

  it("downloads files without a viewer, and links to items inside Drive", () => {
    const download = driveRawDownloadUrl({ id: "folder/file" });
    expect(download).toBe("/v1/api/drive/objects/folder%2Ffile/content?download=1");
    expect(driveItemUrl({ id: "a b", kind: "file" }, "https://h.test/")).toBe(
      "https://h.test/drive?file=a%20b",
    );
    expect(driveItemUrl({ id: "f1", kind: "folder" }, "https://h.test")).toBe(
      "https://h.test/drive?folder=f1",
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
