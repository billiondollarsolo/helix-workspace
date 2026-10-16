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
      limit: 128,
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
            toolGroups={undefined}
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
    expect(onSend).toHaveBeenCalledWith("Search the weather", [], "groq/llama", true, undefined);
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
      undefined,
    );
  });
});

describe("AssistantComposer tools and models", () => {
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
      models: [
        {
          id: "openai-compatible.default/helix-e2e-model",
          label: "openai-compatible.default · helix-e2e-model",
          providerId: "openai-compatible.default",
          model: "helix-e2e-model",
        },
        {
          id: "anthropic/claude-sonnet-4-5-20250929",
          label: "Anthropic · Claude for writing",
          providerId: "anthropic",
          model: "claude-sonnet-4-5-20250929",
        },
      ],
      defaultModelId: "openai-compatible.default/helix-e2e-model",
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
  });

  async function renderComposer(
    toolGroups: readonly string[] | undefined,
    admin: boolean,
    result = Promise.resolve(true),
  ) {
    queryClient.setQueryData(assistantToolsQueryOptions().queryKey, {
      limit: 128,
      groups: [
        { id: "mail", label: "Mail", count: 30, defaultEnabled: true },
        ...(admin
          ? [{ id: "admin", label: "Administration", count: 40, defaultEnabled: false }]
          : []),
      ],
    });
    const onSend = vi.fn(() => result);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AssistantComposer
            onSend={onSend}
            pending={false}
            disabled={false}
            onStop={() => undefined}
            modelId=""
            onModelChange={() => undefined}
            onNewChat={() => undefined}
            onCancelEdit={() => undefined}
            toolGroups={toolGroups}
            onToolGroupsChange={() => undefined}
            editing={{
              text: "Catch me up on mail",
              ...(toolGroups === undefined ? {} : { toolGroups }),
            }}
          />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    return onSend;
  }

  async function send() {
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Resend message"]')?.click();
      await Promise.resolve();
    });
  }

  it.each(["", "My next question"])(
    "clears the submitted draft while waiting and preserves '%s' on failure",
    async (nextDraft) => {
      let finish: ((sent: boolean) => void) | undefined;
      const result = new Promise<boolean>((resolve) => {
        finish = resolve;
      });
      await renderComposer(undefined, false, result);
      await send();
      const textarea = container.querySelector("textarea");
      if (textarea === null) throw new Error("composer textarea not found");
      expect(textarea.value).toBe("");
      if (nextDraft) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        act(() => {
          setter?.call(textarea, nextDraft);
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
        });
      }
      await act(async () => {
        finish?.(false);
        await result;
      });
      expect(textarea.value).toBe(nextDraft || "Catch me up on mail");
    },
  );

  it("lets the server choose tools until the person picks groups", async () => {
    const onSend = await renderComposer(undefined, false);
    await send();
    expect(onSend).toHaveBeenCalledWith(
      "Catch me up on mail",
      [],
      "openai-compatible.default/helix-e2e-model",
      false,
      undefined,
    );
  });

  it("sends an explicit tool-group choice as chosen", async () => {
    const explicit = await renderComposer(["mail", "admin"], true);
    await send();
    expect(explicit).toHaveBeenCalledWith(
      "Catch me up on mail",
      [],
      "openai-compatible.default/helix-e2e-model",
      false,
      expect.arrayContaining(["mail", "admin"]),
    );
  });

  it("shows friendly model names, with raw ids only for admins", async () => {
    await renderComposer(undefined, false);
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Assistant model"]',
    );
    const options = [...(select?.options ?? [])].map((option) => option.textContent);
    expect(options).toEqual(["Helix E2E Model", "Claude for writing"]);
    expect(select?.title).toBe("");

    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    await renderComposer(undefined, true);
    const adminSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Assistant model"]',
    );
    expect(adminSelect?.title).toBe("openai-compatible.default/helix-e2e-model");
    expect(adminSelect?.options[1]?.title).toBe("anthropic/claude-sonnet-4-5-20250929");
  });
});
