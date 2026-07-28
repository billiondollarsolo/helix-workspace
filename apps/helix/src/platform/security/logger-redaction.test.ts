import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { helixLoggerOptions } from "./logger-redaction.js";

describe("helixLoggerOptions", () => {
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
    expect(line).not.toContain("reusable-protocol-token");
    expect(line).not.toContain("new-session");
    expect(line).not.toContain("nested-access-token");
    expect(line).not.toContain("nested-client-secret");
    expect(line).toContain("[REDACTED]");
  });
});
