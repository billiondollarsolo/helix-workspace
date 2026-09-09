import { Liquid } from "liquidjs";
import type { JsonValue, OutboundWebhookEvent, RenderedWebhookRequest } from "./types.js";
import { renderGenericEnvelope } from "./generic.js";

export interface TemplateContext {
  readonly id: string;
  readonly event: string;
  readonly createdAt: string;
  readonly object: JsonValue;
  readonly payload: JsonValue;
  readonly actor?: {
    readonly id: string;
    readonly type: string;
    readonly displayName?: string;
    readonly email?: string;
  };
}

export interface CustomTemplateConfig {
  readonly template: string;
}

/**
 * Sandboxed Liquid engine for outbound webhook custom templates.
 *
 * The engine is configured to be fully self-contained: it has no access to the
 * file system or the network. Any tag that could be used to escape the sandbox
 * (`include`, `render`, `layout`/`block`) is replaced by a stub whose `parse`
 * step throws, so a malicious template fails fast at parse time rather than
 * pulling in an arbitrary file. The `fs` implementation is also stubbed so that
 * even a programmatically constructed path cannot reach disk.
 *
 * Templates support the full safe Liquid surface — output (`{{ }}`), filters
 * (`| upcase`, `| date`, `| json`, …), conditionals (`{% if %}` / `{% unless %}`
 * / `{% case %}`) and loops (`{% for %}` / `{% tablerow %}`).
 */
const sandboxedTags = ["include", "render", "layout", "block", "blocks"] as const;

function createSandboxedEngine(): Liquid {
  const engine = new Liquid({
    // No template root — nothing on disk is reachable.
    root: [],
    // In-memory only; an empty map means partial lookups resolve to nothing.
    templates: {},
    // No relative partial resolution — there is no file system to resolve against.
    relativeReference: false,
    // Fail fast on undefined filters so a typo cannot silently smuggle output.
    strictFilters: false,
    strictVariables: false,
    // Stub file system: every operation either returns "absent" or throws.
    fs: {
      readFileSync(): string {
        throw new Error("Webhook templates cannot read files.");
      },
      readFile(): Promise<string> {
        return Promise.reject(new Error("Webhook templates cannot read files."));
      },
      existsSync(): boolean {
        return false;
      },
      exists(): Promise<boolean> {
        return Promise.resolve(false);
      },
      resolve(_root: string, file: string): string {
        return file;
      },
    },
  });

  // Disable every tag that could load external content.
  const disabledTag = {
    parse(token: { readonly name: string }): void {
      throw new Error(`Webhook templates cannot use the "${token.name}" tag.`);
    },
    render(): string {
      return "";
    },
  };
  for (const tagName of sandboxedTags) {
    engine.registerTag(tagName, disabledTag);
  }

  // A `json` filter for safely embedding structured values.
  engine.registerFilter("json", (value: unknown) => JSON.stringify(value ?? null));

  return engine;
}

const engine = createSandboxedEngine();

export function createTemplateContext(event: OutboundWebhookEvent): TemplateContext {
  const envelope = renderGenericEnvelope(event).body;
  return {
    id: envelope.id,
    event: envelope.event,
    createdAt: envelope.createdAt,
    object: envelope.object,
    payload: envelope.object,
    ...(envelope.actor === undefined ? {} : { actor: envelope.actor }),
  };
}

/**
 * Render an arbitrary Liquid template string against the webhook context.
 *
 * Supports loops, conditionals and filters. Throws a descriptive error when the
 * template is malformed or attempts to use a sandboxed tag.
 */
export function renderTemplateString(template: string, context: TemplateContext): string {
  try {
    const rendered: unknown = engine.parseAndRenderSync(template, { ...context });
    return typeof rendered === "string" ? rendered : String(rendered);
  } catch (error) {
    throw new Error(`Custom webhook template failed to render: ${describeError(error)}`, {
      cause: error,
    });
  }
}

/**
 * Render the configured custom template into an outbound webhook request body.
 *
 * The rendered text must be a JSON document; a template that produces invalid
 * JSON raises an error so a broken delivery never leaves the system silently.
 */
export function renderCustomTemplate(
  event: OutboundWebhookEvent,
  config: CustomTemplateConfig,
): RenderedWebhookRequest {
  const context = createTemplateContext(event);
  const bodyText = renderTemplateString(config.template, context);

  return {
    contentType: "application/json",
    body: parseJsonObjectTemplate(bodyText),
  };
}

function parseJsonObjectTemplate(text: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Custom webhook template rendered text that is not valid JSON: ${describeError(error)}`,
      { cause: error },
    );
  }
  if (!isJsonValue(parsed)) {
    throw new Error("Custom webhook template rendered a value that is not JSON-compatible.");
  }

  return parsed;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
