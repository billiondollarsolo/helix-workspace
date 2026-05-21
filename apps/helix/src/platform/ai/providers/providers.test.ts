import { generateKeyPairSync } from "node:crypto";
import type { AICallContext, ChatChunk, ChatResponse } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { createAnthropicCompatibleProvider } from "./anthropic-compatible.js";
import {
  anthropicChatChunks,
  collectChatChunks,
  openAIChatChunks,
  parseSseStream,
  type SseEvent,
} from "./shared.js";
import {
  envCredentialProvider,
  instanceMetadataCredentialProvider,
  parseIniSection,
  parseInstanceProfileCredentials,
  resolveAwsCredentials,
  sharedConfigCredentialProvider,
} from "./aws-credentials.js";
import { createBedrockCredentialProvider, createBedrockProvider } from "./bedrock.js";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import { createVertexProvider, parseTokenResponse, signServiceAccountJwt } from "./vertex.js";

interface FetchStub {
  readonly fetch: typeof fetch;
  readonly calls: FetchCall[];
}

type FetchCall = readonly [Parameters<typeof fetch>[0], Parameters<typeof fetch>[1]];
type FetchResponseFactory = (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => Promise<Response> | Response;

const ctx = {
  actor: { id: "user-1", type: "user", orgId: "org-1" },
  feature: "test.chat",
  classification: "standard",
} satisfies AICallContext;

function createFetchStub(factory: FetchResponseFactory): FetchStub {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push([input, init]);
    return factory(input, init);
  };
  return { fetch: fetchImpl, calls };
}

function firstCall(stub: FetchStub): readonly [URL, RequestInit] {
  const call = stub.calls[0];
  if (call === undefined) {
    throw new Error("Expected fetch to be called");
  }
  const [input, init] = call;
  if (!(input instanceof URL) || init === undefined) {
    throw new Error("Expected fetch to be called with URL and init");
  }
  return [input, init];
}

function headers(init: RequestInit): Record<string, string> {
  if (init.headers === undefined || init.headers instanceof Headers || Array.isArray(init.headers)) {
    throw new Error("Expected plain headers");
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(init.headers)) {
    if (typeof value !== "string") {
      throw new Error(`Expected string header ${name}`);
    }
    result[name.toLowerCase()] = value;
  }
  return result;
}

function jsonBody(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== "string") {
    throw new Error("Expected JSON string body");
  }
  const parsed: unknown = JSON.parse(init.body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected JSON object body");
  }
  return parsed as Record<string, unknown>;
}

function expectChatResponse(value: ChatResponse | AsyncIterable<ChatChunk>): ChatResponse {
  if (isAsyncIterable(value)) {
    throw new Error("Expected non-streaming chat response");
  }
  return value;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

/** Extracts the URL string from any `fetch` input variant. */
function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "string") {
    return input;
  }
  return input.url;
}

/** Reads the request body of a `fetch` init as a string. */
function requestBody(init: Parameters<typeof fetch>[1]): string {
  const body = init?.body;
  return typeof body === "string" ? body : "";
}

/** Base64url-decodes and JSON-parses a single JWT segment. */
function decodeJwtSegment(segment: string | undefined): Record<string, unknown> {
  const decoded: unknown = JSON.parse(Buffer.from(segment ?? "", "base64url").toString("utf8"));
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("Expected a JWT segment object");
  }
  return decoded as Record<string, unknown>;
}

describe("AI provider adapters", () => {
  it("calls OpenAI-compatible chat endpoints and supports local Ollama-style base URLs without API keys", async () => {
    const stub = createFetchStub(
      () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            model: "llama3.1",
            choices: [
              {
                message: {
                  content: "pong",
                  tool_calls: [
                    {
                      id: "call-1",
                      function: {
                        name: "calendar.create",
                        arguments: "{\"title\":\"Demo\"}",
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          }),
          { status: 200 },
        ),
    );
    const provider = createOpenAICompatibleProvider({
      id: "ollama-local",
      baseUrl: "http://localhost:11434/v1",
      models: [{ id: "llama3.1" }],
      fetch: stub.fetch,
    });

    const response = expectChatResponse(
      await provider.chat({ feature: "test.chat", messages: [{ role: "user", content: "ping" }] }, ctx),
    );

    const [url, init] = firstCall(stub);
    expect(url.toString()).toBe("http://localhost:11434/v1/chat/completions");
    expect(headers(init).authorization).toBeUndefined();
    expect(jsonBody(init)).toMatchObject({
      model: "llama3.1",
      stream: false,
      messages: [{ role: "user", content: "ping" }],
    });
    expect(response).toMatchObject({
      message: "pong",
      model: "llama3.1",
      providerId: "ollama-local",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      toolCalls: [{ id: "calendar.create", input: { title: "Demo" } }],
    });
  });

  it("calls Anthropic-compatible Messages endpoints with system prompts and beta headers", async () => {
    const stub = createFetchStub(
      () =>
        new Response(
          JSON.stringify({
            id: "msg-1",
            model: "claude-3-5-sonnet",
            content: [
              { type: "text", text: "done" },
              { type: "tool_use", id: "toolu-1", name: "mail.send", input: { subject: "Hi" } },
            ],
            usage: { input_tokens: 5, output_tokens: 6 },
          }),
          { status: 200 },
        ),
    );
    const provider = createAnthropicCompatibleProvider({
      id: "anthropic-direct",
      apiKey: "anthropic-key",
      models: [{ id: "claude-3-5-sonnet" }],
      betaHeaders: ["prompt-caching-2024-07-31"],
      maxTokens: 256,
      fetch: stub.fetch,
    });

    const response = expectChatResponse(
      await provider.chat(
        {
          feature: "test.chat",
          messages: [
            { role: "system", content: "Be brief." },
            { role: "user", content: "Draft it" },
          ],
        },
        ctx,
      ),
    );

    const [url, init] = firstCall(stub);
    expect(url.toString()).toBe("https://api.anthropic.com/v1/messages");
    expect(headers(init)).toMatchObject({
      "x-api-key": "anthropic-key",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
    });
    expect(jsonBody(init)).toMatchObject({
      model: "claude-3-5-sonnet",
      max_tokens: 256,
      system: "Be brief.",
      messages: [{ role: "user", content: "Draft it" }],
    });
    expect(response).toMatchObject({
      message: "done",
      toolCalls: [{ id: "mail.send", input: { subject: "Hi" } }],
      usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
    });
  });

  it("builds signed Bedrock invoke requests around Anthropic-shaped payloads", async () => {
    const stub = createFetchStub(
      () =>
        new Response(
          JSON.stringify({
            id: "bedrock-msg-1",
            model: "anthropic.claude-3-haiku-20240307-v1:0",
            content: [{ type: "text", text: "bedrock ok" }],
          }),
          { status: 200 },
        ),
    );
    const provider = createBedrockProvider({
      id: "bedrock",
      region: "us-east-1",
      credentials: {
        accessKeyId: "test-access",
        secretAccessKey: "test-secret",
        sessionToken: "test-token",
      },
      models: [{ id: "anthropic.claude-3-haiku-20240307-v1:0" }],
      fetch: stub.fetch,
      now: () => new Date("2026-05-20T12:34:56.000Z"),
    });

    const response = expectChatResponse(
      await provider.chat({ feature: "test.chat", messages: [{ role: "user", content: "hi" }] }, ctx),
    );

    const [url, init] = firstCall(stub);
    expect(url.origin).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
    expect(url.pathname).toBe("/model/anthropic.claude-3-haiku-20240307-v1%3A0/invoke");
    expect(headers(init)).toMatchObject({
      "x-amz-date": "20260520T123456Z",
      "x-amz-security-token": "test-token",
    });
    expect(headers(init).authorization).toContain("Credential=test-access/20260520/us-east-1/bedrock/aws4_request");
    expect(headers(init).authorization).toContain("SignedHeaders=accept;content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token");
    expect(jsonBody(init)).toMatchObject({
      anthropic_version: "bedrock-2023-05-31",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.message).toBe("bedrock ok");
  });

  it("builds Vertex rawPredict requests with bearer auth around Anthropic-shaped payloads", async () => {
    const stub = createFetchStub(
      () =>
        new Response(
          JSON.stringify({
            id: "vertex-msg-1",
            model: "claude-3-5-sonnet-v2",
            content: [{ type: "text", text: "vertex ok" }],
          }),
          { status: 200 },
        ),
    );
    const provider = createVertexProvider({
      id: "vertex",
      project: "helix-test",
      location: "us-central1",
      credentials: { accessToken: "vertex-token" },
      models: [{ id: "claude-3-5-sonnet-v2" }],
      fetch: stub.fetch,
    });

    const response = expectChatResponse(
      await provider.chat({ feature: "test.chat", messages: [{ role: "user", content: "hi" }] }, ctx),
    );

    const [url, init] = firstCall(stub);
    expect(url.origin).toBe("https://us-central1-aiplatform.googleapis.com");
    expect(url.pathname).toBe(
      "/v1/projects/helix-test/locations/us-central1/publishers/anthropic/models/claude-3-5-sonnet-v2:rawPredict",
    );
    expect(headers(init)).toMatchObject({
      authorization: "Bearer vertex-token",
      "x-goog-user-project": "helix-test",
    });
    expect(jsonBody(init)).toMatchObject({
      anthropic_version: "vertex-2023-10-16",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.message).toBe("vertex ok");
  });
});

describe("Vertex service-account token exchange", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("exchanges a signed JWT assertion at the token endpoint and uses the access token", async () => {
    const stub = createFetchStub((input) => {
      const url = new URL(requestUrl(input));
      if (url.toString() === "https://oauth2.googleapis.com/token") {
        return new Response(
          JSON.stringify({ access_token: "exchanged-token", expires_in: 3600 }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "vertex sa ok" }] }),
        { status: 200 },
      );
    });
    const provider = createVertexProvider({
      id: "vertex-sa",
      project: "helix-test",
      location: "us-central1",
      credentials: { clientEmail: "svc@helix-test.iam.gserviceaccount.com", privateKey: pem },
      models: [{ id: "claude-3-5-sonnet-v2" }],
      fetch: stub.fetch,
      now: () => new Date("2026-05-21T00:00:00.000Z"),
    });

    const response = expectChatResponse(
      await provider.chat({ feature: "test.chat", messages: [{ role: "user", content: "hi" }] }, ctx),
    );

    expect(response.message).toBe("vertex sa ok");
    const tokenCall = stub.calls[0];
    if (tokenCall === undefined) {
      throw new Error("Expected the token exchange call");
    }
    const [tokenInput, tokenInit] = tokenCall;
    expect(requestUrl(tokenInput)).toBe(
      "https://oauth2.googleapis.com/token",
    );
    expect(tokenInit?.method).toBe("POST");
    const bodyParams = new URLSearchParams(requestBody(tokenInit));
    expect(bodyParams.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    const assertion = bodyParams.get("assertion");
    expect(assertion).not.toBeNull();
    expect((assertion ?? "").split(".")).toHaveLength(3);

    const chatCall = stub.calls[1];
    if (chatCall === undefined) {
      throw new Error("Expected the chat call");
    }
    expect(headers(chatCall[1] as RequestInit).authorization).toBe("Bearer exchanged-token");
  });

  it("caches the access token until shortly before expiry", async () => {
    let tokenExchanges = 0;
    const stub = createFetchStub((input) => {
      const url = new URL(requestUrl(input));
      if (url.toString() === "https://oauth2.googleapis.com/token") {
        tokenExchanges += 1;
        return new Response(
          JSON.stringify({ access_token: `token-${String(tokenExchanges)}`, expires_in: 3600 }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
        status: 200,
      });
    });
    let current = new Date("2026-05-21T00:00:00.000Z");
    const provider = createVertexProvider({
      id: "vertex-sa",
      project: "helix-test",
      location: "us-central1",
      credentials: { clientEmail: "svc@helix-test.iam.gserviceaccount.com", privateKey: pem },
      models: [{ id: "claude-3-5-sonnet-v2" }],
      fetch: stub.fetch,
      now: () => current,
    });

    await provider.chat({ feature: "test.chat", messages: [{ role: "user", content: "hi" }] }, ctx);
    await provider.chat({ feature: "test.chat", messages: [{ role: "user", content: "hi" }] }, ctx);
    expect(tokenExchanges).toBe(1);

    // Advance past the cached token's refresh-before-expiry window.
    current = new Date(current.getTime() + 3600 * 1000);
    await provider.chat({ feature: "test.chat", messages: [{ role: "user", content: "hi" }] }, ctx);
    expect(tokenExchanges).toBe(2);
  });

  it("signs an RS256 assertion with the expected claims", () => {
    const assertion = signServiceAccountJwt({
      clientEmail: "svc@helix-test.iam.gserviceaccount.com",
      privateKey: pem,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      tokenUri: "https://oauth2.googleapis.com/token",
      issuedAt: new Date("2026-05-21T00:00:00.000Z"),
    });
    const segments = assertion.split(".");
    expect(segments).toHaveLength(3);
    const header = decodeJwtSegment(segments[0]);
    const payload = decodeJwtSegment(segments[1]);
    expect(header).toMatchObject({ alg: "RS256", typ: "JWT" });
    expect(payload).toMatchObject({
      iss: "svc@helix-test.iam.gserviceaccount.com",
      aud: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/cloud-platform",
    });
    const exp = payload.exp;
    const iat = payload.iat;
    expect(typeof exp === "number" && typeof iat === "number" ? exp - iat : 0).toBe(3600);
  });

  it("rejects malformed token-exchange responses", () => {
    expect(() => parseTokenResponse({})).toThrow(/access_token/u);
    expect(parseTokenResponse({ access_token: "abc" }).expiresInSeconds).toBe(3600);
  });
});

describe("Bedrock AWS credential resolution", () => {
  it("prefers explicit static credentials", async () => {
    const resolved = await resolveAwsCredentials({
      static: { accessKeyId: "STATIC", secretAccessKey: "STATIC-SECRET" },
      env: { AWS_ACCESS_KEY_ID: "ENV", AWS_SECRET_ACCESS_KEY: "ENV-SECRET" },
    });
    expect(resolved).toEqual({ accessKeyId: "STATIC", secretAccessKey: "STATIC-SECRET" });
  });

  it("falls back to environment variables when no static credentials exist", async () => {
    const resolved = await resolveAwsCredentials({
      env: {
        AWS_ACCESS_KEY_ID: "ENV",
        AWS_SECRET_ACCESS_KEY: "ENV-SECRET",
        AWS_SESSION_TOKEN: "ENV-SESSION",
      },
      sharedCredentialsFile: "/nonexistent/aws/credentials",
      imdsEndpoint: "http://127.0.0.1:1",
      imdsTimeoutMs: 10,
    });
    expect(resolved).toEqual({
      accessKeyId: "ENV",
      secretAccessKey: "ENV-SECRET",
      sessionToken: "ENV-SESSION",
    });
  });

  it("resolves credentials from the EC2 instance metadata service (IMDSv2)", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      requests.push(url);
      if (url.endsWith("/latest/api/token")) {
        expect(init?.method).toBe("PUT");
        return new Response("imds-token", { status: 200 });
      }
      if (url.endsWith("/security-credentials/")) {
        expect((init?.headers as Record<string, string>)["x-aws-ec2-metadata-token"]).toBe(
          "imds-token",
        );
        return new Response("helix-instance-role", { status: 200 });
      }
      return new Response(
        JSON.stringify({
          AccessKeyId: "IMDS-KEY",
          SecretAccessKey: "IMDS-SECRET",
          Token: "IMDS-SESSION",
        }),
        { status: 200 },
      );
    };
    const resolved = await instanceMetadataCredentialProvider({ fetch: fetchImpl });
    expect(resolved).toEqual({
      accessKeyId: "IMDS-KEY",
      secretAccessKey: "IMDS-SECRET",
      sessionToken: "IMDS-SESSION",
    });
    expect(requests).toHaveLength(3);
  });

  it("returns null from IMDS when the metadata service is unreachable", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    expect(await instanceMetadataCredentialProvider({ fetch: fetchImpl })).toBeNull();
  });

  it("parses AWS_PROFILE-selected sections of the shared credentials file", () => {
    const ini = [
      "[default]",
      "aws_access_key_id = DEFAULT-KEY",
      "aws_secret_access_key = DEFAULT-SECRET",
      "",
      "[profile work]",
      "aws_access_key_id = WORK-KEY",
      "aws_secret_access_key = WORK-SECRET ; inline comment",
    ].join("\n");
    expect(parseIniSection(ini, "work")).toMatchObject({
      aws_access_key_id: "WORK-KEY",
      aws_secret_access_key: "WORK-SECRET",
    });
    expect(parseIniSection(ini, "missing")).toBeNull();
  });

  it("yields null env credentials when variables are absent", () => {
    expect(envCredentialProvider({})).toBeNull();
  });

  it("returns null for malformed instance-profile payloads", () => {
    expect(parseInstanceProfileCredentials("not json")).toBeNull();
    expect(parseInstanceProfileCredentials(JSON.stringify({ AccessKeyId: "k" }))).toBeNull();
  });

  it("signs Bedrock requests with credentials resolved from a provider function", async () => {
    const credentialProvider = createBedrockCredentialProvider({
      env: { AWS_ACCESS_KEY_ID: "ROLE-KEY", AWS_SECRET_ACCESS_KEY: "ROLE-SECRET" },
      sharedCredentialsFile: "/nonexistent/aws/credentials",
      imdsEndpoint: "http://127.0.0.1:1",
      imdsTimeoutMs: 10,
    });
    const stub = createFetchStub(
      () =>
        new Response(
          JSON.stringify({ content: [{ type: "text", text: "role ok" }] }),
          { status: 200 },
        ),
    );
    const provider = createBedrockProvider({
      id: "bedrock-role",
      region: "us-east-1",
      credentials: credentialProvider,
      models: [{ id: "anthropic.claude-3-haiku-20240307-v1:0" }],
      fetch: stub.fetch,
      now: () => new Date("2026-05-21T00:00:00.000Z"),
    });

    const response = expectChatResponse(
      await provider.chat({ feature: "test.chat", messages: [{ role: "user", content: "hi" }] }, ctx),
    );
    expect(response.message).toBe("role ok");
    const [, init] = firstCall(stub);
    expect(headers(init).authorization).toContain("Credential=ROLE-KEY/20260521/us-east-1/bedrock");
  });

  it("does not read the shared credentials file when env credentials are present", async () => {
    expect(
      await sharedConfigCredentialProvider(
        { AWS_PROFILE: "default" },
        "/nonexistent/aws/credentials",
      ),
    ).toBeNull();
  });
});

/** Encodes a list of frames as a UTF-8 byte stream, optionally splitting bytes mid-frame. */
function byteStream(frames: readonly string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return {
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) {
        yield encoder.encode(frame);
      }
    },
  };
}

/** Builds a streaming `fetch` stub whose response body replays the given SSE chunks. */
function createSseFetchStub(chunks: readonly string[], status = 200): typeof fetch {
  return async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

async function collectEvents(events: AsyncIterable<SseEvent>): Promise<readonly SseEvent[]> {
  const collected: SseEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function collectChunks(chunks: AsyncIterable<ChatChunk>): Promise<readonly ChatChunk[]> {
  const collected: ChatChunk[] = [];
  for await (const chunk of chunks) {
    collected.push(chunk);
  }
  return collected;
}

describe("SSE stream parsing", () => {
  it("reassembles events split across byte-chunk boundaries", async () => {
    const events = await collectEvents(
      parseSseStream(byteStream(["data: hel", "lo\n\nda", "ta: world\n\n"])),
    );
    expect(events).toEqual([
      { event: undefined, data: "hello" },
      { event: undefined, data: "world" },
    ]);
  });

  it("coalesces multi-line data fields and ignores comments", async () => {
    const events = await collectEvents(
      parseSseStream(byteStream([": keep-alive\nevent: message\ndata: line one\ndata: line two\n\n"])),
    );
    expect(events).toEqual([{ event: "message", data: "line one\nline two" }]);
  });

  it("emits a trailing event when the stream ends without a blank line", async () => {
    const events = await collectEvents(parseSseStream(byteStream(["data: tail"])));
    expect(events).toEqual([{ event: undefined, data: "tail" }]);
  });
});

describe("OpenAI streaming chunk assembly", () => {
  it("emits incremental text deltas and a usage-bearing terminal chunk", async () => {
    const events = parseSseStream(
      byteStream([
        'data: {"model":"gpt-4.1-mini","choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const chunks = await collectChunks(openAIChatChunks(events, "fallback"));
    expect(chunks.filter((chunk) => chunk.delta.length > 0).map((chunk) => chunk.delta)).toEqual([
      "Hel",
      "lo",
    ]);
    const final = chunks.at(-1);
    expect(final?.done).toBe(true);
    expect(final?.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    expect(final?.metadata?.model).toBe("gpt-4.1-mini");
  });

  it("assembles tool-call deltas fragmented across multiple SSE events", async () => {
    const events = parseSseStream(
      byteStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"calendar.create","arguments":"{\\"ti"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"tle\\":\\"Demo\\"}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const response = await collectChatChunks(
      openAIChatChunks(events, "fallback"),
      "openai-test",
      "fallback",
    );
    expect(response.toolCalls).toEqual([{ id: "calendar.create", input: { title: "Demo" } }]);
  });
});

describe("Anthropic streaming chunk assembly", () => {
  it("emits text-delta content and a usage-bearing terminal chunk", async () => {
    const events = parseSseStream(
      byteStream([
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-3-5-sonnet","usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n',
      ]),
    );
    const chunks = await collectChunks(anthropicChatChunks(events, "fallback"));
    expect(chunks.filter((chunk) => chunk.delta.length > 0).map((chunk) => chunk.delta)).toEqual([
      "Hi ",
      "there",
    ]);
    const final = chunks.at(-1);
    expect(final?.done).toBe(true);
    expect(final?.usage).toMatchObject({ inputTokens: 7, outputTokens: 4, totalTokens: 11 });
    expect(final?.metadata?.model).toBe("claude-3-5-sonnet");
  });

  it("assembles input_json_delta tool-call fragments into a tool call", async () => {
    const events = parseSseStream(
      byteStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu-1","name":"mail.send"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"subject"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\":\\"Hi\\"}"}}\n\n',
      ]),
    );
    const response = await collectChatChunks(
      anthropicChatChunks(events, "fallback"),
      "anthropic-test",
      "fallback",
    );
    expect(response.toolCalls).toEqual([{ id: "mail.send", input: { subject: "Hi" } }]);
  });
});

describe("provider chatStream methods", () => {
  it("streams OpenAI-compatible completions over SSE", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "openai-stream",
      apiKey: "key",
      models: [{ id: "gpt-4.1-mini" }],
      fetch: createSseFetchStub([
        'data: {"choices":[{"delta":{"content":"stream "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    });
    if (provider.chatStream === undefined) {
      throw new Error("Expected the OpenAI provider to expose chatStream");
    }
    const response = await collectChatChunks(
      provider.chatStream({ feature: "test.chat", messages: [{ role: "user", content: "ping" }] }, ctx),
      provider.id,
      "gpt-4.1-mini",
    );
    expect(response.message).toBe("stream ok");
  });

  it("streams Anthropic-compatible messages over SSE", async () => {
    const provider = createAnthropicCompatibleProvider({
      id: "anthropic-stream",
      apiKey: "key",
      models: [{ id: "claude-3-5-sonnet" }],
      fetch: createSseFetchStub([
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"streamed"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":1}}\n\n',
      ]),
    });
    if (provider.chatStream === undefined) {
      throw new Error("Expected the Anthropic provider to expose chatStream");
    }
    const response = await collectChatChunks(
      provider.chatStream({ feature: "test.chat", messages: [{ role: "user", content: "ping" }] }, ctx),
      provider.id,
      "claude-3-5-sonnet",
    );
    expect(response.message).toBe("streamed");
  });
});
