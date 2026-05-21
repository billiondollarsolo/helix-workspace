import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createWebPlatformHost } from "./platform";

function createHost() {
  return createWebPlatformHost({
    queryClient: new QueryClient(),
    getColorMode: () => "system"
  });
}

describe("createWebPlatformHost", () => {
  it("registers suggestion slots in display order", () => {
    const host = createHost();

    host.registerSuggestionSlot({
      id: "docs.smart-write",
      pluginId: "com.helix.docs",
      label: "Smart write",
      order: 20
    });
    host.registerSuggestionSlot({
      id: "mail.compose-help",
      pluginId: "com.helix.mail",
      label: "Compose help",
      order: 10
    });

    expect(host.getSuggestionSlots().map((slot) => slot.id)).toEqual(["mail.compose-help", "docs.smart-write"]);
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
      render: () => "Draft tone"
    });
    host.registerSuggestionSlotProvider("mail.compose-help", {
      id: "summarize",
      pluginId: "com.helix.ai",
      slotId: "mail.compose-help",
      label: "Summarize",
      order: 10,
      render: () => "Summarize"
    });
    host.registerSuggestionSlotProvider("docs.smart-write", {
      id: "outline",
      pluginId: "com.helix.ai",
      slotId: "docs.smart-write",
      label: "Outline",
      render: () => "Outline"
    });

    expect(host.getSuggestionSlotProviders("mail.compose-help").map((provider) => provider.id)).toEqual([
      "summarize",
      "draft-tone"
    ]);
    expect(host.getSuggestionSlotProviders("docs.smart-write").map((provider) => provider.id)).toEqual(["outline"]);
  });
});
