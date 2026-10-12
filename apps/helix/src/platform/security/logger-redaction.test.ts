import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { helixLoggerOptions, redactSignedUrl } from "./logger-redaction.js";

describe("helixLoggerOptions", () => {
  it("logs the cause of a failure passed as `error`, with credentials scrubbed", async () => {
    const stream = new PassThrough();
    const output: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => output.push(chunk));
    const logger = pino(helixLoggerOptions("info"), stream);

    const failure = Object.assign(
      new Error("connect to postgres://helix_app:s3cret@postgres:5432 failed"),
      { code: "ECONNREFUSED" },
    );
    logger.error({ error: failure }, "Worker error");
    logger.error({ error: "plain text stays as it is" }, "Worker error");
    await new Promise((resolve) => setImmediate(resolve));

    const [first, second] = Buffer.concat(output)
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { error: unknown });
    // Without the serializer pino prints an Error under `error` as `{}`.
    expect(first?.error).toMatchObject({
      type: "Error",
      code: "ECONNREFUSED",
      message: "connect to postgres://***@postgres:5432 failed",
    });
    expect(JSON.stringify(first)).not.toContain("s3cret");
    expect(second?.error).toBe("plain text stays as it is");
  });

  it("redacts HTTP and WebSocket credentials in structured logs", async () => {
    const stream = new PassThrough();
    const output: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => output.push(chunk));
    const logger = pino(helixLoggerOptions("info"), stream);

    logger.info(
      {
        req: {
          headers: {
            authorization: "Bearer reusable-access-token",
            cookie: "helix_session=reusable-session",
            "x-helix-mfa-assertion": "signed-mfa-assertion",
            "sec-websocket-protocol": "helix-bearer, reusable-protocol-token",
          },
        },
        res: {
          headers: {
            "set-cookie": "helix_session=new-session; HttpOnly; Secure",
          },
        },
        credential: {
          accessToken: "nested-access-token",
          clientSecret: "nested-client-secret",
        },
      },
      "handshake",
    );

    await new Promise<void>((resolve) => stream.end(resolve));
    const line = Buffer.concat(output).toString("utf8");

    expect(line).not.toContain("reusable-access-token");
    expect(line).not.toContain("reusable-session");
    expect(line).not.toContain("signed-mfa-assertion");
    expect(line).not.toContain("reusable-protocol-token");
    expect(line).not.toContain("new-session");
    expect(line).not.toContain("nested-access-token");
    expect(line).not.toContain("nested-client-secret");
    expect(line).toContain("[REDACTED]");
  });

  it("removes presigned-URL signatures from logged request URLs", async () => {
    const stream = new PassThrough();
    const output: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => output.push(chunk));
    const logger = pino(helixLoggerOptions("info"), stream);
    const url =
      "/v1/s3/my-drive/a.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=HLXAAAAAAAAAAAAAAAAA%2F20261011%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261011T000000Z&X-Amz-Expires=300&X-Amz-SignedHeaders=host&X-Amz-Signature=deadbeefcafe";
    logger.info({ req: { method: "GET", url, ip: "203.0.113.7" } }, "incoming request");
    await new Promise<void>((resolve) => stream.end(resolve));
    const line = Buffer.concat(output).toString("utf8");
    expect(line).not.toContain("deadbeefcafe");
    expect(line).not.toContain("HLXAAAAAAAAAAAAAAAAA");
    expect(line).toContain("/v1/s3/my-drive/a.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(line).toContain("X-Amz-Signature=[REDACTED]");
    expect(redactSignedUrl("/x?x-amz-security-token=t0k&b=1")).toBe(
      "/x?x-amz-security-token=[REDACTED]&b=1",
    );
  });
});
