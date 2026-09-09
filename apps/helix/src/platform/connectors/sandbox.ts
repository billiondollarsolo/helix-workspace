import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { OutboundWebhookEvent, RenderedWebhookRequest } from "../webhooks/formats/types.js";
import { resolvePluginArtifactPath, type DiscoveredPlugin } from "../plugins/loader.js";

const ACTION_TIMEOUT_MS = 2_000;
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_OLD_SPACE_MB = 64;

export interface SandboxRegistration {
  readonly formats: readonly string[];
  readonly sources: readonly string[];
}

interface SandboxReply {
  readonly requestId: number;
  readonly ok: boolean;
  readonly result?: unknown;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

/**
 * One OS process per connector. Node's permission model denies network,
 * child-process, worker, native-addon and filesystem access except read-only
 * imports from the already-verified bundle. The child receives no environment
 * and exposes only the two connector operations below.
 */
export class ConnectorSandbox {
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, PendingRequest>();
  #nextRequestId = 1;
  #closed = false;

  private constructor(child: ChildProcess) {
    this.#child = child;
    child.on("message", (message: unknown) => {
      this.#receive(message);
    });
    child.once("error", () => {
      this.#terminate(new Error("Connector sandbox failed."));
    });
    child.once("exit", () => {
      this.#terminate(new Error("Connector sandbox exited."));
    });
  }

  static async start(plugin: DiscoveredPlugin): Promise<{
    readonly sandbox: ConnectorSandbox;
    readonly registration: SandboxRegistration;
  }> {
    const main = plugin.manifest.main;
    if (main === undefined || main === null || main.length === 0) {
      throw new Error(`Connector ${plugin.manifest.id} is missing manifest.main.`);
    }
    const entryUrl = pathToFileURL(await resolvePluginArtifactPath(plugin, main)).href;
    const rootUrl = `${pathToFileURL(plugin.rootDir).href.replace(/\/$/u, "")}/`;
    const child = spawn(
      process.execPath,
      [
        "--permission",
        "--allow-worker",
        `--allow-fs-read=${plugin.rootDir}`,
        `--max-old-space-size=${String(MAX_OLD_SPACE_MB)}`,
        "--disable-proto=throw",
        "--input-type=module",
        "--eval",
        SANDBOX_SOURCE,
      ],
      {
        env: {},
        serialization: "json",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const sandbox = new ConnectorSandbox(child);
    try {
      const result = await sandbox.#request("register", {
        entryUrl,
        pluginId: plugin.manifest.id,
        rootUrl,
      });
      return { sandbox, registration: registration(result, plugin.manifest.id) };
    } catch (error) {
      sandbox.close();
      throw error;
    }
  }

  async render(formatId: string, event: OutboundWebhookEvent): Promise<RenderedWebhookRequest> {
    return renderedRequest(await this.#request("render", { event, formatId }));
  }

  async verify(
    sourceId: string,
    input: {
      readonly headers: Readonly<Record<string, string>>;
      readonly rawBody: string;
      readonly secret: string;
    },
  ): Promise<boolean> {
    const result = await this.#request("verify", { input, sourceId });
    if (typeof result !== "boolean") throw new Error("Connector returned an invalid decision.");
    return result;
  }

  close(): void {
    if (this.#closed) return;
    this.#terminate(new Error("Connector sandbox closed."));
  }

  #request(action: string, payload: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.#closed || !this.#child.connected) {
      return Promise.reject(new Error("Connector sandbox is unavailable."));
    }
    const requestId = this.#nextRequestId++;
    const message = { action, payload, requestId };
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_MESSAGE_BYTES) {
      return Promise.reject(new Error("Connector request exceeds the sandbox limit."));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        this.#terminate(new Error("Connector sandbox timed out."));
        reject(new Error("Connector sandbox timed out."));
      }, ACTION_TIMEOUT_MS);
      timeout.unref();
      this.#pending.set(requestId, { reject, resolve, timeout });
      this.#child.send(message, (error) => {
        if (error === null) return;
        clearTimeout(timeout);
        this.#pending.delete(requestId);
        reject(new Error("Connector sandbox request failed."));
      });
    });
  }

  #receive(message: unknown): void {
    if (
      !isRecord(message) ||
      typeof message.requestId !== "number" ||
      typeof message.ok !== "boolean"
    ) {
      this.#terminate(new Error("Connector sandbox protocol violation."));
      return;
    }
    const reply: SandboxReply = {
      requestId: message.requestId,
      ok: message.ok,
      ...(message.result === undefined ? {} : { result: message.result }),
    };
    const pending = this.#pending.get(reply.requestId);
    if (pending === undefined) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(reply.requestId);
    if (!reply.ok) {
      pending.reject(new Error("Connector sandbox action failed."));
      return;
    }
    if (Buffer.byteLength(JSON.stringify(reply.result)) > MAX_MESSAGE_BYTES) {
      pending.reject(new Error("Connector response exceeds the sandbox limit."));
      return;
    }
    pending.resolve(reply.result);
  }

  #terminate(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.kill("SIGKILL");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function registration(value: unknown, pluginId: string): SandboxRegistration {
  if (!isRecord(value) || value.pluginId !== pluginId) {
    throw new Error(`Connector ${pluginId} returned invalid registration.`);
  }
  return {
    formats: identifierList(value.formats, pluginId),
    sources: identifierList(value.sources, pluginId),
  };
}

function identifierList(value: unknown, pluginId: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error(`Connector ${pluginId} returned invalid registration.`);
  }
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(id)) {
      throw new Error(`Connector ${pluginId} returned invalid registration.`);
    }
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Connector ${pluginId} returned invalid registration.`);
  }
  return ids;
}

function renderedRequest(value: unknown): RenderedWebhookRequest {
  if (!isRecord(value) || value.contentType !== "application/json" || !("body" in value)) {
    throw new Error("Connector returned an invalid webhook payload.");
  }
  JSON.stringify(value.body);
  return { contentType: "application/json", body: jsonValue(value.body) };
}

function jsonValue(value: unknown): RenderedWebhookRequest["body"] {
  return JSON.parse(JSON.stringify(value)) as RenderedWebhookRequest["body"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LOADER_SOURCE = `
let rootUrl;
export function initialize(data) { rootUrl = data.rootUrl; }
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (typeof rootUrl !== "string" || !resolved.url.startsWith(rootUrl)) {
    throw new Error("Connector import denied.");
  }
  return resolved;
}
`;

const LOADER_URL = `data:text/javascript,${encodeURIComponent(LOADER_SOURCE)}`;

const SANDBOX_SOURCE = `
import { register } from "node:module";
const runtime = process;
const formats = new Map();
const sources = new Map();
let initialized = false;
const reply = (requestId, ok, result) => runtime.send?.({ requestId, ok, result });
const safeResult = (value) => {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > ${String(MAX_MESSAGE_BYTES)}) throw new Error("output limit");
  return JSON.parse(encoded);
};
runtime.on("message", async (message) => {
  if (!message || typeof message !== "object" || typeof message.requestId !== "number") return;
  try {
    const { action, payload, requestId } = message;
    let result;
    if (action === "register") {
      if (initialized) throw new Error("already registered");
      initialized = true;
      register(${JSON.stringify(LOADER_URL)}, {
        parentURL: import.meta.url,
        data: { rootUrl: payload.rootUrl },
      });
      Object.defineProperty(globalThis, "console", {
        value: Object.freeze({ debug() {}, error() {}, info() {}, log() {}, warn() {} }),
        configurable: false,
      });
      delete globalThis.process;
      const imported = await import(payload.entryUrl);
      const plugin = imported.default;
      if (!plugin || typeof plugin !== "object" || typeof plugin.register !== "function") {
        throw new Error("invalid connector");
      }
      if (plugin.id !== undefined && plugin.id !== payload.pluginId) throw new Error("id mismatch");
      const sink = Object.freeze({
        registerWebhookFormat(format) {
          if (!format || typeof format.id !== "string" || typeof format.render !== "function" || formats.has(format.id)) throw new Error("invalid format");
          formats.set(format.id, format.render);
        },
        registerWebhookSource(source) {
          if (!source || typeof source.id !== "string" || typeof source.verify !== "function" || sources.has(source.id)) throw new Error("invalid source");
          sources.set(source.id, source.verify);
        },
      });
      await plugin.register(sink);
      result = { pluginId: payload.pluginId, formats: [...formats.keys()], sources: [...sources.keys()] };
    } else if (action === "render") {
      const render = formats.get(payload.formatId);
      if (!render) throw new Error("unknown format");
      result = await render(payload.event);
    } else if (action === "verify") {
      const verify = sources.get(payload.sourceId);
      if (!verify) throw new Error("unknown source");
      result = await verify(payload.input);
      if (typeof result !== "boolean") throw new Error("invalid decision");
    } else {
      throw new Error("unknown action");
    }
    reply(requestId, true, safeResult(result));
  } catch {
    reply(message.requestId, false);
  }
});
`;
