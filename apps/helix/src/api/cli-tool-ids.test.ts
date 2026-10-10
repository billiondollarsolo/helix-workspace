import { describe, expect, it } from "vitest";
import { registerAppPasswordTools } from "../platform/auth/app-passwords.js";
import { registerAgentCredentialTools } from "../platform/auth/tools.js";
import { registerAssistantTools } from "../platform/assistant/index.js";
import { registerCalendarTools } from "../platform/calendar/index.js";
import { registerChatTools } from "../platform/chat/index.js";
import { registerDriveTools } from "../platform/drive/index.js";
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
function registeredToolIds(): ReadonlySet<string> {
  const registry = createToolRegistry();
  const unused = {} as never;
  registerMailTools(registry, unused);
  registerChatTools(registry, unused);
  registerDriveTools(registry, unused);
  registerCalendarTools(registry, unused);
  registerMeetTools(registry, unused);
  registerSearchTools(registry, unused);
  registerAssistantTools(registry, unused);
  registerWebhookTools(registry, unused);
  registerAgentCredentialTools(registry, unused);
  registerAppPasswordTools(registry, unused);
  return new Set(registry.list().map((tool) => tool.id));
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
});
