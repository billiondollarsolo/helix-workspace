import type { Actor } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import type { ResourceClassificationService } from "../platform/ai/classification/index.js";
import type { DlpGuard } from "../platform/dlp.js";
import type { DriveFileStreamResult, PostgresDriveStore } from "../platform/drive/index.js";
import { loadAssistantAttachments } from "./assistant-attachments.js";

const actor: Actor = { id: "actor", orgId: "org", type: "user", scopes: ["drive.read"] };
function setup(content = new TextEncoder().encode("Hello")) {
  const open = vi.fn<DriveFileStreamResult["open"]>().mockResolvedValue(content);
  const file: DriveFileStreamResult = {
    orgId: actor.orgId,
    byteSize: content.byteLength,
    etag: "version-1",
    open,
    entry: {
      id: "file",
      type: "file",
      name: "notes.txt",
      folderId: null,
      ownerActorId: actor.id,
      mimeType: "text/plain",
      metadata: { status: "ready" },
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
  const options = {
    driveStore: {
      openFile: vi.fn<PostgresDriveStore["openFile"]>().mockResolvedValue(file),
      canExportFile: vi.fn<PostgresDriveStore["canExportFile"]>().mockResolvedValue(true),
    },
    classifications: { get: vi.fn<ResourceClassificationService["get"]>().mockResolvedValue(null) },
    dlp: {
      evaluate: vi.fn<DlpGuard["evaluate"]>().mockResolvedValue({
        action: "allow",
        boundary: "api_agent",
        classification: "standard",
        findings: [],
        acknowledged: false,
      }),
    },
  };
  return { options, file, open };
}

describe("Assistant Drive attachment boundary", () => {
  it("uses Drive ACL/export checks and emits bounded untrusted text with canonical snapshots", async () => {
    const { options } = setup();
    const loaded = await loadAssistantAttachments(options, { actor, objectIds: ["file", "file"] });
    expect(options.driveStore.openFile).toHaveBeenCalledWith({
      orgId: "org",
      actorId: "actor",
      objectId: "file",
    });
    expect(options.driveStore.canExportFile).toHaveBeenCalledOnce();
    expect(loaded).toMatchObject([
      {
        attachment: { objectId: "file", name: "notes.txt", byteSize: 5 },
        source: { body: "Hello", trust: "untrusted_retrieved", provenance: { orgId: "org" } },
      },
    ]);
  });

  it.each(["pending_upload", "scanning", "quarantined", "scan_failed", undefined])(
    "rejects unscanned state %s before opening bytes",
    async (status) => {
      const { options, file, open } = setup();
      options.driveStore.openFile.mockResolvedValue({
        ...file,
        entry: { ...file.entry, metadata: status === undefined ? {} : { status } },
      });
      await expect(
        loadAssistantAttachments(options, { actor, objectIds: ["file"] }),
      ).rejects.toThrow("not passed scanning");
      expect(open).not.toHaveBeenCalled();
    },
  );

  it("rejects inaccessible, cross-tenant and export-restricted files", async () => {
    const { options, file, open } = setup();
    options.driveStore.openFile.mockResolvedValueOnce(null);
    await expect(loadAssistantAttachments(options, { actor, objectIds: ["file"] })).rejects.toThrow(
      "unavailable",
    );
    options.driveStore.openFile.mockResolvedValueOnce({ ...file, orgId: "other-org" });
    await expect(loadAssistantAttachments(options, { actor, objectIds: ["file"] })).rejects.toThrow(
      "not found",
    );
    options.driveStore.canExportFile.mockResolvedValue(false);
    await expect(loadAssistantAttachments(options, { actor, objectIds: ["file"] })).rejects.toThrow(
      "Export",
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("loads images and PDFs and rejects other binaries", async () => {
    const png = Uint8Array.from([137, 80, 78, 71]);
    const { options, file, open } = setup(png);
    options.driveStore.openFile.mockResolvedValueOnce({
      ...file,
      byteSize: png.byteLength,
      entry: { ...file.entry, name: "photo.png", mimeType: "image/png" },
    });
    const image = await loadAssistantAttachments(options, { actor, objectIds: ["file"] });
    expect(image[0]?.source.media).toMatchObject({ mimeType: "image/png" });
    expect(image[0]?.source.body).toContain("Image attachment");
    const pdf = new TextEncoder().encode("%PDF-1.4 (Hello Gaithersburg)");
    options.driveStore.openFile.mockResolvedValueOnce({
      ...file,
      byteSize: pdf.byteLength,
      entry: { ...file.entry, name: "report.pdf", mimeType: "application/pdf" },
    });
    open.mockResolvedValueOnce(pdf);
    const loadedPdf = await loadAssistantAttachments(options, { actor, objectIds: ["file"] });
    expect(loadedPdf[0]?.source.body).toContain("Hello Gaithersburg");
    options.driveStore.openFile.mockResolvedValueOnce({
      ...file,
      entry: { ...file.entry, name: "archive.zip", mimeType: "application/zip" },
    });
    await expect(loadAssistantAttachments(options, { actor, objectIds: ["file"] })).rejects.toThrow(
      "images, or PDFs",
    );
    open.mockResolvedValueOnce(new Uint8Array([255]));
    await expect(loadAssistantAttachments(options, { actor, objectIds: ["file"] })).rejects.toThrow(
      "UTF-8",
    );
    open.mockResolvedValueOnce(new Uint8Array([0]));
    await expect(loadAssistantAttachments(options, { actor, objectIds: ["file"] })).rejects.toThrow(
      "binary data",
    );
  });

  it("enforces byte and character limits even when storage metadata understates the stream", async () => {
    const { options, open } = setup();
    open.mockResolvedValueOnce(new Uint8Array(10 * 1024 * 1024 + 1));
    await expect(loadAssistantAttachments(options, { actor, objectIds: ["file"] })).rejects.toThrow(
      "limit",
    );
    expect(options.dlp.evaluate).not.toHaveBeenCalled();
    open.mockResolvedValueOnce(new TextEncoder().encode("a".repeat(100_001)));
    const paged = await loadAssistantAttachments(options, { actor, objectIds: ["file"] });
    expect(paged[0]?.source.body?.length).toBe(100_001);
    expect(options.dlp.evaluate).toHaveBeenCalled();
  });

  it("preserves a stored restrictive classification even when text and DLP classify it lower", async () => {
    const { options } = setup();
    options.classifications.get.mockResolvedValue({
      orgId: actor.orgId,
      resourceType: "drive.file",
      resourceId: "file",
      classification: "restricted",
      source: "explicit",
      reason: "Policy",
      updatedAt: new Date().toISOString(),
    });
    const loaded = await loadAssistantAttachments(options, { actor, objectIds: ["file"] });
    expect(loaded[0]?.source.classification).toBe("restricted");
    expect(options.classifications.get).toHaveBeenCalledWith({
      orgId: actor.orgId,
      resourceType: "drive.file",
      resourceId: "file",
    });
    expect(options.dlp.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: actor.orgId, actorId: actor.id, boundary: "api_agent" }),
    );
  });

  it("rejects a configured DLP warning rather than sending the file without acknowledgement", async () => {
    const { options } = setup();
    options.dlp.evaluate.mockResolvedValue({
      action: "warn",
      boundary: "api_agent",
      classification: "confidential",
      findings: [],
      acknowledged: false,
    });
    await expect(loadAssistantAttachments(options, { actor, objectIds: ["file"] })).rejects.toThrow(
      "acknowledgement",
    );
  });
});
