import { describe, expect, it } from "vitest";
import {
  AssistantSlashCommandHooks,
  parseAssistantSlashCommand,
  resolveDefaultAssistantSlashCommand,
} from "./slash.js";
import type { Actor } from "@helix/sdk-types";

describe("assistant slash commands", () => {
  it("parses a slash command with quoted arguments", () => {
    expect(parseAssistantSlashCommand("  /draft mail to Ada about 'Q3 launch'  ")).toEqual({
      name: "draft",
      raw: "/draft mail to Ada about 'Q3 launch'",
      args: "mail to Ada about 'Q3 launch'",
      argv: ["mail", "to", "Ada", "about", "Q3 launch"],
    });
  });

  it("ignores non-slash input and an empty slash", () => {
    expect(parseAssistantSlashCommand("draft mail to Ada")).toBeNull();
    expect(parseAssistantSlashCommand("/")).toBeNull();
  });

  it("resolves deterministic default routes for the supported phase 8 commands", () => {
    const cases = [
      {
        command: "/draft mail to bruno about launch",
        instruction: "Draft content",
        includes: ["mail.search", "docs.get", "drive.search"],
        excludes: ["mail.send", "calendar.event.create"],
      },
      {
        command: "/summarize this thread",
        instruction: "Summarize",
        includes: ["chat.search", "mail.thread.get", "calendar.event.list"],
        excludes: ["mail.send", "calendar.event.create"],
      },
      {
        command: "/find files about launch",
        instruction: "Find actor-visible",
        includes: ["drive.search", "mail.search", "calendar.event.list"],
        excludes: ["mail.send", "calendar.event.create"],
      },
      {
        command: "/schedule meeting with Ada next week",
        instruction: "Help schedule",
        includes: ["calendar.event.list", "calendar.find-time", "calendar.event.create"],
        excludes: ["mail.search", "drive.search"],
      },
    ] as const;

    for (const testCase of cases) {
      const command = parseAssistantSlashCommand(testCase.command);
      expect(command).not.toBeNull();
      if (command === null) {
        throw new Error("Expected slash command.");
      }
      const route = resolveDefaultAssistantSlashCommand(command);
      expect(route?.instruction).toContain(testCase.instruction);
      expect(route?.searchQuery).toBe(command.args);
      for (const includedToolId of testCase.includes) {
        expect(route?.toolIds).toContain(includedToolId);
      }
      for (const excludedToolId of testCase.excludes) {
        expect(route?.toolIds).not.toContain(excludedToolId);
      }
      expect(route?.metadata).toMatchObject({
        route: command.name,
        searchQuery: command.args,
      });
    }
  });

  it("lets registered hooks override the default route", async () => {
    const hooks = new AssistantSlashCommandHooks();
    hooks.register("draft", () => ({
      instruction: "Custom draft route",
      searchQuery: "custom search",
      toolIds: ["demo.lookup"],
    }));

    await expect(
      hooks.resolve({
        actor,
        command: parseAssistantSlashCommand("/draft launch") ?? failParse(),
      }),
    ).resolves.toEqual({
      instruction: "Custom draft route",
      searchQuery: "custom search",
      toolIds: ["demo.lookup"],
    });
  });

  it("returns no default route for unsupported slash commands", () => {
    const command = parseAssistantSlashCommand("/unknown launch");
    expect(command).not.toBeNull();
    if (command === null) {
      throw new Error("Expected slash command.");
    }
    expect(resolveDefaultAssistantSlashCommand(command)).toBeUndefined();
  });
});

const actor: Actor = {
  id: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-000000000010",
  type: "user",
  displayName: "Ada",
  scopes: ["assistant.write"],
};

function failParse(): never {
  throw new Error("Expected slash command.");
}
