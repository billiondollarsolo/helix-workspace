import { describe, expect, it } from "vitest";
import { operatorStorageFetch } from "./operator-fetch.js";
import { validatedPublicEndpoint } from "./s3-client-factory.js";
import { createS3CompatibleStorage } from "./s3-compatible.js";

describe("validatedPublicEndpoint", () => {
  it("is optional and normalizes a trailing slash", () => {
    expect(validatedPublicEndpoint(undefined, "https://rustfs:9000")).toBeUndefined();
    expect(validatedPublicEndpoint("  ", "https://rustfs:9000")).toBeUndefined();
    expect(validatedPublicEndpoint("https://files.example.com/", "https://rustfs:9000")).toBe(
      "https://files.example.com",
    );
  });

  it("refuses a plain-HTTP public address in front of a TLS store", () => {
    expect(() =>
      validatedPublicEndpoint("http://files.example.com", "https://rustfs:9000"),
    ).toThrow("must use HTTPS");
    expect(validatedPublicEndpoint("http://127.0.0.1:9000", "http://rustfs:9000")).toBe(
      "http://127.0.0.1:9000",
    );
  });
});

describe("presigned URLs for a private object store", () => {
  const base = {
    endpoint: "https://rustfs:9000",
    region: "eu-test",
    bucket: "helix-objects",
    credentials: { accessKeyId: "access-key-id", secretAccessKey: "secret-access-key-value" },
    forcePathStyle: true,
  } as const;

  it("signs browser URLs against the public endpoint and keeps the internal one otherwise", async () => {
    const internal = await createS3CompatibleStorage(base).presignPutUrl("tenants/a/file.txt");
    expect(new URL(internal).host).toBe("rustfs:9000");

    const published = await createS3CompatibleStorage({
      ...base,
      publicEndpoint: "https://workspace.example.com",
    }).presignPutUrl("tenants/a/file.txt");
    const url = new URL(published);
    expect(url.host).toBe("workspace.example.com");
    expect(url.pathname).toBe("/helix-objects/tenants/a/file.txt");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("host");
  });
});

describe("operatorStorageFetch", () => {
  it("reaches only the operator-configured store, even on a private single-label host", async () => {
    const fetchStore = operatorStorageFetch("https://rustfs:9000");
    // Another host is refused before any connection is attempted.
    await expect(fetchStore("https://metadata.internal/latest")).rejects.toMatchObject({
      code: "blocked_destination",
    });
    await expect(fetchStore("https://169.254.169.254/latest")).rejects.toMatchObject({
      code: "blocked_destination",
    });
  });
});
