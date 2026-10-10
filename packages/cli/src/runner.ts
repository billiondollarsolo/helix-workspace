import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { uploadLocalDriveFile } from "./upload.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

import {
  buildHelixRequest,
  buildMcpRequest,
  buildMcpResourceListRequest,
  buildMcpResourceReadRequest,
  buildMcpToolCallRequest,
  buildMcpToolListRequest,
  credentialFilePath,
  type HelixCliEnv,
  type HelixRequest,
} from "./client.js";
import { generateCompletionScript } from "./completion.js";
import {
  createHttpClient,
  EXIT_CODES,
  sendForText,
  type FetchLike,
  type HttpClient,
} from "./http.js";
import {
  extractGlobalOptions,
  type GlobalOptions,
  pendingActionId,
  reportError,
  reportPending,
  wantsJsonOutput,
} from "./options.js";
import { CliUsageError, type HelixCommand, type JsonArgument, parseCliArgs } from "./parser.js";
import { scopedUsage, usage } from "./usage.js";

export type { FetchLike } from "./http.js";

export interface CliIo {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly stdin: NodeJS.ReadableStream;
}

/** Test seams for retry backoff and idempotency key generation. */
export interface CliDependencies {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly randomUUID?: () => string;
}

/** Everything a command needs to talk to Helix for one CLI invocation. */
export interface CliContext {
  readonly env: HelixCliEnv;
  readonly io: CliIo;
  readonly http: HttpClient;
  readonly options: GlobalOptions;
  /** Idempotency-Key for this invocation's tool calls, reused across retries. */
  readonly idempotencyKey: string;
  readonly newIdempotencyKey: () => string;
}

export async function runCli(
  args: readonly string[],
  env: HelixCliEnv,
  io: CliIo,
  fetchImpl: FetchLike = fetch,
  dependencies: CliDependencies = {},
): Promise<number> {
  let output: GlobalOptions["output"] = wantsJsonOutput(args) ? "json" : "text";
  try {
    if (args.length === 1 && args[0] === "--version") {
      const metadata = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ) as { readonly version: string };
      io.stdout.write(`helix ${metadata.version}\n`);
      return 0;
    }
    const extracted = extractGlobalOptions(args, env);
    const options = extracted.options;
    output = options.output;
    if (options.help !== undefined) {
      io.stdout.write(`${options.help.length === 0 ? usage : scopedUsage(options.help)}\n`);
      return 0;
    }
    const command = parseCliArgs(extracted.args);
    if (command.kind === "help") {
      io.stdout.write(`${usage}\n`);
      return 0;
    }

    const newIdempotencyKey = dependencies.randomUUID ?? randomUUID;
    const context: CliContext = {
      env,
      io,
      options,
      http: createHttpClient(fetchImpl, {
        timeoutMs: options.timeoutMs,
        sleep: dependencies.sleep ?? ((ms) => wait(ms)),
      }),
      idempotencyKey: options.idempotencyKey ?? newIdempotencyKey(),
      newIdempotencyKey,
    };
    return await runCommand(command, context);
  } catch (error) {
    return reportError(io.stderr, output, error, usage);
  }
}

async function runCommand(command: HelixCommand, context: CliContext): Promise<number> {
  const { env, io } = context;
  switch (command.kind) {
    case "mcp-serve":
      return await serveMcpStdio(context);
    case "completion":
      io.stdout.write(generateCompletionScript(command.shell));
      return 0;
    case "logout":
      return logout(env, io);
    case "mcp-resource-list":
      return await writeMcpJsonResult(buildMcpResourceListRequest(env), context);
    case "mcp-resource-read":
      return await writeMcpJsonResult(buildMcpResourceReadRequest(env, command.uri), context);
    case "tool-describe":
      return await describeOpenApiTool(command.toolId, context);
    default:
      break;
  }
  if (command.kind === "tool-list" && command.source === "openapi") {
    io.stdout.write(formatJsonValue({ tools: projectOpenApiTools(await fetchOpenApi(context)) }));
    return 0;
  }
  if (command.kind === "tool-list" && command.source === "mcp") {
    const result = await fetchMcpResult(buildMcpToolListRequest(env), context, true);
    io.stdout.write(formatJsonValue(normalizeMcpToolListResult(result)));
    return 0;
  }

  const input =
    command.kind === "tool-call" ? await resolveToolInput(command.json, io.stdin) : undefined;
  if (command.kind === "tool-call" && command.transport === "mcp") {
    return await callMcpTool(command.toolId, input, context);
  }
  if (command.kind === "tool-call" && command.uploadPath !== undefined) {
    return await uploadLocalDriveFile(command.uploadPath, input, context);
  }
  const isToolCall = command.kind === "tool-call";
  const request = buildHelixRequest(
    command,
    env,
    input,
    isToolCall ? context.idempotencyKey : undefined,
  );
  const text = await sendForText(request, context, isToolCall || request.init.method === "GET");
  io.stdout.write(formatCommandOutput(command, text.body));
  return text.status === 202 ? reportPendingBody(text.body, context) : 0;
}

function reportPendingBody(body: string, context: CliContext): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return 0;
  }
  const actionId = pendingActionId(parsed);
  return actionId === undefined
    ? 0
    : reportPending(context.io.stderr, context.options.output, actionId);
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

async function describeOpenApiTool(toolId: string, context: CliContext): Promise<number> {
  const document = await fetchOpenApi(context);
  const tool = projectOpenApiTools(document).find((entry) => entry.id === toolId);
  if (tool === undefined) {
    context.io.stderr.write(`Tool not found in OpenAPI document: ${toolId}\n`);
    return EXIT_CODES.notFound;
  }

  context.io.stdout.write(formatJsonValue(tool));
  return 0;
}

async function fetchOpenApi(context: CliContext): Promise<Record<string, unknown>> {
  const request = buildHelixRequest({ kind: "openapi-get" }, context.env);
  const { body } = await sendForText(request, context, true);
  const parsed = parseJsonText(body, "OpenAPI document");
  if (!isRecord(parsed)) {
    throw new Error("OpenAPI document was not a JSON object.");
  }
  return parsed;
}

/**
 * Performs an MCP JSON-RPC request and returns the wrapped `result` payload.
 * HTTP failures throw {@link HttpError}; JSON-RPC errors throw their message.
 */
async function fetchMcpResult(
  request: HelixRequest,
  context: CliContext,
  idempotent: boolean,
): Promise<unknown> {
  const { body } = await sendForText(request, context, idempotent);
  const result = parseMcpResult(body);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.value;
}

async function callMcpTool(toolId: string, input: unknown, context: CliContext): Promise<number> {
  const request = buildMcpToolCallRequest(context.env, toolId, input, context.idempotencyKey);
  // MCP honours the idempotency key only for agent mutations, so network
  // errors are not retried here; 429 is still retried.
  const result = await fetchMcpResult(request, context, false);
  context.io.stdout.write(formatJsonValue(unwrapMcpToolCallResult(result)));
  return isRecord(result) && result.isError === true ? 1 : 0;
}

async function writeMcpJsonResult(request: HelixRequest, context: CliContext): Promise<number> {
  context.io.stdout.write(formatJsonValue(await fetchMcpResult(request, context, true)));
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

async function serveMcpStdio(context: CliContext): Promise<number> {
  const { io } = context;
  let buffer: Buffer = Buffer.alloc(0);

  for await (const chunk of io.stdin) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    const parsed = extractMcpFrames(buffer, false);
    buffer = parsed.remaining;
    for (const frame of parsed.frames) {
      await forwardMcpFrame(frame, context);
    }
  }

  const parsed = extractMcpFrames(buffer, true);
  for (const frame of parsed.frames) {
    await forwardMcpFrame(frame, context);
  }
  if (parsed.remaining.toString("utf8").trim().length > 0) {
    throw new Error("Incomplete MCP JSON-RPC message.");
  }

  return 0;
}

async function forwardMcpFrame(frame: McpInputFrame, context: CliContext): Promise<void> {
  const { env, io } = context;
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
    // The MCP client owns retries for forwarded frames; only 429 is retried here.
    const response = await context.http.send(request.url, request.init, { idempotent: false });
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
  json: JsonArgument,
  stdin: NodeJS.ReadableStream & { readonly isTTY?: boolean },
): Promise<unknown> {
  if (json.source === "empty") {
    return {};
  }
  if (json.source === "stdin" && stdin.isTTY === true) {
    // CA14: never block waiting for an interactive terminal.
    throw new CliUsageError(
      "--json without a value reads JSON from stdin, but stdin is a terminal. Pass --json '<JSON>' or pipe JSON into the command.",
    );
  }

  const raw = json.source === "inline" ? json.value : await readAll(stdin);
  if (raw.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const where = json.source === "inline" ? "--json argument" : "stdin";
    const reason = error instanceof Error ? error.message : "invalid JSON";
    throw new CliUsageError(`Invalid JSON in ${where}: ${reason}`);
  }
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
