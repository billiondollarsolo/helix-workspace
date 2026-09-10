import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createWebPlatformHost } from "./platform";

function createHost() {
  return createWebPlatformHost({
    queryClient: new QueryClient(),
    getColorMode: () => "system",
  });
}

describe("createWebPlatformHost", () => {
  it("registers command palette items with replacement ordering and cleanup", () => {
    const host = createHost();
    const firstCleanup = host.registerCommandPaletteItems([
      {
        id: "drive.find",
        pluginId: "com.helix.drive",
        label: "Find file",
        group: "Drive",
        order: 20,
        run: () => undefined,
      },
      {
        id: "drive.ask",
        pluginId: "com.helix.drive",
        label: "Ask about this file",
        group: "Drive",
        disabledReason: "File is still loading.",
        order: 10,
        run: () => undefined,
      },
    ]);

    const secondCleanup = host.registerCommandPaletteItems([
      {
        id: "drive.find",
        pluginId: "com.helix.drive",
        label: "Find current file",
        group: "Drive",
        order: 5,
        run: () => undefined,
      },
    ]);

    expect(host.getCommandPaletteItems().map((item) => item.label)).toEqual([
      "Find current file",
      "Ask about this file",
    ]);
    expect(host.getCommandPaletteItems()[1]?.disabledReason).toBe("File is still loading.");

    firstCleanup();

    expect(host.getCommandPaletteItems().map((item) => item.label)).toEqual(["Find current file"]);

    secondCleanup();

    expect(host.getCommandPaletteItems()).toEqual([]);
  });

  it("registers suggestion slots in display order", () => {
    const host = createHost();

    host.registerSuggestionSlot({
      id: "drive.summarize-file",
      pluginId: "com.helix.drive",
      label: "Summarize file",
      order: 20,
    });
    host.registerSuggestionSlot({
      id: "mail.compose-help",
      pluginId: "com.helix.mail",
      label: "Compose help",
      order: 10,
    });

    expect(host.getSuggestionSlots().map((slot) => slot.id)).toEqual([
      "mail.compose-help",
      "drive.summarize-file",
    ]);
    expect(host.getSuggestionSlot("mail.compose-help")?.label).toBe("Compose help");
  });

  it("keeps suggestion providers scoped by slot", () => {
    const host = createHost();

    host.registerSuggestionSlotProvider("mail.compose-help", {
      id: "draft-tone",
      pluginId: "com.helix.ai",
      slotId: "ignored-by-host",
      label: "Draft tone",
      order: 20,
      render: () => "Draft tone",
    });
    host.registerSuggestionSlotProvider("mail.compose-help", {
      id: "summarize",
      pluginId: "com.helix.ai",
      slotId: "mail.compose-help",
      label: "Summarize",
      order: 10,
      render: () => "Summarize",
    });
    host.registerSuggestionSlotProvider("drive.summarize-file", {
      id: "outline",
      pluginId: "com.helix.ai",
      slotId: "drive.summarize-file",
      label: "Outline",
      render: () => "Outline",
    });

    expect(
      host.getSuggestionSlotProviders("mail.compose-help").map((provider) => provider.id),
    ).toEqual(["summarize", "draft-tone"]);
    expect(
      host.getSuggestionSlotProviders("drive.summarize-file").map((provider) => provider.id),
    ).toEqual(["outline"]);
  });
});
