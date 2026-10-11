import { describe, expect, it } from "vitest";
import { registerAccountPreferenceTools } from "../platform/auth/account-preferences.js";
import { registerAppPasswordTools } from "../platform/auth/app-passwords.js";
import { registerAgentCredentialTools } from "../platform/auth/tools.js";
import { registerAssistantTools } from "../platform/assistant/index.js";
import { registerCalendarTools } from "../platform/calendar/index.js";
import { registerContactsTools } from "../platform/carddav/index.js";
import { registerChatTools } from "../platform/chat/index.js";
import { registerChatInboxTools } from "../platform/chat/inbox.js";
import { registerDriveS3KeyTools, registerDriveTools } from "../platform/drive/index.js";
import { registerMailTools } from "../platform/mail/index.js";
import { registerMeetTools } from "../platform/meet/index.js";
import { registerSearchTools } from "../platform/search/index.js";
import { createToolRegistry } from "../platform/tool-registry.js";
import { registerWebhookTools } from "../platform/webhooks/index.js";

/**
 * Registers every tool module the CLI wraps. Tool definitions are built
 * eagerly and only touch their stores inside handlers, so unused options are
 * safe to leave empty here.
 */
function registeredTools() {
  const registry = createToolRegistry();
  const unused = {} as never;
  registerMailTools(registry, unused);
  registerChatTools(registry, unused);
  registerDriveTools(registry, unused);
  registerDriveS3KeyTools(registry, unused);
  registerCalendarTools(registry, unused);
  registerMeetTools(registry, unused);
  registerSearchTools(registry, unused);
  registerAssistantTools(registry, unused);
  registerWebhookTools(registry, unused);
  registerAgentCredentialTools(registry, unused);
  registerAppPasswordTools(registry, unused);
  registerAccountPreferenceTools(registry, unused);
  registerChatInboxTools(registry, unused);
  registerContactsTools(registry, unused);
  return registry.list();
}

function registeredToolIds(): ReadonlySet<string> {
  return new Set(registeredTools().map((tool) => tool.id));
}

interface CliModules {
  readonly usage: string;
  readonly parseCliArgs: (args: readonly string[]) => {
    readonly kind: string;
    readonly toolId?: string;
    readonly json?: { readonly source: string; readonly value?: string };
  };
}

async function cliModules(): Promise<CliModules> {
  const load = async (path: string) =>
    (await import(new URL(`../../../../packages/cli/src/${path}`, import.meta.url).href)) as Record<
      string,
      unknown
    >;
  const [usageModule, parserModule] = await Promise.all([load("usage.ts"), load("parser.ts")]);
  return {
    usage: usageModule.usage as string,
    parseCliArgs: parserModule.parseCliArgs as CliModules["parseCliArgs"],
  };
}

/** A sample value for a usage placeholder such as `<email>` or `<inbox|sent>`. */
function sampleValue(placeholder: string): string {
  const name = placeholder.slice(1, -1);
  if (name.includes("|")) return name.split("|")[0] ?? "x";
  if (name === "email") return "ada@example.com";
  if (name === "id" || name.endsWith("-id")) return "11111111-1111-4111-8111-111111111111";
  if (name === "number") return "5";
  if (name === "iso") return "2030-01-01T00:00:00.000Z";
  if (name === "json-object") return "{}";
  return "sample";
}

/** Every `helix <app> <action> [--flag <value>]` usage line, as flag invocations. */
function usageInvocations(
  usage: string,
): { readonly argv: readonly string[]; readonly flag: string }[] {
  const invocations: { argv: readonly string[]; flag: string }[] = [];
  for (const line of usage.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("helix ")) continue;
    const head = trimmed.split("[")[0]?.trim().split(/\s+/u).slice(1) ?? [];
    if (head.length < 2 || head.some((word) => word.startsWith("<"))) continue;
    for (const match of trimmed.matchAll(/\[(--[a-z-]+)(?: (<[^>]+>))?\]/gu)) {
      const flag = match[1] ?? "";
      if (flag === "--json") continue;
      const placeholder = match[2];
      invocations.push({
        argv: [...head, flag, ...(placeholder === undefined ? [] : [sampleValue(placeholder)])],
        flag,
      });
    }
  }
  return invocations;
}

async function cliToolIds(): Promise<readonly string[]> {
  // The CLI is a separate package outside this tsconfig's rootDir, so load
  // its source at runtime rather than through a static import.
  const moduleUrl = new URL("../../../../packages/cli/src/tool-ids.ts", import.meta.url).href;
  const module = (await import(moduleUrl)) as { readonly CLI_TOOL_IDS?: unknown };
  const ids = module.CLI_TOOL_IDS;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
    throw new Error("packages/cli/src/tool-ids.ts must export CLI_TOOL_IDS as a string array.");
  }
  return ids;
}

describe("CLI tool wrappers", () => {
  it("only call tool ids the server registers", async () => {
    const registered = registeredToolIds();
    const ids = await cliToolIds();

    expect(ids.length).toBeGreaterThan(50);
    expect(ids.filter((id) => !registered.has(id))).toEqual([]);
  });

  it("only send input fields the target tool's schema declares", async () => {
    const schemas = new Map(
      registeredTools().map((tool) => [tool.id, tool.inputSchema.toJsonSchema()] as const),
    );
    const { usage, parseCliArgs } = await cliModules();
    const unknownFields: string[] = [];
    let checked = 0;
    for (const { argv, flag } of usageInvocations(usage)) {
      let command: ReturnType<CliModules["parseCliArgs"]>;
      try {
        command = parseCliArgs(argv);
      } catch {
        continue; // Flags that need companions are covered by the CLI's own tests.
      }
      if (command.kind !== "tool-call" || command.toolId === undefined) continue;
      if (command.json?.source !== "inline" || command.json.value === undefined) continue;
      const properties = (schemas.get(command.toolId) as { properties?: object } | undefined)
        ?.properties;
      if (properties === undefined) continue;
      for (const field of Object.keys(JSON.parse(command.json.value) as object)) {
        checked += 1;
        if (!(field in properties)) {
          unknownFields.push(
            `helix ${argv.slice(0, 2).join(" ")} ${flag} -> ${command.toolId}.${field}`,
          );
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect(unknownFields).toEqual([]);
  });
});
