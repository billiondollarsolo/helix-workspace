import type { AICapability, Actor, AiConfig } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { createAssistantToolResultClassifier } from "../../bootstrap/assistant-tool-classification.js";
import { AssistantOrchestrator } from "../assistant/orchestrator.js";
import { InMemoryAssistantStore } from "../assistant/index.js";
import { dlpToolInvocation } from "../dlp.js";
import { createOutboundHttpClient, OutboundHttpError } from "../outbound-http.js";
import { AllowAllToolAccessPolicy } from "../permissions/tool-access.js";
import { createToolRegistry } from "../tool-registry.js";
import { registerWebSearchTool } from "./web-tools.js";
import { getWebSearchEnabled, searchWeb, testWebSearch } from "./web.js";
import type { SearchEngine } from "./types.js";

const config = {
  enabled: true,
  provider: "brave",
  apiKey: "test-provider-key",
  maxResults: 2,
} as const;
const actor: Actor = {
  id: "actor-1",
  orgId: "org-1",
  type: "user",
  scopes: ["assistant.read", "drive.read"],
};
const result = {
  url: "https://example.com/article",
  title: "Example",
  description: "A useful snippet",
};

describe("public web search", () => {
  it("uses Brave authentication, bounded results, safe links and plain snippets", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        web: {
          results: [
            { ...result, url: "javascript:alert(1)" },
            { ...result, url: "http://127.0.0.1/secret" },
            { ...result, url: "https://user:password@example.com/" },
            { ...result, description: `<b>Hello</b> ${"x".repeat(1_000)}` },
            result,
            { ...result, url: "https://example.org/next" },
            { ...result, url: "https://example.net/ignored" },
          ],
        },
      }),
    );
    const output = await searchWeb(config, "weather in New York", { fetch: send });
    const call = send.mock.calls[0];
    if (call === undefined || !(call[0] instanceof URL))
      throw new Error("Expected provider request");
    const [url, init] = call;
    expect(url.href).toContain("q=weather+in+New+York");
    expect(url.href).toContain("count=2");
    expect(new Headers(init?.headers).get("X-Subscription-Token")).toBe(config.apiKey);
    expect(output.results.map(({ url }) => url)).toEqual([result.url, "https://example.org/next"]);
    expect(output.results[0]?.snippet).toHaveLength(500);
    expect(JSON.stringify(output)).not.toContain("<b>");
  });

  it("supports a SearXNG subpath and optional authentication without exposing the key", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        results: [{ ...result, description: undefined, content: "SearX snippet" }],
      }),
    );
    const output = await searchWeb(
      {
        enabled: true,
        provider: "searxng",
        baseUrl: "https://search.example.org/engine/",
        apiKey: "private",
      },
      "public query",
      { fetch: send },
    );
    expect((send.mock.calls[0]?.[0] as URL).href).toBe(
      "https://search.example.org/engine/search?q=public+query&format=json&categories=general",
    );
    expect(new Headers(send.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer private",
    );
    expect(output.results[0]?.snippet).toBe("SearX snippet");
    expect(JSON.stringify(output)).not.toContain("private");
  });

  it("rejects disabled, malformed, oversized and sensitive queries before transport", async () => {
    const send = vi.fn<typeof fetch>();
    for (const query of ["", "x".repeat(1_001), "CONFIDENTIAL: internal launch strategy"]) {
      await expect(searchWeb(config, query, { fetch: send })).rejects.toThrow();
    }
    await expect(
      searchWeb({ ...config, enabled: false }, "public", { fetch: send }),
    ).rejects.toThrow("disabled");
    await expect(
      searchWeb(
        { enabled: true, provider: "searxng", baseUrl: "https://secret:token@example.com" },
        "public",
        { fetch: send },
      ),
    ).rejects.toThrow("without credentials");
    expect(send).not.toHaveBeenCalled();
    expect(getWebSearchEnabled({ webSearch: config })).toBe(true);
    expect(getWebSearchEnabled({ enabled: false, webSearch: config })).toBe(false);
    expect(getWebSearchEnabled({ webSearch: { ...config, apiKey: "" } })).toBe(false);
  });

  it("reports real provider failures without echoing their potentially sensitive bodies", async () => {
    const send = vi.fn<typeof fetch>();
    for (const status of [401, 403, 429, 500]) {
      send.mockResolvedValueOnce(new Response("secret provider diagnostic", { status }));
      await expect(searchWeb(config, "public", { fetch: send })).rejects.not.toThrow(
        "secret provider diagnostic",
      );
    }
    send.mockResolvedValueOnce(Response.json({ unexpected: true }));
    await expect(
      searchWeb(
        { enabled: true, provider: "searxng", baseUrl: "https://search.example.com" },
        "public",
        { fetch: send },
      ),
    ).rejects.toThrow("unexpected response");
    send.mockResolvedValueOnce(new Response("<html>not JSON</html>"));
    await expect(searchWeb(config, "public", { fetch: send })).rejects.toThrow(
      "unreadable response",
    );
    expect(await testWebSearch(undefined)).toMatchObject({ ok: false });
  });

  it("pins public DNS and blocks redirect/private destinations and oversized provider responses", async () => {
    const transport = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
    );
    const send = createOutboundHttpClient({
      production: true,
      allowPrivateNetwork: false,
      allowedHosts: ["api.search.brave.com"],
      maxRedirects: 0,
      maxResponseBytes: 100,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport,
    });
    await expect(searchWeb(config, "public", { fetch: send })).rejects.toThrow(
      "blocked by network policy",
    );
    expect(transport).toHaveBeenCalledTimes(1);
    transport.mockResolvedValueOnce(new Response("x".repeat(101)));
    await expect(searchWeb(config, "public", { fetch: send })).rejects.toThrow("1 MiB limit");
    const privateDns = createOutboundHttpClient({
      allowPrivateNetwork: false,
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      transport,
    });
    await expect(searchWeb(config, "public", { fetch: privateDns })).rejects.toThrow(
      "blocked by network policy",
    );
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["dns_failed", "hostname could not be resolved"],
    ["transport_failed", "Could not reach the web search provider"],
    ["blocked_destination", "blocked by network policy"],
  ] as const)("reports %s without disclosing endpoint or query details", async (code, message) => {
    const send = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new OutboundHttpError(
          code,
          new URL("https://private-engine.example/search?q=private-query"),
        ),
      );
    await expect(searchWeb(config, "public", { fetch: send })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(message),
    });
    await expect(searchWeb(config, "public", { fetch: send })).rejects.not.toThrow(
      "private-engine",
    );
    send.mockRejectedValue(
      new Error("secret provider body https://private-engine.example/?key=secret"),
    );
    await expect(searchWeb(config, "public", { fetch: send })).rejects.toMatchObject({
      statusCode: 400,
      message:
        "Could not reach the web search provider. Check its connection in Admin and try again.",
    });
  });

  it.each(["headers", "body"] as const)(
    "distinguishes a %s timeout from caller cancellation",
    async (phase) => {
      const send = createOutboundHttpClient({
        timeoutMs: 10,
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        transport: async () =>
          phase === "headers"
            ? new Promise<Response>(() => {})
            : new Response(new ReadableStream()),
      });
      await expect(searchWeb(config, "public", { fetch: send })).rejects.toMatchObject({
        statusCode: 400,
        message: "The web search provider timed out. Try again later.",
      });
    },
  );

  it("preserves the caller's abort reason before and during transport and body reads", async () => {
    const reason = new DOMException("User stopped search", "AbortError");
    const send = vi.fn<typeof fetch>();
    await expect(
      searchWeb(config, "public", { fetch: send, signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(send).not.toHaveBeenCalled();
    for (const phase of ["headers", "body"]) {
      const controller = new AbortController();
      send.mockImplementationOnce(async () => {
        if (phase === "headers") {
          controller.abort(reason);
          throw new OutboundHttpError("aborted", new URL(result.url));
        }
        return new Response(
          new ReadableStream({
            pull(stream) {
              controller.abort(reason);
              stream.error(new OutboundHttpError("aborted", new URL(result.url)));
            },
          }),
        );
      });
      await expect(
        searchWeb(config, "public", { fetch: send, signal: controller.signal }),
      ).rejects.toBe(reason);
    }
  });

  it("fails empty connection probes while accepting useful partial SearXNG results", async () => {
    const searxng = {
      enabled: true,
      provider: "searxng",
      baseUrl: "https://search.example.org",
    } as const;
    const unresponsive_engines = [["duckduckgo", "CAPTCHA"]];
    const send = vi.fn<typeof fetch>();
    for (const payload of [
      { results: [] },
      { results: [], unresponsive_engines },
      { results: [{ ...result, url: "http://127.0.0.1/private" }], unresponsive_engines },
    ]) {
      send.mockResolvedValueOnce(Response.json(payload));
      expect(await testWebSearch(searxng, { fetch: send })).toMatchObject({
        ok: false,
        message: expect.stringContaining("no usable public results"),
      });
    }
    send.mockResolvedValueOnce(Response.json({ results: [result], unresponsive_engines }));
    expect(await testWebSearch(searxng, { fetch: send })).toMatchObject({ ok: true });
    send.mockResolvedValueOnce(Response.json({ web: { results: [] } }));
    expect(await testWebSearch(config, { fetch: send })).toMatchObject({ ok: false });
    send.mockRejectedValueOnce(new Error("private provider diagnostic"));
    expect(await testWebSearch(searxng, { fetch: send })).toMatchObject({
      ok: false,
      message:
        "Could not reach the web search provider. Check its connection in Admin and try again.",
    });
  });

  it.each(["web.search", "web.fetch"])(
    "%s requires per-turn opt-in, respects live admin disable and blocks private-history egress",
    async (toolId) => {
      const toolInput = toolId === "web.search" ? { query: "public query" } : { url: result.url };
      let enabled = true;
      const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
      const getConfig = (): AiConfig => ({ webSearch: config });
      registerWebSearchTool(tools, getConfig, () => enabled);
      const handler = vi.fn().mockResolvedValue(
        toolId === "web.fetch"
          ? {
              url: result.url,
              title: "Example",
              content: "Result",
              contentType: "text/html",
              offset: 0,
              nextOffset: null,
              totalChars: 6,
              truncated: false,
              classification: "standard",
            }
          : {
              provider: "brave",
              results: [{ id: "web-1", title: "Example", url: result.url, snippet: "Result" }],
            },
      );
      const tool = tools.get(toolId);
      if (tool === undefined) throw new Error("Expected registered search tool");
      tools.unregister(toolId);
      tools.register({ ...tool, handler });
      const chat = vi.fn<AICapability["chat"]>().mockImplementation(async (request) => {
        const complete = request.messages.some(({ toolCallId }) => toolCallId !== undefined);
        return {
          message: complete ? "Search complete." : "",
          model: "test",
          providerId: "test",
          toolCalls: complete ? [] : [{ id: toolId, input: toolInput }],
        };
      });
      const search = vi.fn<SearchEngine["search"]>().mockResolvedValue({
        query: "Search now",
        hits: [
          {
            id: "unrelated-neighbor",
            type: "drive",
            body: "An unrelated private workspace record",
            attributes: { orgId: actor.orgId, classification: "restricted" },
          },
        ],
      });
      const assistant = new AssistantOrchestrator({
        store: new InMemoryAssistantStore(),
        tools,
        ai: { chat },
        search: {
          id: "workspace",
          index: vi.fn<SearchEngine["index"]>().mockResolvedValue(undefined),
          upsert: vi.fn<SearchEngine["upsert"]>().mockResolvedValue(undefined),
          delete: vi.fn<SearchEngine["delete"]>().mockResolvedValue(undefined),
          search,
        },
        webSearchEnabled: () => enabled,
        classifyToolResult: createAssistantToolResultClassifier({ get: async () => null }),
      });
      const off = await assistant.sendMessage({ actor, content: "Search now" });
      expect(off.toolCalls[0]?.status).toBe("skipped");
      expect(handler).not.toHaveBeenCalled();
      expect(search).toHaveBeenCalledTimes(1);
      expect(off.sources[0]?.classification).toBe("restricted");
      const on = await assistant.sendMessage({ actor, content: "Search now", webSearch: true });
      expect(on.toolCalls[0]?.status).toBe("executed");
      expect(handler).toHaveBeenCalledTimes(1);
      expect(search).toHaveBeenCalledTimes(1);
      expect(on.sources).toMatchObject([
        { type: toolId, url: "https://example.com/article", classification: "standard" },
      ]);
      expect(on.sources.some((source) => !source.type.startsWith("web."))).toBe(false);
      expect(on.messages.find(({ role }) => role === "user")?.metadata.webSearch).toBe(true);
      expect(on.messages.find(({ role }) => role === "tool")?.content).toContain("UNTRUSTED");
      const privateTurn = await assistant.sendMessage({
        actor,
        content: "private context",
        classification: "confidential",
        webSearch: true,
      });
      expect(privateTurn.toolCalls[0]?.status).toBe("skipped");
      expect(handler).toHaveBeenCalledTimes(1);
      chat.mockResolvedValueOnce({
        message: "",
        model: "test",
        providerId: "test",
        toolCalls: [{ id: toolId, input: toolInput }],
      });
      const privateFollowup = await assistant.sendMessage({
        actor,
        conversationId: privateTurn.conversation.id,
        content: "Find more",
        webSearch: true,
      });
      expect(privateFollowup.toolCalls[0]?.status).toBe("skipped");
      expect(handler).toHaveBeenCalledTimes(1);
      chat.mockImplementationOnce(async () => {
        enabled = false;
        return {
          message: "",
          model: "test",
          providerId: "test",
          toolCalls: [{ id: toolId, input: toolInput }],
        };
      });
      const disabledDuringTurn = await assistant.sendMessage({
        actor,
        content: "Search again",
        webSearch: true,
      });
      expect(disabledDuringTurn.toolCalls[0]?.status).toBe("skipped");
      expect(handler).toHaveBeenCalledTimes(1);
      await expect(
        assistant.sendMessage({ actor, content: "public", webSearch: true }),
      ).rejects.toThrow("disabled");
      expect(await assistant.listModels()).toMatchObject({ webSearchEnabled: false });
      expect(dlpToolInvocation(toolId, toolInput, actor)?.boundary).toBe("copy_export");
    },
  );
});
