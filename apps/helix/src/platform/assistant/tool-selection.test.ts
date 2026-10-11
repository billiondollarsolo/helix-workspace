import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/api-error.js";
import {
  assistantToolGroups,
  assistantToolLimit,
  explicitToolGroups,
  selectTurnTools,
} from "./tool-selection.js";
import type { AssistantVisibleTool } from "./types.js";

const tool = (id: string, sideEffects: "read" | "write" = "read") =>
  ({ id, sideEffects }) as AssistantVisibleTool;

/** Every group a fully scoped organization admin can see, sized above today's catalog. */
const fullScopeAdminCatalog: readonly AssistantVisibleTool[] = [
  tool("platform.ping"),
  tool("web.search"),
  tool("web.fetch"),
  ...(
    [
      ["mail", 60],
      ["chat", 35],
      ["drive", 45],
      ["calendar", 15],
      ["meet", 12],
      ["notifications", 4],
      ["admin", 20],
      ["webhooks", 14],
      ["account", 12],
      ["search", 6],
    ] as const
  ).flatMap(([namespace, count]) =>
    Array.from({ length: count }, (_, index) =>
      tool(`${namespace}.tool${String(index).padStart(2, "0")}`, index % 2 ? "write" : "read"),
    ),
  ),
];

const ids = (tools: readonly AssistantVisibleTool[]) => tools.map((entry) => entry.id);
const namespaces = (tools: readonly AssistantVisibleTool[]) =>
  new Set(tools.map((entry) => entry.id.split(".")[0]));

describe("assistant tool groups", () => {
  it("keeps Meet, Administration, and Webhooks opt-in", () => {
    const tools = ["meet.create-room", "search.query", "mail.send", "webhook.list"].map((id) =>
      tool(id),
    );
    expect(ids(selectTurnTools(tools, {}))).toEqual(["search.query", "mail.send"]);
    expect(ids(selectTurnTools(tools, { groups: ["meet"] }))).toEqual(["meet.create-room"]);
    expect(assistantToolGroups(tools)).toMatchObject({
      limit: assistantToolLimit,
      groups: expect.arrayContaining([
        { id: "meet", label: "Meet", defaultEnabled: false, count: 1 },
        { id: "mail", label: "Mail", defaultEnabled: true, count: 1 },
      ]),
    });
  });

  it("keeps a fully scoped admin's default selection under the provider limit", () => {
    const selected = selectTurnTools(fullScopeAdminCatalog, { prompt: "What is on my plate?" });
    expect(selected.length).toBeLessThanOrEqual(assistantToolLimit);
    expect(namespaces(selected)).not.toContain("admin");
    expect(namespaces(selected)).not.toContain("webhooks");
    expect(namespaces(selected)).not.toContain("meet");
    expect(ids(selected)).toEqual(expect.arrayContaining(["platform.ping", "web.search"]));
    // Deterministic: the same prompt always yields the same tools.
    expect(selectTurnTools(fullScopeAdminCatalog, { prompt: "What is on my plate?" })).toEqual(
      selected,
    );
  });

  it("ranks groups the prompt names first and fills the remainder read-only first", () => {
    const catalog = fullScopeAdminCatalog.filter((entry) => !entry.id.startsWith("web."));
    const chat = selectTurnTools(catalog, { prompt: "Summarize my unread chat mentions" });
    expect(chat.filter((entry) => entry.id.startsWith("chat."))).toHaveLength(35);
    // Two slots stay free so history can replay web tools without crossing the limit.
    expect(chat.length).toBe(assistantToolLimit - 2);
    const partial = [...namespaces(chat)].at(-1);
    const partialTools = chat.filter((entry) => entry.id.startsWith(`${partial ?? ""}.`));
    const reads = partialTools.filter((entry) => entry.sideEffects === "read").length;
    expect(reads).toBeGreaterThanOrEqual(partialTools.length - reads);
  });

  it("rejects an explicit oversized selection with the groups to turn off", () => {
    let error: unknown;
    try {
      selectTurnTools(fullScopeAdminCatalog, {
        groups: ["mail", "chat", "drive", "calendar", "admin", "other"],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: "assistant_tool_limit_exceeded",
      statusCode: 400,
      details: {
        limit: assistantToolLimit,
        selected: 3 + 60 + 35 + 45 + 15 + 20 + 12 + 6,
        groups: [
          { id: "mail", label: "Mail", count: 60 },
          { id: "drive", label: "Drive", count: 45 },
          { id: "chat", label: "Chat", count: 35 },
          { id: "admin", label: "Administration", count: 20 },
          { id: "other", label: "Workspace search and other tools", count: 18 },
          { id: "calendar", label: "Calendar", count: 15 },
        ],
      },
    });
    expect((error as Error).message).toContain("Turn off Mail");
  });

  it("validates explicit group ids and keeps an omitted selection on the default", () => {
    expect(explicitToolGroups()).toBeUndefined();
    expect(explicitToolGroups(["other", "mail"])).toEqual(["mail", "other"]);
    expect(() => explicitToolGroups(["not-a-group"])).toThrow("valid Assistant tool groups");
  });
});
