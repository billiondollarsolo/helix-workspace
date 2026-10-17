import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createBetterAuthRequest } from "./better-auth-request.js";

describe("Better Auth request bridge", () => {
  it("preserves parsed OAuth forms, including repeated resource parameters", async () => {
    const app = fastify();
    app.addContentTypeParser("application/x-www-form-urlencoded", (_request, _payload, done) => {
      done(null, { code: "a+b&c", resource: ["https://a.test", "https://b.test"] });
    });
    app.post("/token", async (request) => {
      const forwarded = createBetterAuthRequest(request);
      const form = await forwarded.formData();
      return { code: form.get("code"), resources: form.getAll("resource") };
    });
    try {
      const result = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "ignored",
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({
        code: "a+b&c",
        resources: ["https://a.test", "https://b.test"],
      });
    } finally {
      await app.close();
    }
  });
});
