import Fastify from "fastify";
import type postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebDavDriveStore } from "../drive/routes.js";
import { registerOnlyOfficeRoutes } from "./routes.js";
import { signOnlyOfficeJwt } from "./jwt.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const objectId = "44444444-4444-4444-8444-444444444444";
const jwtSecret = "onlyoffice-test-secret";

describe("OnlyOffice storage persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("finalizes saved DocumentServer bytes through the Drive store", async () => {
    const savedBytes = new Uint8Array([1, 2, 3, 4]);
    const finalizeCalls: Parameters<WebDavDriveStore["finalizeUpload"]>[0][] = [];
    const store = {
      finalizeUpload: async (input: Parameters<WebDavDriveStore["finalizeUpload"]>[0]) => {
        finalizeCalls.push(input);
        return {
          id: "version-1",
          orgId: input.orgId,
          objectId: input.objectId,
          versionNumber: 1,
          storageKey: "drive/test/doc.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          byteSize: input.byteSize,
          sha256: input.sha256,
          metadata: {},
          createdByActorId: input.actorId,
          createdAt: new Date("2026-05-20T12:00:00.000Z"),
        };
      },
    } as unknown as WebDavDriveStore;
    const sql = (() => {
      throw new Error("OnlyOffice save callbacks must not persist through direct SQL.");
    }) as unknown as postgres.Sql;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(savedBytes)),
    );

    const app = Fastify({ logger: false });
    await registerOnlyOfficeRoutes(app, {
      store,
      sql,
      jwtSecret,
      helixInternalUrl: "http://helix.test",
      resolveActor: async () => ({
        id: actorId,
        type: "user",
        orgId,
        email: "owner@example.com",
        displayName: "Owner",
      }),
    });

    const token = signOnlyOfficeJwt(
      {
        objectId,
        actorId,
        orgId,
        userDisplayName: "Owner",
        iat: 1,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      jwtSecret,
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/onlyoffice/callback/${encodeURIComponent(token)}`,
      payload: {
        status: 2,
        url: "https://document-server.test/save.docx",
        key: "edit-session-1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ error: 0 });
    expect(finalizeCalls).toHaveLength(1);
    expect(finalizeCalls[0]).toMatchObject({
      orgId,
      actorId,
      objectId,
      byteSize: savedBytes.byteLength,
      content: savedBytes,
      metadata: {
        source: "onlyoffice",
        status: 2,
        key: "edit-session-1",
      },
    });
    expect(finalizeCalls[0]?.sha256).toHaveLength(64);

    await app.close();
  });
});
