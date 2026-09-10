import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { actorFromRequest } from "../../api/test-actor.js";
import { createRecordingSql as sharedRecordingSql } from "../../test-support/recording-sql.js";
import { createNoopVirusScanner } from "../drive/scanning.js";
import {
  ChatAttachmentRejectedError,
  PostgresChatAttachmentStore,
  inspectImage,
  registerChatAttachmentRoutes,
  type ChatAttachmentStore,
} from "./attachments.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const roomId = "33333333-3333-4333-8333-333333333333";
const objectId = "44444444-4444-4444-8444-444444444444";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const gif = Buffer.from("GIF89a\u0001\u0000\u0001\u0000", "binary");
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);

describe("Chat attachment validation", () => {
  it("accepts verified image and animated GIF/WebP signatures", () => {
    expect(inspectImage("paste.png", "image/png", png)).toBe("image/png");
    expect(inspectImage("animated.gif", "image/gif", gif)).toBe("image/gif");
    expect(inspectImage("animated.webp", "image/webp", webp)).toBe("image/webp");
  });

  it("rejects disguised active content, MIME mismatches, and oversized images", () => {
    expect(() => inspectImage("payload.svg", "image/svg+xml", Buffer.from("<svg/>"))).toThrow(
      ChatAttachmentRejectedError,
    );
    expect(() => inspectImage("payload.svg", "image/png", png)).toThrow(
      ChatAttachmentRejectedError,
    );
    expect(() => inspectImage("fake.png", "image/png", gif)).toThrow(ChatAttachmentRejectedError);
    expect(() =>
      inspectImage("large.png", "image/png", Buffer.alloc(10 * 1024 * 1024 + 1)),
    ).toThrow("10 MiB");
  });

  it("fails closed before storage when antivirus is absent or no-op", async () => {
    const sql = fakeSql();
    const storageResolver = vi.fn();
    for (const virusScanner of [undefined, createNoopVirusScanner()]) {
      const store = new PostgresChatAttachmentStore(sql, { storageResolver, virusScanner });
      await expect(
        store.upload({
          orgId,
          actorId,
          roomId,
          filename: "paste.png",
          declaredMimeType: "image/png",
          bytes: png,
        }),
      ).rejects.toThrow("scanning is unavailable");
    }
    expect(storageResolver).not.toHaveBeenCalled();
  });

  it("rejects a malicious scanner verdict before storage", async () => {
    const sql = fakeSql();
    const storageResolver = vi.fn();
    const store = new PostgresChatAttachmentStore(sql, {
      storageResolver,
      virusScanner: { scan: vi.fn().mockResolvedValue({ clean: false, signature: "Eicar" }) },
    });
    await expect(
      store.upload({
        orgId,
        actorId,
        roomId,
        filename: "paste.png",
        declaredMimeType: "image/png",
        bytes: png,
      }),
    ).rejects.toThrow("Eicar");
    expect(storageResolver).not.toHaveBeenCalled();
  });

  it("rejects nonmembers before invoking the scanner", async () => {
    const scanner = { scan: vi.fn() };
    const store = new PostgresChatAttachmentStore(fakeSql(false), {
      storageResolver: vi.fn(),
      virusScanner: scanner,
    });
    await expect(
      store.upload({
        orgId,
        actorId,
        roomId,
        filename: "paste.png",
        declaredMimeType: "image/png",
        bytes: png,
      }),
    ).rejects.toThrow("Chat room not found");
    expect(scanner.scan).not.toHaveBeenCalled();
  });

  it("fails closed before staging when tenant storage cannot enforce encryption", async () => {
    const put = vi.fn();
    const store = new PostgresChatAttachmentStore(fakeSql(), {
      storageResolver: async () => ({
        client: { put, get: vi.fn(), delete: vi.fn() },
        managedBy: "helix-default",
        prefix: `tenants/${orgId}/`,
      }),
      virusScanner: { scan: vi.fn().mockResolvedValue({ clean: true }) },
    });

    await expect(
      store.upload({
        orgId,
        actorId,
        roomId,
        filename: "paste.png",
        declaredMimeType: "image/png",
        bytes: png,
      }),
    ).rejects.toThrow("storage encryption is unavailable");
    expect(put).not.toHaveBeenCalled();
  });
});

describe("Chat attachment routes", () => {
  it("uploads, serves safely, downloads, and promotes to Drive", async () => {
    const attachment = {
      objectId,
      source: "chat" as const,
      filename: "paste.png",
      mimeType: "image/png",
      byteSize: png.byteLength,
    };
    const store: ChatAttachmentStore = {
      upload: vi.fn().mockResolvedValue(attachment),
      open: vi.fn().mockResolvedValue({ ...attachment, bytes: png }),
      saveToDrive: vi.fn().mockResolvedValue({
        objectId: "55555555-5555-4555-8555-555555555555",
      }),
    };
    const app = fastify();
    await registerChatAttachmentRoutes(app, { store, actorFromRequest });
    const headers = {
      "x-helix-actor-id": actorId,
      "x-helix-org-id": orgId,
      "content-type": "image/png",
    };

    const upload = await app.inject({
      method: "POST",
      url: `/api/chat/rooms/${roomId}/attachments?filename=paste.png`,
      headers,
      payload: png,
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toEqual(attachment);
    expect(store.upload).toHaveBeenCalledWith({
      orgId,
      actorId,
      roomId,
      filename: "paste.png",
      declaredMimeType: "image/png",
      bytes: png,
    });

    const inline = await app.inject({
      method: "GET",
      url: `/api/chat/attachments/${objectId}/content`,
      headers,
    });
    expect(inline.statusCode).toBe(200);
    expect(inline.rawPayload).toEqual(png);
    expect(inline.headers).toMatchObject({
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
    });
    expect(inline.headers["content-disposition"]).toContain("inline;");

    const download = await app.inject({
      method: "GET",
      url: `/api/chat/attachments/${objectId}/content?download=1`,
      headers,
    });
    expect(download.headers["content-disposition"]).toContain("attachment;");

    const saved = await app.inject({
      method: "POST",
      url: `/api/chat/attachments/${objectId}/save-to-drive`,
      headers,
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toEqual({ objectId: "55555555-5555-4555-8555-555555555555" });
    await app.close();
  });

  it("requires an authenticated tenant actor", async () => {
    const store = {
      upload: vi.fn(),
      open: vi.fn(),
      saveToDrive: vi.fn(),
    } satisfies ChatAttachmentStore;
    const app = fastify();
    await registerChatAttachmentRoutes(app, { store, actorFromRequest });
    const response = await app.inject({
      method: "GET",
      url: `/api/chat/attachments/${objectId}/content`,
    });
    expect(response.statusCode).toBe(401);
    expect(store.open).not.toHaveBeenCalled();
    await app.close();
  });
});
const fakeSql = (allowed = true) =>
  sharedRecordingSql(({ text }) =>
    text.includes("helix_chat_attachment_room_access") ? [{ allowed }] : [],
  ).sql;
