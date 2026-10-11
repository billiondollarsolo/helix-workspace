/**
 * Deterministic OpenAI-compatible model for live E2E runs.
 *
 * The live stack has no real AI provider, so the assistant could only prove that it
 * refuses to send. Point the API at this server (start with `tsx`; OPENAI_BASE_URL=http://127.0.0.1:<port>/v1,
 * OPENAI_API_KEY, OPENAI_MODEL, HELIX_AI_ALLOW_PRIVATE_NETWORK=true) and every chat
 * completion answers `${FAKE_MODEL_REPLY_PREFIX} <last user message>`, streamed or not.
 * It never calls tools, so runs stay deterministic and need no network or secrets.
 */
import { pathToFileURL } from "node:url";
import { createServer, type Server, type ServerResponse } from "node:http";

const FAKE_MODEL_ID = "helix-e2e-model";
export const FAKE_MODEL_REPLY_PREFIX = "Helix test model received:";

interface FakeChatMessage {
  readonly role?: unknown;
  readonly content?: unknown;
}

interface FakeChatRequest {
  readonly model?: unknown;
  readonly stream?: unknown;
  readonly messages?: unknown;
}

function fakeModelReply(body: FakeChatRequest): string {
  const messages: readonly FakeChatMessage[] = Array.isArray(body.messages)
    ? (body.messages as FakeChatMessage[])
    : [];
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  return `${FAKE_MODEL_REPLY_PREFIX} ${messageText(lastUser?.content).slice(0, 500)}`.trim();
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      if (typeof part === "string") return part;
      const text = (part as { readonly text?: unknown } | null)?.text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function createFakeModelServer(): Server {
  let completions = 0;
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fake-model.invalid");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      sendJson(response, 200, { object: "list", data: [{ id: FAKE_MODEL_ID, object: "model" }] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { ok: true, completions });
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      sendJson(response, 404, {
        error: { message: `No fake route for ${request.method ?? "?"} ${url.pathname}` },
      });
      return;
    }
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      let body: FakeChatRequest;
      try {
        body = JSON.parse(raw) as FakeChatRequest;
      } catch {
        sendJson(response, 400, { error: { message: "Request body must be JSON." } });
        return;
      }
      completions += 1;
      const id = `chatcmpl-fake-${String(completions)}`;
      const model = typeof body.model === "string" ? body.model : FAKE_MODEL_ID;
      const content = fakeModelReply(body);
      const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
      if (body.stream === true) {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const chunk = (choices: readonly unknown[], extra: Record<string, unknown> = {}) =>
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices, ...extra })}\n\n`;
        response.write(
          chunk([{ index: 0, delta: { role: "assistant", content }, finish_reason: null }]),
        );
        response.write(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
        response.write(chunk([], { usage }));
        response.end("data: [DONE]\n\n");
        return;
      }
      sendJson(response, 200, {
        id,
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage,
      });
    });
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.FAKE_MODEL_PORT ?? "28480");
  const host = process.env.FAKE_MODEL_HOST ?? "127.0.0.1";
  createFakeModelServer().listen(port, host, () => {
    console.log(`Fake OpenAI-compatible model listening on http://${host}:${String(port)}/v1`);
  });
}
