import type { Actor, LLMProviderCapability, ToolContext, ToolDefinition } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleProvider } from "../ai/providers/openai-compatible.js";
import { OutboundHttpError } from "../outbound-http.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import {
  ASSISTANT_NOT_CONFIGURED_MEMBER_MESSAGE,
  ASSISTANT_UNREACHABLE_MEMBER_MESSAGE,
  createAssistantAvailabilityCheck,
  registerAssistantStatusTool,
  type AssistantAvailability,
} from "./availability.js";
import {
  ASSISTANT_PROVIDER_UNREACHABLE_MESSAGE,
  assistantProviderError,
  withAssistantProviderErrors,
} from "./provider-errors.js";

const member: Actor = { id: "member", orgId: "org", type: "user", scopes: ["assistant.read"] };
const admin: Actor = { ...member, id: "admin", scopes: ["assistant.read", "admin.config.read"] };

function ollama(fetchImpl: typeof fetch, id = "ollama.local"): LLMProviderCapability {
  return createOpenAICompatibleProvider({
    id,
    baseUrl: "http://ollama.internal:11434/v1",
    apiKey: "secret-key",
    models: [{ id: "llama3.1" }],
    fetch: fetchImpl,
  });
}

/** A provider with no cheap probe, like the cloud SDK providers. */
const sdkProvider = { id: "bedrock.main" } as unknown as LLMProviderCapability;

describe("assistant availability check", () => {
  it("is not configured without providers", async () => {
    const check = createAssistantAvailabilityCheck({ providers: () => [] });
    await expect(check()).resolves.toEqual({ available: false, reason: "not_configured" });
  });

  it("probes the provider's model listing with its credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ data: [] }));
    const check = createAssistantAvailabilityCheck({ providers: () => [ollama(fetchImpl)] });
    await expect(check()).resolves.toEqual({ available: true });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toEqual(new URL("http://ollama.internal:11434/v1/models"));
    expect(init).toMatchObject({
      method: "GET",
      headers: { authorization: "Bearer secret-key" },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("treats a refused connection or server error as unreachable", async () => {
    const refused = vi.fn<typeof fetch>(async () => {
      throw new OutboundHttpError("transport_failed", new URL("http://ollama.internal:11434"));
    });
    const failing = vi.fn<typeof fetch>(async () => new Response("boom", { status: 502 }));
    const check = createAssistantAvailabilityCheck({
      providers: () => [ollama(refused), ollama(failing, "ollama.second")],
    });
    await expect(check()).resolves.toEqual({
      available: false,
      reason: "unreachable",
      cause: "network",
      providerIds: ["ollama.local", "ollama.second"],
    });
  });

  it("reports rejected credentials and accepts a 404 listing as reachable", async () => {
    const rejected = createAssistantAvailabilityCheck({
      providers: () => [ollama(async () => new Response(null, { status: 401 }))],
    });
    await expect(rejected()).resolves.toMatchObject({
      reason: "unreachable",
      cause: "credentials",
    });
    const noListing = createAssistantAvailabilityCheck({
      providers: () => [ollama(async () => new Response(null, { status: 404 }))],
    });
    await expect(noListing()).resolves.toEqual({ available: true });
  });

  it("is available when any provider answers, counting unprobeable providers", async () => {
    const down = ollama(async () => new Response(null, { status: 503 }));
    const check = createAssistantAvailabilityCheck({ providers: () => [down, sdkProvider] });
    await expect(check()).resolves.toEqual({ available: true });
  });

  it("gives up on a provider that does not answer within the timeout", async () => {
    const hanging = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const check = createAssistantAvailabilityCheck({
      providers: () => [ollama(hanging)],
      timeoutMs: 10,
    });
    await expect(check()).resolves.toMatchObject({ available: false, reason: "unreachable" });
  });

  it("reuses a result until it expires or the providers change", async () => {
    let time = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ data: [] }));
    let providers = [ollama(fetchImpl)];
    const check = createAssistantAvailabilityCheck({
      providers: () => providers,
      ttlMs: 60_000,
      now: () => time,
    });
    await Promise.all([check(), check()]);
    time = 59_999;
    await check();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    time = 60_000;
    await check();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    providers = [ollama(fetchImpl, "ollama.renamed")];
    await check();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("assistant.status", () => {
  function statusTool(status: AssistantAvailability): (actor: Actor) => Promise<unknown> {
    let tool: ToolDefinition | undefined;
    registerAssistantStatusTool(
      {
        register: (definition: ToolDefinition) => {
          tool = definition;
        },
      } as unknown as RuntimeToolRegistry,
      { check: async () => status },
    );
    return async (actor) => {
      if (tool === undefined) throw new Error("assistant.status was not registered");
      expect(tool).toMatchObject({ permission: "assistant.read", sideEffects: "read" });
      const ctx = { actor, audit: vi.fn() } as unknown as ToolContext;
      return tool.handler(tool.inputSchema.parse({}), ctx);
    };
  }

  it("reports Helix AI available when a provider answers", async () => {
    await expect(statusTool({ available: true })(member)).resolves.toEqual({ available: true });
  });

  it("tells admins which setting to configure and members whom to ask", async () => {
    const missing = statusTool({ available: false, reason: "not_configured" });
    const forAdmin = (await missing(admin)) as { message: string };
    expect(forAdmin).toMatchObject({ available: false, reason: "not_configured" });
    expect(forAdmin.message).toContain("OLLAMA_BASE_URL");
    expect(forAdmin.message).toContain("OPENAI_API_KEY");
    await expect(missing(member)).resolves.toEqual({
      available: false,
      reason: "not_configured",
      message: ASSISTANT_NOT_CONFIGURED_MEMBER_MESSAGE,
    });

    const unreachable = statusTool({
      available: false,
      reason: "unreachable",
      cause: "network",
      providerIds: ["ollama.local"],
    });
    const unreachableForAdmin = (await unreachable(admin)) as { message: string };
    expect(unreachableForAdmin).toMatchObject({ available: false, reason: "unreachable" });
    expect(unreachableForAdmin.message).toContain("OLLAMA_BASE_URL");
    expect(unreachableForAdmin.message).toContain("HELIX_AI_ALLOW_PRIVATE_NETWORK");
    await expect(unreachable(member)).resolves.toEqual({
      available: false,
      reason: "unreachable",
      message: ASSISTANT_UNREACHABLE_MEMBER_MESSAGE,
    });

    const rejected = statusTool({
      available: false,
      reason: "unreachable",
      cause: "credentials",
      providerIds: ["openai-compatible.default"],
    });
    expect(((await rejected(admin)) as { message: string }).message).toContain(
      "rejected Helix's credentials. Update OPENAI_API_KEY and restart Helix.",
    );
  });
});

describe("assistant provider errors", () => {
  it("turns a provider connection failure into an actionable error", () => {
    const failure = new OutboundHttpError("transport_failed", new URL("http://localhost:11434"));
    const mapped = assistantProviderError(failure);
    expect(mapped).toMatchObject({
      statusCode: 422,
      message: ASSISTANT_PROVIDER_UNREACHABLE_MESSAGE,
    });
  });

  it("maps failures from both chat and streamed chat on the Assistant's client", async () => {
    const failure = new OutboundHttpError("transport_failed", new URL("http://localhost:11434"));
    const ai = withAssistantProviderErrors({
      chat: () => Promise.reject(failure),
      // eslint-disable-next-line require-yield -- fails before the first chunk
      chatStream: async function* () {
        throw failure;
      },
    });
    const request = { feature: "assistant.chat", messages: [] };
    await expect(ai.chat(request)).rejects.toMatchObject({
      message: ASSISTANT_PROVIDER_UNREACHABLE_MESSAGE,
    });
    const stream = ai.chatStream?.(request)[Symbol.asyncIterator]();
    await expect(stream?.next()).rejects.toMatchObject({
      message: ASSISTANT_PROVIDER_UNREACHABLE_MESSAGE,
    });
  });

  it("keeps other errors and cancelled turns as they are", () => {
    const other = new Error("unrelated");
    expect(assistantProviderError(other)).toBe(other);
    const failure = new OutboundHttpError("aborted", new URL("http://localhost:11434"));
    const controller = new AbortController();
    controller.abort();
    expect(assistantProviderError(failure, controller.signal)).toBe(failure);
  });
});
