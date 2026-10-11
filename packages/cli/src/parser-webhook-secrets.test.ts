import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./parser.js";

const webhookId = "66666666-6666-4666-8666-666666666666";

describe("webhook signing secrets", () => {
  it("passes the signing secret the webhook tools require", () => {
    const secret = "s".repeat(32);
    expect(
      parseCliArgs([
        "webhook",
        "outbound",
        "create",
        "--name",
        "Build events",
        "--url",
        "https://hooks.example/build",
        "--secret",
        secret,
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "webhook.outbound.create",
      json: {
        source: "inline",
        value: `{"name":"Build events","url":"https://hooks.example/build","secret":"${secret}"}`,
      },
    });
    expect(
      parseCliArgs([
        "webhook",
        "inbound",
        "create",
        "--name",
        "CI",
        "--slug",
        "ci",
        "--secret",
        secret,
      ]),
    ).toMatchObject({
      toolId: "webhook.inbound.create",
      json: { value: `{"name":"CI","slug":"ci","secret":"${secret}"}` },
    });
    expect(
      parseCliArgs(["webhook", "inbound", "rotate-secret", "--id", webhookId, "--secret", secret]),
    ).toMatchObject({
      toolId: "webhook.inbound.rotate-secret",
      json: { value: `{"id":"${webhookId}","secret":"${secret}"}` },
    });
  });
});
