import { describe, expect, it, vi } from "vitest";
import { createAssistantToolResultClassifier } from "../../bootstrap/assistant-tool-classification.js";
import { formatUntrustedToolResult } from "../assistant/context-policy.js";
import type { OutboundHttpTransportInput } from "../outbound-http.js";
import { fetchWebPage } from "./web-fetch.js";

const resolve = async () => [{ address: "93.184.216.34", family: 4 as const }];
const url = "https://public.example/article";
const html = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html;charset=utf-8" } });
const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  type: "user" as const,
};

describe("bounded public page reading", () => {
  it("uses the installed parser to extract inert decoded text, preserve source URL, and paginate without losing characters", async () => {
    const transport = vi.fn(async () =>
      html(
        '<!doctype html><html><head><title>A &amp; B</title><script>steal()</script></head><body><svg><title>Menu</title><text>Hidden icon</text></svg><h1>Hello &lt;world&gt;</h1><script>alert(1)</script><style>secret css</style><img src="https://private.example/image"><p hidden>Hidden</p><p>Next <b>paragraph</b>.</p></body></html>',
      ),
    );
    const first = await fetchWebPage({ url, limit: 7 }, { resolve, transport });
    const second = await fetchWebPage(
      { url, offset: first.nextOffset ?? 0, limit: 4000 },
      { resolve, transport },
    );
    expect(first).toMatchObject({ url, title: "A & B", offset: 0, truncated: true });
    expect(first.content + second.content).toBe("Hello <world>\n\nNext paragraph.");
    expect(second.nextOffset).toBeNull();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("validates each redirect, pins DNS, strips ambient credentials, and returns the final exact source URL", async () => {
    const transport = vi.fn(async (input: OutboundHttpTransportInput) =>
      input.originalUrl.hostname === "public.example"
        ? Response.redirect("https://other.example/final", 302)
        : html("<p>Final page</p>"),
    );
    const result = await fetchWebPage({ url }, { resolve, transport });
    expect(result.url).toBe("https://other.example/final");
    expect(transport).toHaveBeenCalledTimes(2);
    for (const [call] of transport.mock.calls) {
      expect(call.url.hostname).toBe("93.184.216.34");
      expect(call.init.headers.get("cookie")).toBeNull();
      expect(call.init.headers.get("authorization")).toBeNull();
    }
  });

  it.each([
    "https://127.0.0.1/",
    "https://169.254.169.254/latest/",
    "https://[::1]/",
    "https://0x7f000001/",
    "https://server.internal/",
    "file:///etc/passwd",
    "http://public.example/",
    "https://u:password@public.example/",
  ])("blocks private or unsafe URL %s even in local mode", async (destination) => {
    const transport = vi.fn(async () => html("should never load"));
    await expect(fetchWebPage({ url: destination }, { resolve, transport })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    "https://127.0.0.1/",
    "http://public.example/",
    "https://other.example/?api_key=privatecredential1234",
  ])("rejects unsafe redirect before its network hop (%s)", async (location) => {
    const transport = vi.fn(async () => Response.redirect(location, 302));
    await expect(fetchWebPage({ url }, { resolve, transport })).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects mixed/private DNS answers and credential-bearing or sensitive URLs before egress", async () => {
    const transport = vi.fn(async () => html("should never load"));
    await expect(
      fetchWebPage(
        { url },
        {
          resolve: async () => [
            { address: "93.184.216.34", family: 4 },
            { address: "10.0.0.1", family: 4 },
          ],
          transport,
        },
      ),
    ).rejects.toThrow("blocked");
    for (const path of [
      "?api_key=short",
      "?token=privatevalue",
      "/api_key%3Dprivatecredential1234",
      "?query=123-45-6789",
    ])
      await expect(fetchWebPage({ url: url + path }, { resolve, transport })).rejects.toThrow(
        "credentials or sensitive",
      );
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["application/pdf", "image/png", "application/json"])(
    "rejects unsupported format %s",
    async (type) => {
      await expect(
        fetchWebPage(
          { url },
          {
            resolve,
            transport: async () => new Response("untrusted", { headers: { "content-type": type } }),
          },
        ),
      ).rejects.toThrow("unsupported");
    },
  );

  it("rejects attachment downloads and pages requiring script execution", async () => {
    await expect(
      fetchWebPage(
        { url },
        {
          resolve,
          transport: async () =>
            new Response("download", {
              headers: {
                "content-type": "text/plain",
                "content-disposition": "attachment; filename=file.txt",
              },
            }),
        },
      ),
    ).rejects.toThrow("unsupported");
    await expect(
      fetchWebPage(
        { url },
        {
          resolve,
          transport: async () =>
            html(
              "<html><head><title>Dynamic app</title></head><body><script>loadPage()</script></body></html>",
            ),
        },
      ),
    ).rejects.toThrow("no readable static text");
  });

  it("bounds bytes, redirects and cancellation and hides error response bodies", async () => {
    await expect(
      fetchWebPage(
        { url },
        {
          resolve,
          transport: async () =>
            new Response("x".repeat(1_048_577), { headers: { "content-type": "text/plain" } }),
        },
      ),
    ).rejects.toThrow("1 MiB");
    const transport = vi.fn(async () => Response.redirect(url, 302));
    await expect(fetchWebPage({ url }, { resolve, transport })).rejects.toThrow("blocked");
    expect(transport).toHaveBeenCalledTimes(4);
    await expect(
      fetchWebPage(
        { url },
        {
          resolve,
          transport: async () => new Promise<Response>(() => {}),
          signal: AbortSignal.timeout(5),
        },
      ),
    ).rejects.toThrow("cancelled");
    await expect(
      fetchWebPage(
        { url },
        {
          resolve,
          transport: async () => new Response("private provider details", { status: 403 }),
        },
      ),
    ).rejects.toThrow("HTTP 403");
  });

  it("classifies the entire extracted text before slicing so later credentials cannot ride a permissive first chunk", async () => {
    const result = await fetchWebPage(
      { url, limit: 5 },
      {
        resolve,
        transport: async () =>
          html(
            `<p>Safe opening</p><p>${"ordinary text ".repeat(600)}api_key=privatecredential1234</p>`,
          ),
      },
    );
    expect(result.content).toBe("Safe ");
    expect(result.classification).toBe("restricted");
    const classify = createAssistantToolResultClassifier({ get: async () => null });
    expect(await classify({ actor, toolId: "web.fetch", output: result })).toBe("restricted");
    expect(
      await classify({
        actor,
        toolId: "web.fetch",
        output: { content: "bad envelope" },
      }),
    ).toBe("restricted");
  });

  it("classifies compatibility characters before the model's normalization", async () => {
    const result = await fetchWebPage(
      { url },
      {
        resolve,
        transport: async () =>
          new Response("ａｐｉ＿ｋｅｙ=privatecredential1234", {
            headers: { "content-type": "text/plain" },
          }),
      },
    );
    expect(result.classification).toBe("restricted");
  });

  it("preserves a complete maximum chunk and continuation in the untrusted model envelope", async () => {
    const result = await fetchWebPage(
      { url, limit: 4000 },
      {
        resolve,
        transport: async () =>
          new Response('"'.repeat(5_000), { headers: { "content-type": "text/plain" } }),
      },
    );
    const envelope = formatUntrustedToolResult({ toolId: "web.fetch", output: result });
    expect(envelope).toContain("BEGIN_UNTRUSTED_TOOL_RESULT");
    expect(envelope).not.toContain("Truncated output preview");
    const json = envelope.split("\n")[1];
    expect(JSON.parse(json ?? "null")).toMatchObject({
      output: { content: result.content, nextOffset: 4000, totalChars: 5000, truncated: true },
    });
    await expect(
      fetchWebPage({ url, offset: 9000 }, { resolve, transport: async () => html("Short") }),
    ).rejects.toThrow("offset");
  });

  it("does not split astral characters at pagination boundaries", async () => {
    const transport = async () =>
      new Response("A😀B", { headers: { "content-type": "text/plain" } });
    const first = await fetchWebPage({ url, limit: 2 }, { resolve, transport });
    expect(first.content).toBe("A");
    expect(first.nextOffset).toBe(1);
    const next = await fetchWebPage({ url, offset: 1 }, { resolve, transport });
    expect(next.content).toBe("😀B");
    await expect(fetchWebPage({ url, offset: 2 }, { resolve, transport })).rejects.toThrow(
      "nextOffset",
    );
  });
});
