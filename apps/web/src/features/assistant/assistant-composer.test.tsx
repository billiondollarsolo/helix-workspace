// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantComposer } from "./assistant-composer";
import { assistantModelsQueryOptions, assistantToolsQueryOptions } from "./queries";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("AssistantComposer web search", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(assistantModelsQueryOptions().queryKey, {
      models: [{ id: "groq/llama", label: "Llama", providerId: "groq", model: "llama" }],
      defaultModelId: "groq/llama",
      webSearchEnabled: true,
    });
    queryClient.setQueryData(assistantToolsQueryOptions().queryKey, {
      groups: [{ id: "mail", label: "Mail", count: 4, defaultEnabled: true }],
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
  });

  it("keeps web search on after a successful send until the user turns it off", async () => {
    const onSend = vi.fn(() => Promise.resolve(true));
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AssistantComposer
            onSend={onSend}
            pending={false}
            disabled={false}
            onStop={() => undefined}
            modelId="groq/llama"
            onModelChange={() => undefined}
            onNewChat={() => undefined}
            onCancelEdit={() => undefined}
            onToolGroupsChange={() => undefined}
            editing={{ text: "Search the weather", webSearch: true }}
          />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[aria-label="Turn off web search"]')).not.toBeNull();

    const textarea = container.querySelector("textarea");
    if (textarea === null) throw new Error("composer textarea not found");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Resend message"]')?.click();
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledWith(
      "Search the weather",
      [],
      "groq/llama",
      true,
      expect.anything(),
    );
    expect(container.querySelector('[aria-label="Turn off web search"]')).not.toBeNull();
    expect(textarea.value).toBe("");

    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter === undefined) throw new Error("native value setter unavailable");
    Reflect.apply(setter, textarea, ["Follow up with the ZIP"]);
    act(() => {
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Resend message"]')?.click();
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenLastCalledWith(
      "Follow up with the ZIP",
      [],
      "groq/llama",
      true,
      expect.anything(),
    );
  });
});
