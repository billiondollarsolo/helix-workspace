import fastify, { type InjectOptions } from "fastify";
import { expect, it } from "vitest";
import {
  FakeAppPasswordAuthenticator,
  FakeWebDavDriveStore,
  basic,
} from "../../test-support/webdav-drive.js";
import { registerDriveRoutes } from "./routes.js";

it("accepts rclone's untyped PROPFIND and exact file bytes without changing other API parsers", async () => {
  const app = fastify();
  await registerDriveRoutes(app, {
    store: new FakeWebDavDriveStore(),
    appPasswords: new FakeAppPasswordAuthenticator(),
    requireTls: false,
    bodyLimitBytes: 1024,
  });
  app.post("/json", async (request) => request.body);
  const authorization = basic("ada@example.test", "delete");
  try {
    const listing = await app.inject({
      method: "PROPFIND",
      url: "/dav/files/",
      headers: { authorization, depth: "1" },
      payload: Buffer.from('<propfind xmlns="DAV:"><allprop/></propfind>'),
    } as unknown as InjectOptions);
    expect(listing.statusCode).toBe(207);
    for (const contentType of ["application/pdf", "application/json", "text/plain", "image/png"]) {
      const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x0a, 0x80]);
      const path = "/dav/files/" + encodeURIComponent(contentType) + ".bin";
      const put = await app.inject({
        method: "PUT",
        url: path,
        headers: { authorization, "content-type": contentType },
        payload: bytes,
      });
      expect(put.statusCode).toBe(201);
      const get = await app.inject({ method: "GET", url: path, headers: { authorization } });
      expect(get.rawPayload).toEqual(bytes);
    }
    const tooLarge = await app.inject({
      method: "PUT",
      url: "/dav/files/large",
      headers: { authorization, "content-type": "image/png" },
      payload: Buffer.alloc(1025),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(
      (await app.inject({ method: "POST", url: "/json", payload: { intact: true } })).json(),
    ).toEqual({ intact: true });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/json",
          headers: { "content-type": "image/png" },
          payload: Buffer.from("binary"),
        })
      ).statusCode,
    ).toBe(415);
  } finally {
    await app.close();
  }
});
