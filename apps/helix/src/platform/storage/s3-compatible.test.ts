import { describe, expect, it } from "vitest";
import { createS3CompatibleStorage } from "./index.js";
import type { S3CompatibleStorageConfig, S3CompatibleStorageError } from "./index.js";

const now = () => new Date("2026-05-20T12:34:56.000Z");

interface FetchStub {
  readonly fetch: typeof fetch;
  readonly calls: FetchCall[];
}

type FetchCall = readonly [Parameters<typeof fetch>[0], Parameters<typeof fetch>[1]];
type FetchResponseFactory = (
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
) => Promise<Response> | Response;

function createFetchStub(
  factory: FetchResponseFactory = () => new Response(null, { status: 200 }),
): FetchStub {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push([input, init]);
    return factory(input, init);
  };
  return { fetch: fetchImpl, calls };
}

function storage(
  fetchImpl: typeof fetch = createFetchStub().fetch,
  config: Partial<S3CompatibleStorageConfig> = {},
) {
  return createS3CompatibleStorage({
    endpoint: "http://rustfs.local:9000",
    region: "us-east-1",
    bucket: "helix-objects",
    credentials: {
      accessKeyId: "test-access",
      secretAccessKey: "test-secret",
      sessionToken: "test-token",
    },
    fetch: fetchImpl,
    now,
    ...config,
  });
}

function firstUrlCall(stub: FetchStub): readonly [URL, RequestInit] {
  const call = stub.calls[0];
  if (call === undefined) {
    throw new Error("Expected fetch to be called");
  }
  const [input, init] = call;
  if (!(input instanceof URL) || init === undefined) {
    throw new Error("Expected fetch to be called with a URL and request init");
  }
  return [input, init];
}

function requestHeaders(init: RequestInit): Record<string, string> {
  if (
    init.headers === undefined ||
    init.headers instanceof Headers ||
    Array.isArray(init.headers)
  ) {
    throw new Error("Expected plain request headers");
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(init.headers)) {
    if (typeof value !== "string") {
      throw new Error(`Expected string request header for ${name}`);
    }
    headers[name] = value;
  }
  return headers;
}

describe("S3-compatible storage", () => {
  it("creates the configured bucket with a signed path-style request", async () => {
    const fetchStub = createFetchStub();

    await storage(fetchStub.fetch).ensureBucket();

    expect(fetchStub.calls).toHaveLength(1);
    const [url, init] = firstUrlCall(fetchStub);
    expect(url.toString()).toBe("http://rustfs.local:9000/helix-objects");
    expect(init.method).toBe("PUT");
    const headers = requestHeaders(init);
    expect(headers.authorization).toContain(
      "AWS4-HMAC-SHA256 Credential=test-access/20260520/us-east-1/s3/aws4_request",
    );
    expect(headers).toMatchObject({
      host: "rustfs.local:9000",
      "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "x-amz-date": "20260520T123456Z",
      "x-amz-security-token": "test-token",
    });
  });

  it("treats already-owned buckets as ready", async () => {
    const fetchStub = createFetchStub(() => {
      return new Response("<Error><Code>BucketAlreadyOwnedByYou</Code></Error>", {
        status: 409,
        statusText: "Conflict",
      });
    });

    await expect(storage(fetchStub.fetch).ensureBucket()).resolves.toBeUndefined();
  });

  it("puts objects through a signed path-style request", async () => {
    const fetchStub = createFetchStub();

    await storage(fetchStub.fetch).put({
      key: "org-1/file name.txt",
      body: new TextEncoder().encode("hello"),
      contentType: "text/plain",
      metadata: { Plugin: "demo" },
    });

    expect(fetchStub.calls).toHaveLength(1);
    const [url, init] = firstUrlCall(fetchStub);
    expect(url.toString()).toBe("http://rustfs.local:9000/helix-objects/org-1/file%20name.txt");
    expect(init.method).toBe("PUT");
    expect(init.body).toEqual(new TextEncoder().encode("hello"));
    const headers = requestHeaders(init);
    expect(headers.authorization).toContain(
      "AWS4-HMAC-SHA256 Credential=test-access/20260520/us-east-1/s3/aws4_request",
    );
    expect(headers).toMatchObject({
      "content-type": "text/plain",
      host: "rustfs.local:9000",
      "x-amz-content-sha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      "x-amz-date": "20260520T123456Z",
      "x-amz-meta-plugin": "demo",
      "x-amz-security-token": "test-token",
    });
  });

  it("gets objects and maps S3 metadata into the SDK storage shape", async () => {
    const fetchStub = createFetchStub(() => {
      return new Response("payload", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-amz-meta-owner": "agent-1",
        },
      });
    });

    const object = await storage(fetchStub.fetch).get("result.json");

    expect(object).toEqual({
      key: "result.json",
      body: new TextEncoder().encode("payload"),
      contentType: "application/json",
      metadata: { owner: "agent-1" },
    });
    expect(firstUrlCall(fetchStub)[1].method).toBe("GET");
  });

  it("sends configurable SSE-S3 headers on signed PUT requests", async () => {
    const fetchStub = createFetchStub();

    await storage(fetchStub.fetch, { serverSideEncryption: "AES256" }).put({
      key: "encrypted.txt",
      body: new TextEncoder().encode("encrypted"),
      contentType: "text/plain",
    });

    const headers = requestHeaders(firstUrlCall(fetchStub)[1]);
    expect(headers["x-amz-server-side-encryption"]).toBe("AES256");
    expect(headers.authorization).toContain(
      "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token;x-amz-server-side-encryption",
    );
  });

  it("returns null for missing objects", async () => {
    const fetchStub = createFetchStub(() => new Response(null, { status: 404 }));

    await expect(storage(fetchStub.fetch).get("missing")).resolves.toBeNull();
  });

  it("deletes objects through a signed request", async () => {
    const fetchStub = createFetchStub(() => new Response(null, { status: 204 }));

    await storage(fetchStub.fetch).delete("old-key");

    const [url, init] = firstUrlCall(fetchStub);
    expect(url.toString()).toBe("http://rustfs.local:9000/helix-objects/old-key");
    expect(init.method).toBe("DELETE");
    expect(requestHeaders(init).authorization).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
    );
  });

  it("creates deterministic presigned URLs without making a network call", async () => {
    const fetchStub = createFetchStub();

    const url = new URL(
      await storage(fetchStub.fetch).presignPutUrl("uploads/report.csv", {
        expiresSeconds: 60,
        contentType: "text/csv",
        metadata: { source: "test" },
      }),
    );

    expect(fetchStub.calls).toHaveLength(0);
    expect(url.origin).toBe("http://rustfs.local:9000");
    expect(url.pathname).toBe("/helix-objects/uploads/report.csv");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "test-access/20260520/us-east-1/s3/aws4_request",
    );
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260520T123456Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host;x-amz-meta-source");
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("test-token");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("signs configurable SSE-S3 headers into presigned PUT URLs", async () => {
    const fetchStub = createFetchStub();

    const url = new URL(
      await storage(fetchStub.fetch, { serverSideEncryption: "AES256" }).presignPutUrl(
        "uploads/encrypted.csv",
        {
          expiresSeconds: 60,
          contentType: "text/csv",
        },
      ),
    );

    expect(fetchStub.calls).toHaveLength(0);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-type;host;x-amz-server-side-encryption",
    );
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("throws a typed error for failed object operations", async () => {
    const fetchStub = createFetchStub(
      () => new Response("nope", { status: 403, statusText: "Forbidden" }),
    );

    await expect(storage(fetchStub.fetch).delete("blocked")).rejects.toMatchObject({
      name: "S3CompatibleStorageError",
      status: 403,
      statusText: "Forbidden",
    } satisfies Partial<S3CompatibleStorageError>);
  });
});
