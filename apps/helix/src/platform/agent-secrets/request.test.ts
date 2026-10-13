import { describe, expect, it } from "vitest";
import type { OutboundHttpTransportInput } from "../outbound-http.js";
import { SECRET_PLACEHOLDER, secretHttpRequestSchema, sendWithSecret } from "./request.js";
import type { OpenedAgentSecret } from "./store.js";

const value = "tok_live_abc123";
const secret: OpenedAgentSecret = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "billing-api",
  description: "",
  mode: "use_only",
  allowedHosts: ["api.example.com"],
  headerName: "authorization",
  headerPrefix: "Bearer ",
  version: 1,
  value,
};
const resolve = async () => [{ address: "93.184.216.34", family: 4 as const }];

function send(
  input: Record<string, unknown>,
  respond: (sent: OutboundHttpTransportInput) => Response,
  using: OpenedAgentSecret = secret,
) {
  const sent: OutboundHttpTransportInput[] = [];
  const result = sendWithSecret(
    using,
    secretHttpRequestSchema.parse({ secret: using.name, ...input }),
    {
      resolve,
      transport: async (request) => {
        sent.push(request);
        return respond(request);
      },
    },
  );
  return { sent, result };
}

describe("sendWithSecret", () => {
  it("adds the secret as a header and takes it out of whatever comes back", async () => {
    const { sent, result } = send(
      { url: "https://api.example.com/v1/invoices", headers: { Accept: "application/json" } },
      (request) =>
        new Response(`{"echo":"${request.init.headers.get("authorization") ?? ""}"}`, {
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(result).resolves.toEqual({
      status: 200,
      contentType: "application/json",
      body: `{"echo":"Bearer ${SECRET_PLACEHOLDER}"}`,
    });
    expect(sent[0]?.init.headers.get("authorization")).toBe(`Bearer ${value}`);
    expect(sent[0]?.init.headers.get("accept")).toBe("application/json");
  });

  it("sends nothing to a host the secret is not allowed to reach", async () => {
    for (const url of [
      "https://evil.example.net/collect",
      "https://api.example.com.evil.example.net/",
      "http://api.example.com/",
      "https://api.example.com:8443/",
      "https://user:pass@api.example.com/",
    ]) {
      const { sent, result } = send({ url }, () => new Response("ok"));
      await expect(result, url).rejects.toThrow(/sent only to/u);
      expect(sent, url).toHaveLength(0);
    }
  });

  it("does not follow a redirect that leaves the allowed hosts", async () => {
    const { sent, result } = send(
      { url: "https://api.example.com/start" },
      () => new Response(null, { status: 302, headers: { location: "https://evil.example.net/" } }),
    );
    await expect(result).rejects.toThrow(/sent only to/u);
    expect(sent.map((request) => request.originalUrl.hostname)).toEqual(["api.example.com"]);
  });

  it("refuses headers Helix sets itself", async () => {
    for (const headers of [{ Authorization: "Bearer mine" }, { Host: "evil.example.net" }]) {
      const { sent, result } = send(
        { url: "https://api.example.com/", headers },
        () => new Response("ok"),
      );
      await expect(result).rejects.toThrow(/set by Helix/u);
      expect(sent).toHaveLength(0);
    }
  });

  it("refuses a secret that has no allowed host or cannot fit in a header", async () => {
    const nowhere = send({ url: "https://api.example.com/" }, () => new Response("ok"), {
      ...secret,
      allowedHosts: [],
    });
    await expect(nowhere.result).rejects.toThrow(/not set up to be sent/u);
    const multiline = send({ url: "https://api.example.com/" }, () => new Response("ok"), {
      ...secret,
      value: "line one\nline two",
    });
    await expect(multiline.result).rejects.toThrow(/more than one line/u);
    expect([...nowhere.sent, ...multiline.sent]).toHaveLength(0);
  });
});
