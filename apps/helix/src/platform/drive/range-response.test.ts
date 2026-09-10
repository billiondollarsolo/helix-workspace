import fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  parseRangeHeader,
  sendBytesWithRangeSupport,
  sendStreamWithRangeSupport,
} from "./range-response.js";

describe("parseRangeHeader", () => {
  it("parses bytes=0-99", () => {
    expect(parseRangeHeader("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
  });
  it("parses open-ended bytes=500-", () => {
    expect(parseRangeHeader("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
  });
  it("parses suffix bytes=-200", () => {
    expect(parseRangeHeader("bytes=-200", 1000)).toEqual({ start: 800, end: 999 });
  });
  it("clamps end past total", () => {
    expect(parseRangeHeader("bytes=0-5000", 1000)).toEqual({ start: 0, end: 999 });
  });
  it("marks multi-range unsupported", () => {
    expect(parseRangeHeader("bytes=0-10,20-30", 1000)).toBeNull();
  });
  it("marks start>=total invalid", () => {
    expect(parseRangeHeader("bytes=1000-1001", 1000)).toBeNull();
  });
  it("marks total=0 invalid", () => {
    expect(parseRangeHeader("bytes=0-0", 0)).toBeNull();
  });
  it("marks garbage invalid", () => {
    expect(parseRangeHeader("chunks=0-1", 1000)).toBeNull();
  });
  it.each([
    "bytes=1x-2",
    "bytes=+1-2",
    "bytes=1.0-2",
    "bytes=--2",
    "bytes=-0",
    "bytes=-",
    "bytes=9007199254740992-",
  ])("rejects malformed or unsafe integer range %s", (header) => {
    expect(parseRangeHeader(header, 1000)).toBeNull();
  });
});

describe("sendBytesWithRangeSupport", () => {
  async function request(headers: Record<string, string> = {}) {
    const app = fastify();
    app.get("/file", (request, reply) =>
      sendBytesWithRangeSupport({
        request,
        reply,
        bytes: Buffer.from("0123456789"),
        mimeType: "text/plain",
        disposition: 'inline; filename="file.txt"',
        lastModified: new Date("2026-09-01T12:00:00.000Z"),
      }),
    );
    const response = await app.inject({ method: "GET", url: "/file", headers });
    await app.close();
    return response;
  }

  it("returns only the requested bytes", async () => {
    const response = await request({ range: "bytes=2-4" });
    expect(response.statusCode).toBe(206);
    expect(response.body).toBe("234");
    expect(response.headers["content-range"]).toBe("bytes 2-4/10");
  });

  it("rejects malformed and multi-range requests without returning the object", async () => {
    for (const range of ["bytes=1x-2", "bytes=0-1,8-9", "bytes=99-"]) {
      const response = await request({ range });
      expect(response.statusCode).toBe(416);
      expect(response.body).toBe("");
      expect(response.headers["content-range"]).toBe("bytes */10");
    }
  });

  it("uses strong validators for conditional and If-Range requests", async () => {
    const initial = await request();
    const etag = String(initial.headers.etag);
    expect((await request({ "if-match": '"different"' })).statusCode).toBe(412);
    expect((await request({ "if-match": etag })).statusCode).toBe(200);
    expect((await request({ "if-none-match": etag })).statusCode).toBe(304);
    expect((await request({ range: "bytes=0-1", "if-range": etag })).statusCode).toBe(206);
    const changed = await request({ range: "bytes=0-1", "if-range": '"different"' });
    expect(changed.statusCode).toBe(200);
    expect(changed.body).toBe("0123456789");
  });
});

describe("sendStreamWithRangeSupport", () => {
  it("opens only the requested range of a 20 GiB object", async () => {
    const opened: unknown[] = [];
    const app = fastify();
    app.route({
      method: ["GET", "HEAD"],
      url: "/large",
      handler: (request, reply) =>
        sendStreamWithRangeSupport({
          request,
          reply,
          byteSize: 20 * 1024 ** 3,
          etag: '"sha256-large"',
          mimeType: "application/octet-stream",
          disposition: 'attachment; filename="large.bin"',
          async open(range) {
            opened.push(range);
            return new Uint8Array((range?.end ?? 0) - (range?.start ?? 0) + 1).fill(7);
          },
        }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/large",
      headers: { range: "bytes=10737418240-10737419263" },
    });
    const rejected = await app.inject({
      method: "GET",
      url: "/large",
      headers: { "if-match": '"different"' },
    });
    const head = await app.inject({ method: "HEAD", url: "/large" });
    await app.close();

    expect(response.statusCode).toBe(206);
    expect(rejected.statusCode).toBe(412);
    expect(response.rawPayload).toHaveLength(1024);
    expect(response.headers["content-range"]).toBe("bytes 10737418240-10737419263/21474836480");
    expect(head.headers["content-length"]).toBe("21474836480");
    expect(opened).toEqual([{ start: 10 * 1024 ** 3, end: 10 * 1024 ** 3 + 1023 }]);
  });
});
