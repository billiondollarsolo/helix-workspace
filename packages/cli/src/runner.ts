import { once } from "node:events";
import { uploadLocalDriveFile } from "./upload.js";
import { existsSync, readFileSync, rmSync } from "node:fs";

import {
  buildHelixRequest,
  buildMcpRequest,
  buildMcpResourceListRequest,
  buildMcpResourceReadRequest,
  buildMcpToolCallRequest,
  buildMcpToolListRequest,
  credentialFilePath,
  type HelixCliEnv,
} from "./client.js";
import { generateCompletionScript } from "./completion.js";
import { CliUsageError, type HelixCommand, parseCliArgs, usage } from "./parser.js";

export interface CliIo {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly stdin: NodeJS.ReadableStream;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export async function runCli(
  args: readonly string[],
  env: HelixCliEnv,
  io: CliIo,
  fetchImpl: FetchLike = fetch,
): Promise<number> {
  const transport = fetchImpl;
  fetchImpl = (url, init) =>
    transport(url, { ...init, redirect: "error", signal: AbortSignal.timeout(120_000) });
  try {
    if (args.length === 1 && args[0] === "--version") {
      const metadata = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ) as { readonly version: string };
      io.stdout.write(`helix ${metadata.version}\n`);
      return 0;
    }
    const command = parseCliArgs(args);
    if (command.kind === "help") {
      io.stdout.write(`${usage}\n`);
      return 0;
    }

    if (command.kind === "mcp-serve") {
      return await serveMcpStdio(env, io, fetchImpl);
    }

    if (command.kind === "completion") {
      io.stdout.write(generateCompletionScript(command.shell));
      return 0;
    }

    if (command.kind === "logout") {
      return logout(env, io);
    }

    if (command.kind === "tool-list" && command.source === "openapi") {
      return await listOpenApiTools(env, io, fetchImpl);
    }

    if (command.kind === "tool-list" && command.source === "mcp") {
      return await listMcpTools(env, io, fetchImpl);
    }

    if (command.kind === "mcp-resource-list") {
      return await listMcpResources(env, io, fetchImpl);
    }

    if (command.kind === "mcp-resource-read") {
      return await readMcpResource(command.uri, env, io, fetchImpl);
    }

    if (command.kind === "tool-describe") {
      return await describeOpenApiTool(command.toolId, env, io, fetchImpl);
    }

    if (command.kind === "tool-call" && command.transport === "mcp") {
      const input = await resolveToolInput(command.json, io.stdin);
      return await callMcpTool(command.toolId, input, env, io, fetchImpl);
    }

    const input =
      command.kind === "tool-call" ? await resolveToolInput(command.json, io.stdin) : undefined;
    if (command.kind === "tool-call" && command.uploadPath !== undefined) {
      return await uploadLocalDriveFile(command.uploadPath, input, env, io, fetchImpl);
    }
    const request = buildHelixRequest(command, env, input);
    const response = await fetchImpl(request.url, request.init);
    const text = await response.text();

    if (!response.ok) {
      io.stderr.write(formatHttpError(response.status, text));
      return 1;
    }

    io.stdout.write(formatCommandOutput(command, text));
    return 0;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    if (error instanceof CliUsageError) {
      io.stderr.write(`${usage}\n`);
    }
    return 1;
  }
}

type OpenApiToolProjection = {
  readonly id: string;
  readonly path: string;
  readonly methods: readonly string[];
  readonly description?: string;
  readonly permission?: string;
  readonly sideEffects?: string;
  readonly confirmationRequired?: boolean;
  readonly inputSchema?: OpenApiSchemaValue;
  readonly outputSchema?: OpenApiSchemaValue;
};

type OpenApiSchemaValue = Record<string, unknown> | boolean;

type MutableOpenApiToolProjection = {
  id: string;
  path: string;
  methods: string[];
  description?: string;
  permission?: string;
  sideEffects?: string;
  confirmationRequired?: boolean;
  inputSchema?: OpenApiSchemaValue;
  outputSchema?: OpenApiSchemaValue;
};

async function listOpenApiTools(
  env: HelixCliEnv,
  io: CliIo,
  fetchImpl: FetchLike,
): Promise<number> {
  const document = await fetchOpenApiDocument(env, io, fetchImpl);
  if (document === undefined) {
    return 1;
  }

  io.stdout.write(formatJsonValue({ tools: projectOpenApiTools(document) }));
  return 0;
}

async function describeOpenApiTool(
  toolId: string,
  env: HelixCliEnv,
  io: CliIo,
  fetchImpl: FetchLike,
): Promise<number> {
  const document = await fetchOpenApiDocument(env, io, fetchImpl);
  if (document === undefined) {
    return 1;
  }

  const tool = projectOpenApiTools(document).find((entry) => entry.id === toolId);
  if (tool === undefined) {
    io.stderr.write(`Tool not found in OpenAPI document: ${toolId}\n`);
    return 1;
  }

  io.stdout.write(formatJsonValue(tool));
  return 0;
}

async function fetchOpenApiDocument(
  env: HelixCliEnv,
  io: CliIo,
  fetchImpl: FetchLike,
): Promise<Record<string, unknown> | undefined> {
  const request = buildHelixRequest({ kind: "openapi-get" }, env);
  const response = await fetchImpl(request.url, request.init);
  const text = await response.text();
  if (!response.ok) {
    io.stderr.write(formatHttpError(response.status, text));
    return undefined;
  }
  const parsed = parseJsonText(text, "OpenAPI document");
  if (!isRecord(parsed)) {
    throw new Error("OpenAPI document was not a JSON object.");
  }
  return parsed;
}

/**
 * Performs an MCP JSON-RPC request and returns the wrapped `result` payload.
 * Returns `undefined` after writing the HTTP or JSON-RPC failure to stderr, so
 * callers only have to decide how to render a success.
 */
async function fetchMcpResult(
  request: ReturnType<typeof buildMcpRequest>,
  io: CliIo,
  fetchImpl: FetchLike,
): Promise<{ readonly value: unknown } | undefined> {
  const response = await fetchImpl(request.url, request.init);
  const text = await response.text();
  if (!response.ok) {
    io.stderr.write(formatHttpError(response.status, text));
    return undefined;
  }

  const result = parseMcpResult(text);
  if (!result.ok) {
    io.stderr.write(`${result.message}\n`);
    return undefined;
  }

  return { value: result.value };
}

async function listMcpTools(env: HelixCliEnv, io: CliIo, fetchImpl: FetchLike): Promise<number> {
  const result = await fetchMcpResult(buildMcpToolListRequest(env), io, fetchImpl);
  if (result === undefined) {
    return 1;
  }

  io.stdout.write(formatJsonValue(normalizeMcpToolListResult(result.value)));
  return 0;
}

async function callMcpTool(
  toolId: string,
  input: unknown,
  env: HelixCliEnv,
  io: CliIo,
  fetchImpl: FetchLike,
): Promise<number> {
  const result = await fetchMcpResult(buildMcpToolCallRequest(env, toolId, input), io, fetchImpl);
  if (result === undefined) {
    return 1;
  }

  io.stdout.write(formatJsonValue(unwrapMcpToolCallResult(result.value)));
  return isRecord(result.value) && result.value.isError === true ? 1 : 0;
}

async function listMcpResources(
  env: HelixCliEnv,
  io: CliIo,
  fetchImpl: FetchLike,
): Promise<number> {
  const request = buildMcpResourceListRequest(env);
  return await writeMcpJsonResult(request, io, fetchImpl);
}

async function readMcpResource(
  uri: string,
  env: HelixCliEnv,
  io: CliIo,
  fetchImpl: FetchLike,
): Promise<number> {
  const request = buildMcpResourceReadRequest(env, uri);
  return await writeMcpJsonResult(request, io, fetchImpl);
}

async function writeMcpJsonResult(
  request: ReturnType<typeof buildMcpRequest>,
  io: CliIo,
  fetchImpl: FetchLike,
): Promise<number> {
  const result = await fetchMcpResult(request, io, fetchImpl);
  if (result === undefined) {
    return 1;
  }

  io.stdout.write(formatJsonValue(result.value));
  return 0;
}

function projectOpenApiTools(document: unknown): readonly OpenApiToolProjection[] {
  const paths = isRecord(document) && isRecord(document.paths) ? document.paths : {};
  const tools = new Map<string, MutableOpenApiToolProjection>();

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) {
      continue;
    }

    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const operation = pathItem[method];
      if (!isRecord(operation)) {
        continue;
      }
      const metadata = isRecord(operation["x-helix-tool"]) ? operation["x-helix-tool"] : undefined;
      const toolId = typeof metadata?.id === "string" ? metadata.id : undefined;
      if (toolId === undefined) {
        continue;
      }

      const existing = tools.get(toolId) ?? { id: toolId, path, methods: [] };
      if (!existing.methods.includes(method)) {
        existing.methods.push(method);
        existing.methods.sort();
      }
      copyString(operation.summary, existing, "description");
      copyString(metadata?.permission, existing, "permission");
      copyString(metadata?.sideEffects, existing, "sideEffects");
      if (typeof metadata?.confirmationRequired === "boolean") {
        existing.confirmationRequired = metadata.confirmationRequired;
      }
      const inputSchema =
        method === "post" ? postInputSchema(operation) : getInputSchema(operation);
      if (inputSchema !== undefined && (method === "post" || existing.inputSchema === undefined)) {
        existing.inputSchema = inputSchema;
      }
      const outputSchema = responseSchema(operation);
      if (
        outputSchema !== undefined &&
        (method === "post" || existing.outputSchema === undefined)
      ) {
        existing.outputSchema = outputSchema;
      }
      tools.set(toolId, existing);
    }
  }

  return Array.from(tools.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function postInputSchema(operation: Record<string, unknown>): OpenApiSchemaValue | undefined {
  const requestBody = operation.requestBody;
  if (!isRecord(requestBody) || !isRecord(requestBody.content)) {
    return undefined;
  }
  const jsonContent = requestBody.content["application/json"];
  return isRecord(jsonContent) ? schemaValue(jsonContent.schema) : undefined;
}

function getInputSchema(operation: Record<string, unknown>): OpenApiSchemaValue | undefined {
  const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
  for (const parameter of parameters) {
    if (!isRecord(parameter) || parameter.name !== "input") {
      continue;
    }
    return schemaValue(parameter.schema);
  }
  return undefined;
}

function responseSchema(operation: Record<string, unknown>): OpenApiSchemaValue | undefined {
  const responses = operation.responses;
  if (!isRecord(responses)) {
    return undefined;
  }
  const okResponse = responses["200"];
  if (!isRecord(okResponse) || !isRecord(okResponse.content)) {
    return undefined;
  }
  const jsonContent = okResponse.content["application/json"];
  return isRecord(jsonContent) ? schemaValue(jsonContent.schema) : undefined;
}

function schemaValue(value: unknown): OpenApiSchemaValue | undefined {
  return isRecord(value) || typeof value === "boolean" ? value : undefined;
}

function copyString(
  value: unknown,
  target: MutableOpenApiToolProjection,
  key: "description" | "permission" | "sideEffects",
): void {
  if (typeof value === "string" && value.length > 0) {
    target[key] = value;
  }
}

function normalizeMcpToolListResult(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.tools)) {
    return result;
  }
  const tools: readonly unknown[] = result.tools as readonly unknown[];

  return {
    tools: tools.map((tool) => {
      if (!isRecord(tool)) {
        return tool;
      }
      return {
        ...(typeof tool.name === "string" ? { id: tool.name, name: tool.name } : {}),
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      };
    }),
  };
}

function unwrapMcpToolCallResult(result: unknown): unknown {
  if (isRecord(result) && result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  return result;
}

function parseMcpResult(
  text: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string } {
  const parsed = parseJsonText(text, "MCP response");
  if (!isRecord(parsed)) {
    return { ok: false, message: "Invalid MCP response." };
  }

  if (isRecord(parsed.error)) {
    const message =
      typeof parsed.error.message === "string" ? parsed.error.message : "MCP request failed.";
    return { ok: false, message };
  }

  if (parsed.jsonrpc !== "2.0" || !Object.hasOwn(parsed, "result")) {
    return { ok: false, message: "Invalid MCP response." };
  }
  return { ok: true, value: parsed.result };
}

function parseJsonText(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} was not valid JSON.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type McpInputFrame = {
  readonly body: string;
  readonly framing: "content-length" | "line";
};

async function serveMcpStdio(env: HelixCliEnv, io: CliIo, fetchImpl: FetchLike): Promise<number> {
  let buffer: Buffer = Buffer.alloc(0);

  for await (const chunk of io.stdin) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    const parsed = extractMcpFrames(buffer, false);
    buffer = parsed.remaining;
    for (const frame of parsed.frames) {
      await forwardMcpFrame(frame, env, io, fetchImpl);
    }
  }

  const parsed = extractMcpFrames(buffer, true);
  for (const frame of parsed.frames) {
    await forwardMcpFrame(frame, env, io, fetchImpl);
  }
  if (parsed.remaining.toString("utf8").trim().length > 0) {
    throw new Error("Incomplete MCP JSON-RPC message.");
  }

  return 0;
}

async function forwardMcpFrame(
  frame: McpInputFrame,
  env: HelixCliEnv,
  io: CliIo,
  fetchImpl: FetchLike,
): Promise<void> {
  let message: unknown;
  const failure = (id: string | number | null, code: number, reason: string) =>
    writeMcpFrame(
      io.stdout,
      frame.framing,
      JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: reason } }),
    );
  try {
    message = JSON.parse(frame.body) as unknown;
  } catch {
    await failure(null, -32700, "Parse error.");
    return;
  }
  if (
    !isRecord(message) ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string" ||
    (Object.hasOwn(message, "id") &&
      message.id !== null &&
      typeof message.id !== "string" &&
      typeof message.id !== "number")
  ) {
    await failure(null, -32600, "Invalid request.");
    return;
  }
  const notification = !Object.hasOwn(message, "id");
  const id = notification ? null : (message.id as string | number | null);
  try {
    const request = buildMcpRequest(env, frame.body);
    const response = await fetchImpl(request.url, request.init);
    if (!response.ok) {
      if (!notification)
        await failure(id, -32000, `Helix MCP request failed (${String(response.status)}).`);
      io.stderr.write(`Helix MCP request failed (${String(response.status)}).\n`);
      return;
    }
    if (notification) return;
    const text = await response.text();
    const result: unknown = JSON.parse(text);
    if (
      !isRecord(result) ||
      result.jsonrpc !== "2.0" ||
      result.id !== id ||
      Object.hasOwn(result, "result") === Object.hasOwn(result, "error")
    ) {
      await failure(id, -32603, "Invalid Helix MCP response.");
      return;
    }
    await writeMcpFrame(io.stdout, frame.framing, text);
  } catch {
    if (!notification) await failure(id, -32000, "Helix MCP transport failed.");
    io.stderr.write("Helix MCP transport failed.\n");
  }
}

const MAX_MCP_FRAME_BYTES = 1024 * 1024;

function extractMcpFrames(
  buffer: Buffer,
  endOfInput: boolean,
): { readonly frames: readonly McpInputFrame[]; readonly remaining: Buffer } {
  const frames: McpInputFrame[] = [];
  let remaining = buffer;
  while (remaining.length > 0) {
    while (remaining.length > 0 && [9, 10, 13, 32].includes(remaining[0] ?? -1))
      remaining = remaining.subarray(1);
    if (remaining.length === 0) break;
    if (/^content-length:/i.test(remaining.subarray(0, 15).toString("ascii"))) {
      let separatorLength = 4;
      let headerEnd = remaining.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        headerEnd = remaining.indexOf("\n\n");
        separatorLength = 2;
      }
      if (headerEnd < 0) {
        if (remaining.length > 8192) throw new Error("MCP headers exceed the size limit.");
        break;
      }
      if (headerEnd > 8192) throw new Error("MCP headers exceed the size limit.");
      const lengths = remaining
        .subarray(0, headerEnd)
        .toString("ascii")
        .split(/\r?\n/)
        .filter((line) => /^content-length:/i.test(line));
      const value = lengths[0]?.slice("content-length:".length).trim() ?? "";
      const length = Number(value);
      if (
        lengths.length !== 1 ||
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(length) ||
        length > MAX_MCP_FRAME_BYTES
      )
        throw new Error("Invalid or oversized MCP Content-Length header.");
      const bodyStart = headerEnd + separatorLength;
      const bodyEnd = bodyStart + length;
      if (remaining.length < bodyEnd) break;
      frames.push({
        body: remaining.subarray(bodyStart, bodyEnd).toString("utf8"),
        framing: "content-length",
      });
      remaining = remaining.subarray(bodyEnd);
      continue;
    }
    const lineEnd = remaining.indexOf(10);
    if ((lineEnd < 0 ? remaining.length : lineEnd) > MAX_MCP_FRAME_BYTES)
      throw new Error("MCP message exceeds the size limit.");
    if (lineEnd < 0 && !endOfInput) break;
    const end = lineEnd < 0 ? remaining.length : lineEnd;
    const body = remaining.subarray(0, end).toString("utf8").trim();
    if (body.length > 0) frames.push({ body, framing: "line" });
    remaining = remaining.subarray(lineEnd < 0 ? end : end + 1);
  }
  return { frames, remaining };
}

async function writeMcpFrame(
  stream: NodeJS.WritableStream,
  framing: McpInputFrame["framing"],
  body: string,
): Promise<void> {
  const normalizedBody = body.trim();
  const output =
    framing === "content-length"
      ? `Content-Length: ${String(Buffer.byteLength(normalizedBody, "utf8"))}\r\n\r\n${normalizedBody}`
      : `${normalizedBody}\n`;
  if (!stream.write(output)) await once(stream, "drain");
}

async function resolveToolInput(
  json: { readonly source: "empty" | "inline" | "stdin"; readonly value?: string },
  stdin: NodeJS.ReadableStream,
): Promise<unknown> {
  if (json.source === "empty") {
    return {};
  }

  const raw = json.source === "inline" ? json.value : await readAll(stdin);
  if (raw === undefined || raw.trim().length === 0) {
    return {};
  }

  return JSON.parse(raw) as unknown;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let output = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    output += String(chunk);
    if (Buffer.byteLength(output, "utf8") > 16 * 1024 * 1024)
      throw new Error("JSON input exceeds 16 MiB.");
  }
  return output;
}

function formatJsonText(text: string): string {
  if (text.trim().length === 0) {
    return "";
  }

  try {
    return `${JSON.stringify(JSON.parse(text) as unknown, null, 2)}\n`;
  } catch {
    return text.endsWith("\n") ? text : `${text}\n`;
  }
}

function formatJsonValue(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatCommandOutput(command: HelixCommand, text: string): string {
  const formatted = formatJsonText(text);
  if (command.kind !== "auth-token" || command.printExport !== true) {
    return formatted;
  }

  const accessToken = parseAccessToken(text);
  if (accessToken === undefined) {
    return formatted;
  }

  return `${formatted}${formatted.length > 0 ? "\n" : ""}export HELIX_ACCESS_TOKEN=${shellQuote(accessToken)}\n`;
}

function parseAccessToken(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const accessToken = (parsed as Record<string, unknown>).access_token;
    return typeof accessToken === "string" && accessToken.length > 0 ? accessToken : undefined;
  } catch {
    return undefined;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatHttpError(status: number, text: string): string {
  const body = text.trim().length === 0 ? "" : ` ${text}`;
  return `Helix API request failed (${String(status)}).${body}\n`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown CLI error";
}

function logout(env: HelixCliEnv, io: CliIo): number {
  const path = credentialFilePath(env);
  let removed: boolean;
  try {
    removed = existsSync(path);
    rmSync(path, { force: true });
  } catch (error) {
    io.stderr.write(`Failed to clear stored credentials: ${formatError(error)}\n`);
    return 1;
  }

  io.stdout.write(
    removed
      ? `Logged out. Cleared stored credentials at ${path}.\n`
      : `Logged out. No stored credentials found at ${path}.\n`,
  );
  if (env.HELIX_ACCESS_TOKEN !== undefined && env.HELIX_ACCESS_TOKEN.length > 0) {
    io.stderr.write(
      "Note: HELIX_ACCESS_TOKEN is still set in this shell. Run: unset HELIX_ACCESS_TOKEN\n",
    );
  }
  return 0;
}
