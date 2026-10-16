import { errorEnvelopeSchema } from "@helix/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../api/api-error.js";
import { TenantResolutionError } from "../platform/tenancy/context.js";
import { installHttp } from "./http.js";

describe("HTTP error contract", () => {
  let app: FastifyInstance;
  afterEach(async () => app.close());

  it("prevents proxy transformations of DAV validators and signed S3 content", async () => {
    ({ app } = await installHttp());
    const paths = [
      "/v1/dav/cal/event.ics",
      "/v1/dav/card/contact.vcf",
      "/v1/dav/files/a",
      "/v1/s3/my-drive/a",
    ];
    for (const url of paths) {
      app.get(url, async (_request, reply) => reply.header("etag", '"revision-1"').send("content"));
    }
    for (const url of paths) {
      const response = await app.inject({ url });
      expect(response.headers["cache-control"]).toBe("private, no-store, no-transform");
      expect(response.headers.etag).toBe('"revision-1"');
    }
  });

  it("normalizes framework, tenant, direct REST and internal failures without exposing secrets", async () => {
    ({ app } = await installHttp());
    app.post("/api/body", async () => ({}));
    app.get("/api/tenant", async () => {
      throw new TenantResolutionError(423, "tenant-suspended", "Workspace suspended");
    });
    app.get("/api/domain", async () => {
      throw new ApiError("forbidden", "Access denied");
    });
    app.get("/api/direct", async (_request, reply) =>
      reply.code(429).send({ error: "Quota reached", code: "quota_exceeded", limit: 3 }),
    );
    app.get("/api/private", async () => {
      throw new Error("password=must-not-leak");
    });
    for (const [url, method, headers, payload, status, code] of [
      ["/api/body", "POST", { "content-type": "application/json" }, "{", 400, "bad_request"],
      [
        "/api/body",
        "POST",
        { "content-type": "application/xml" },
        "<x/>",
        415,
        "unsupported_media_type",
      ],
      ["/api/tenant", "GET", {}, undefined, 423, "tenant-suspended"],
      ["/api/domain", "GET", {}, undefined, 403, "forbidden"],
      ["/api/direct", "GET", {}, undefined, 429, "quota_exceeded"],
      ["/api/private", "GET", {}, undefined, 500, "internal_error"],
      ["/missing", "GET", {}, undefined, 404, "not_found"],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode).toBe(status);
      expect(errorEnvelopeSchema.parse(response.json()).error).toMatchObject({
        code,
        traceId: expect.any(String),
      });
      expect(response.body).not.toContain("must-not-leak");
    }
  });

  it("preserves native OAuth, auth-provider and WebDAV responses", async () => {
    ({ app } = await installHttp());
    for (const url of ["/oauth/token", "/api/auth/sign-in/email", "/dav/file"]) {
      app.post(url, async (_request, reply) =>
        reply
          .code(400)
          .send({ error: "invalid_request", error_description: "Native protocol response" }),
      );
    }
    for (const url of ["/oauth/token", "/api/auth/sign-in/email", "/dav/file"]) {
      const response = await app.inject({ method: "POST", url });
      expect(response.json()).toEqual({
        error: "invalid_request",
        error_description: "Native protocol response",
      });
    }
  });
});
