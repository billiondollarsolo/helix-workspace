import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { RequestBodyTooLargeError } from "./request-body.js";
import { readBoundedRequestBody } from "./request-body.js";

describe("readBoundedRequestBody", () => {
  it("returns a body at the exact aggregate limit", async () => {
    await expect(
      readBoundedRequestBody(Readable.from([Buffer.from("ab"), Buffer.from("cd")]), 4),
    ).resolves.toEqual(Buffer.from("abcd"));
  });

  it("rejects on the first chunk that crosses the aggregate limit", async () => {
    const payload = Readable.from(
      (async function* () {
        yield Buffer.alloc(6);
        yield Buffer.alloc(6);
        yield Buffer.alloc(6);
      })(),
    );

    await expect(readBoundedRequestBody(payload, 10)).rejects.toMatchObject({
      statusCode: 413,
      code: "FST_ERR_CTP_BODY_TOO_LARGE",
    } satisfies Partial<RequestBodyTooLargeError>);
  });
});
