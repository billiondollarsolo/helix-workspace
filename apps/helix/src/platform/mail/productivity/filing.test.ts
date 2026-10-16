import { describe, expect, it, vi } from "vitest";
import { fileMailAttachment } from "./filing.js";
import type { MailProductivityService } from "./service.js";

function setup() {
  const actor = { id: "actor", orgId: "org", type: "user" as const };
  const input = {
    threadId: "thread",
    messageId: "message",
    objectId: "source",
    folderId: "folder",
  };
  const row = {
    id: "claim",
    object_id: null,
    kind: "filing",
    source_key: "source",
    status: "working",
    body: "",
    error: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
  const classifyFile = vi.fn().mockResolvedValue(undefined);
  const finalizeUpload = vi.fn().mockImplementation(() => {
    expect(classifyFile).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: "copy",
        derivation: { explicit: "restricted", path: "invoice.pdf" },
      }),
    );
    return Promise.resolve({});
  });
  const fail = vi.fn().mockResolvedValue(undefined);
  const service = {
    thread: vi
      .fn()
      .mockResolvedValue({ messages: [{ id: "message", attachments: [{ objectId: "source" }] }] }),
    options: {
      classifyThread: vi.fn().mockResolvedValue("restricted"),
      classifyFile,
      mail: {
        readMessageAttachment: vi.fn().mockResolvedValue({
          content: Buffer.from("test bytes"),
          mimeType: "application/pdf",
          filename: "invoice.pdf",
        }),
      },
      drive: { prepareUpload: vi.fn().mockResolvedValue({ objectId: "copy" }), finalizeUpload },
      store: {
        claim: vi.fn().mockResolvedValue(row),
        setObject: vi.fn().mockResolvedValue(undefined),
        finish: vi.fn().mockResolvedValue(undefined),
        fail,
        find: vi.fn().mockResolvedValue(row),
      },
    },
  } as unknown as MailProductivityService;
  return { actor, input, service, classifyFile, finalizeUpload, fail };
}
describe("attachment filing classification", () => {
  it("persists the source classification before finalizing a new file", async () => {
    const h = setup();
    await fileMailAttachment(h.service, h.actor, h.input);
    expect(h.finalizeUpload).toHaveBeenCalledOnce();
    expect(h.fail).not.toHaveBeenCalled();
  });
  it("never makes a copy available when inherited classification cannot be saved", async () => {
    const h = setup();
    h.classifyFile.mockRejectedValue(new Error("Classification unavailable"));
    await expect(fileMailAttachment(h.service, h.actor, h.input)).rejects.toThrow(
      "Classification unavailable",
    );
    expect(h.finalizeUpload).not.toHaveBeenCalled();
    expect(h.fail).toHaveBeenCalledOnce();
  });
});
