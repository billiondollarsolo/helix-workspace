import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  registerWebhookVerificationDocsRoute,
  WEBHOOK_VERIFICATION_DOCS_MARKDOWN,
} from "./verification-docs.js";

describe("webhook verification docs", () => {
  it("serves verification snippets without taking over Swagger UI", async () => {
    const app = fastify();
    await app.register(swagger, {
      openapi: {
        info: { title: "Helix Platform API", version: "0.0.0" },
        openapi: "3.1.0",
      },
    });
    await registerWebhookVerificationDocsRoute(app);
    await app.register(swaggerUi, { routePrefix: "/docs" });

    const docs = await app.inject({ method: "GET", url: "/docs/webhooks/verify" });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers["content-type"]).toContain("text/markdown");
    expect(docs.body).toContain("t=<timestamp>,v1=<hex>");
    expect(docs.body).toContain("HMAC-SHA256");
    expect(docs.body).toContain("## JavaScript");
    expect(docs.body).toContain("## Python");
    expect(docs.body).toContain("## Go");
    expect(docs.body).toContain("## Ruby");
    expect(docs.body).toContain("## PHP");

    const swaggerResponse = await app.inject({ method: "GET", url: "/docs" });
    expect(swaggerResponse.statusCode).toBe(200);
    expect(swaggerResponse.headers["content-type"]).toContain("text/html");

    await app.close();
  });

  it("keeps the offline markdown artifact aligned with the served page", async () => {
    const docsPath = fileURLToPath(
      new URL("../../../../../docs/webhooks/verify.md", import.meta.url),
    );
    await expect(readFile(docsPath, "utf8")).resolves.toBe(WEBHOOK_VERIFICATION_DOCS_MARKDOWN);
  });
});
