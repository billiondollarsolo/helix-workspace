// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DialogProvider } from "@helix/sdk-web";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvenanceArtifact } from "@/features/ai/provenance";
import {
  AssistantMessageHistory,
  AssistantRightRailPanel,
  AssistantShell,
  type AssistantMessage,
} from "./assistant-shell";
import { assistantQueryKeys, listInitialAssistantConversations } from "./queries";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: {
    readonly children: ReactNode;
    readonly to: string;
    readonly className?: string;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("AssistantShell", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          conversation: {
            id: "00000000-0000-4000-8000-000000000123",
          },
          response: {
            content: "I found the PRD and need approval before sharing it.",
            createdAt: "2026-05-20T12:00:00.000Z",
          },
          ai: {
            providerId: "openai-compatible.test",
            model: "test-model",
            usage: {
              inputTokens: 123,
              outputTokens: 45,
              costCents: 0.12,
            },
            metadata: {
              promptHash: "sha256:backend-test",
              traceId: "trace-backend-test",
            },
          },
          sources: [
            {
              id: "source-launch-prd",
              title: "Launch PRD",
              type: "drive.object",
              url: "drive.object/launch-prd",
            },
          ],
          toolCalls: [
            {
              toolCallId: "tool-call-share-prd",
              toolId: "drive.share",
              input: {
                objectId: "prd-1",
              },
              status: "pending_confirmation",
            },
          ],
          pendingConfirmations: [
            {
              id: "00000000-0000-4000-8000-000000000999",
              toolId: "drive.share",
            },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("submits a first prompt without the mock conversation id and renders the returned response with a pending confirmation card", async () => {
    renderShell();
    await submitPrompt("Share the Q3 Launch PRD with Bruno.");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/tools/assistant.chat");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      "content-type": "application/json",
      accept: "text/event-stream",
    });
    expect(fetchBodyAt(0)).toEqual({
      message: "Share the Q3 Launch PRD with Bruno.",
      memoryOptIn: false,
    });
    expect(container.textContent).toContain("Share the Q3 Launch PRD with Bruno.");
    expect(container.textContent).toContain("I found the PRD and need approval before sharing it.");
    expect(pendingToolCard().textContent).toContain("drive.share");
    expect(pendingToolCard().textContent).toContain("pending");

    const article = lastAssistantMessageArticle();
    expect(article.textContent).toContain("AI-assisted");
    await clickButton(article, "AI-assisted");
    const provenance = article.querySelector('[aria-label="AI provenance details"]');
    expect(provenance?.textContent).toContain("openai-compatible.test");
    expect(provenance?.textContent).toContain("assistant.chat");
    expect(provenance?.textContent).toContain("Launch PRD");
  });

  it("blocks empty and whitespace assistant prompts with accessible validation errors", async () => {
    renderShell();

    await submitAssistantComposerForm();

    expect(container.textContent).toContain("Prompt is required.");
    expect(fetchMock).not.toHaveBeenCalled();

    await typePrompt("   ");
    await submitAssistantComposerForm();

    expect(container.textContent).toContain("Prompt is required.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders an explicit backend-unavailable assistant state when assistant.chat rejects without fake local AI provenance", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    renderShell();

    await submitPrompt("Summarize the launch notes.");

    const article = lastAssistantMessageArticle();
    expect(article.textContent).toContain("Assistant backend unavailable.");
    expect(article.textContent).toContain("network down");
    expect(article.querySelector('[role="alert"]')?.textContent).toContain("Backend unavailable");
    expect(article.textContent).not.toContain(
      "I can work from the current workspace context and keep source trails attached.",
    );
    expect(article.textContent).not.toContain("AI-assisted");
    expect(article.querySelector(".ai-provenance")).toBeNull();
  });

  it("renders a backend-unavailable assistant state when assistant.chat returns no response content", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        conversation: {
          id: "00000000-0000-4000-8000-000000000123",
        },
        response: {
          createdAt: "2026-05-20T12:00:00.000Z",
        },
      }),
    );
    renderShell();

    await submitPrompt("Find launch blockers.");

    const article = lastAssistantMessageArticle();
    expect(article.textContent).toContain("Assistant backend unavailable.");
    expect(article.textContent).toContain("Assistant backend returned no response.");
    expect(article.textContent).not.toContain(
      "I can work from the current workspace context and keep source trails attached.",
    );
    expect(article.textContent).not.toContain("AI-assisted");
    expect(article.querySelector(".ai-provenance")).toBeNull();
  });

  it("reuses the returned backend conversation UUID on a later turn", async () => {
    renderShell();
    await submitPrompt("Share the Q3 Launch PRD with Bruno.");
    await submitPrompt("Add Nina too.");

    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/tools/assistant.chat");
    expect(fetchBodyAt(1)).toEqual({
      message: "Add Nina too.",
      conversationId: "00000000-0000-4000-8000-000000000123",
      memoryOptIn: false,
    });
  });

  it("passes memory opt-in from the memory toggle", async () => {
    renderShell();

    await clickButtonByLabel(container, "Toggle assistant memory");
    await submitPrompt("Remember that I prefer concise answers.");

    expect(fetchBodyAt(0)).toEqual({
      message: "Remember that I prefer concise answers.",
      memoryOptIn: true,
    });
  });

  it("passes the backend pending id when confirming a pending tool call", async () => {
    renderShell();
    await submitPrompt("Share the Q3 Launch PRD with Bruno.");

    await clickButton(pendingToolCard(), "Confirm");

    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/tools/assistant.confirmation.approve");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ "content-type": "application/json" });
    expect(fetchBodyAt(1)).toEqual({
      conversationId: "00000000-0000-4000-8000-000000000123",
      pendingId: "00000000-0000-4000-8000-000000000999",
    });
  });

  it("passes the backend pending id when cancelling a pending tool call", async () => {
    renderShell();
    await submitPrompt("Share the Q3 Launch PRD with Bruno.");

    await clickButton(pendingToolCard(), "Cancel");

    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/tools/assistant.confirmation.cancel");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ "content-type": "application/json" });
    expect(fetchBodyAt(1)).toEqual({
      conversationId: "00000000-0000-4000-8000-000000000123",
      pendingId: "00000000-0000-4000-8000-000000000999",
    });
  });

  it("calls assistant.memory.forget from Forget saved memory when a backend conversation UUID exists", async () => {
    renderShell();
    await clickButtonByLabel(container, "Toggle assistant memory");
    await submitPrompt("Remember that Bruno owns Q3 launch.");

    await clickButton(container, "Forget saved memory");
    await clickButton(forgetMemoryDialog(), "Forget");

    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/tools/assistant.memory.forget");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ "content-type": "application/json" });
    expect(fetchBodyAt(1)).toEqual({
      conversationId: "00000000-0000-4000-8000-000000000123",
    });
    expect(container.textContent).toContain("Memory cleared");
  });

  it("keeps memory enabled when cancelling the forget memory confirmation", async () => {
    renderShell();
    await clickButtonByLabel(container, "Toggle assistant memory");
    await submitPrompt("Remember that Bruno owns Q3 launch.");

    await clickButton(container, "Forget saved memory");
    expect(forgetMemoryDialog().textContent).toContain("Forget assistant memory?");
    await clickButton(forgetMemoryDialog(), "Cancel");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Memory opted in");
    expect(container.textContent).not.toContain("Memory cleared");
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("renders a pending action in the assistant rail", () => {
    renderRail();

    const rail = assistantRail();
    expect(rail.textContent).toContain("Read release calendar");
    expect(rail.textContent).toContain("Check the release calendar");
    expect(rail.textContent).toContain("pending");
  });

  it("renders multiline assistant content as a read-only Tiptap message with source, provenance, and tool context", async () => {
    const message: AssistantMessage = {
      id: "msg-multiline-ai",
      role: "assistant",
      author: "Helix Assistant",
      body: "First finding from the workspace sources.\n\nSecond finding stays in its own paragraph.",
      sentAt: "Now",
      citations: [
        {
          id: "cite-plan",
          label: "Launch plan",
          source: "drive.object/launch-plan",
          confidence: "High",
        },
      ],
      toolCalls: [
        {
          id: "tool-drive-search",
          pendingId: "00000000-0000-4000-8000-000000000777",
          name: "drive.search",
          description: "Search Drive before answering.",
          risk: "Reads workspace document metadata",
          status: "pending",
        },
      ],
      provenance: assistantMessageProvenance,
    };

    act(() => {
      root.render(
        <AssistantMessageHistory
          messages={[message]}
          onToolDecision={() => undefined}
          toolErrors={{}}
          toolStatuses={{}}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const article = assistantMessageArticle();
    const editor = messageEditor(article);
    const paragraphs = Array.from(editor.querySelectorAll("p"));

    expect(editor.getAttribute("contenteditable")).toBe("false");
    expect(paragraphs.map((paragraph) => paragraph.textContent)).toEqual([
      "First finding from the workspace sources.",
      "Second finding stays in its own paragraph.",
    ]);

    const citations = article.querySelector('[aria-label="Retrieved sources"]');
    expect(citations?.textContent).toContain("Launch plan");

    const toolCard = article.querySelector('[aria-label="drive.search"]');
    expect(toolCard?.textContent).toContain("Search Drive before answering.");
    expect(toolCard?.textContent).toContain("pending");

    expect(article.textContent).toContain("AI-assisted");
    await clickButton(article, "AI-assisted");
    expect(article.querySelector('[aria-label="AI provenance details"]')?.textContent).toContain(
      "assistant.test",
    );
  });

  it("passes the backend pending id when confirming a rail action", async () => {
    renderRail();

    await clickButton(assistantRailPendingAction(), "Confirm");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/tools/assistant.confirmation.approve");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ "content-type": "application/json" });
    expect(fetchBodyAt(0)).toEqual({
      conversationId: "planning",
      pendingId: "00000000-0000-4000-8000-000000000901",
    });
  });

  it("passes the backend pending id when cancelling a rail action", async () => {
    renderRail();

    await clickButton(assistantRailPendingAction(), "Cancel");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/tools/assistant.confirmation.cancel");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ "content-type": "application/json" });
    expect(fetchBodyAt(0)).toEqual({
      conversationId: "planning",
      pendingId: "00000000-0000-4000-8000-000000000901",
    });
  });

  function renderShell() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(assistantQueryKeys.conversations, listInitialAssistantConversations());
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DialogProvider>
            <AssistantShell />
          </DialogProvider>
        </QueryClientProvider>,
      );
    });
  }

  function renderRail() {
    act(() => {
      root.render(<AssistantRightRailPanel />);
    });
  }

  async function submitPrompt(prompt: string) {
    const textarea = container.querySelector("textarea");
    const sendButton = buttonWithText(container, "Send");

    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("Assistant composer textarea was not rendered.");
    }

    act(() => {
      setTextAreaValue(textarea, prompt);
    });
    act(() => {
      sendButton.click();
    });
    await settleStreamingTurn();
  }

  /**
   * Drains microtasks and timers until the streamed assistant turn finishes
   * (the streaming placeholder has been replaced with a final or error
   * message). The streaming chat client reveals plain-JSON responses
   * progressively via `setTimeout`, so a single microtask flush is not enough.
   */
  async function settleStreamingTurn() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const streaming = container.querySelector(".assistant-message-streaming");
      const status = container.querySelector(".assistant-streaming-status");
      if (streaming === null && status === null) {
        return;
      }
    }
  }

  async function typePrompt(prompt: string) {
    const textarea = container.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("Assistant composer textarea was not rendered.");
    }

    act(() => {
      setTextAreaValue(textarea, prompt);
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function submitAssistantComposerForm() {
    const form = container.querySelector("form.assistant-composer");
    if (!(form instanceof HTMLFormElement)) {
      throw new Error("Assistant composer form was not rendered.");
    }
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function pendingToolCard() {
    const card = container.querySelector('[aria-label="drive.share"]');
    if (!(card instanceof HTMLElement)) {
      throw new Error("Pending drive.share card was not rendered.");
    }
    return card;
  }

  function assistantRail() {
    const rail = container.querySelector('[aria-label="Assistant panel"]');
    if (!(rail instanceof HTMLElement)) {
      throw new Error("Assistant rail was not rendered.");
    }
    return rail;
  }

  function assistantRailPendingAction() {
    const card = container.querySelector('[aria-label="Read release calendar"]');
    if (!(card instanceof HTMLElement)) {
      throw new Error("Pending rail action was not rendered.");
    }
    return card;
  }

  function forgetMemoryDialog() {
    const dialog = container.querySelector('[role="alertdialog"]');
    if (!(dialog instanceof HTMLElement)) {
      throw new Error("Forget memory dialog was not rendered.");
    }
    return dialog;
  }

  function fetchBodyAt(callIndex: number) {
    const body = fetchMock.mock.calls[callIndex]?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error(`Fetch call ${String(callIndex)} did not include a string body.`);
    }
    return JSON.parse(body) as unknown;
  }

  function assistantMessageArticle() {
    const article = container.querySelector("article.ai-message");
    if (!(article instanceof HTMLElement)) {
      throw new Error("Assistant message article was not rendered.");
    }
    return article;
  }

  function lastAssistantMessageArticle() {
    const articles = Array.from(container.querySelectorAll("article.ai-message"));
    const article = articles.at(-1);
    if (!(article instanceof HTMLElement)) {
      throw new Error("Assistant message article was not rendered.");
    }
    return article;
  }

  function messageEditor(scope: ParentNode) {
    const editor = scope.querySelector('[aria-label="Message text"]');
    if (!(editor instanceof HTMLElement)) {
      throw new Error("Tiptap message editor was not rendered.");
    }
    return editor;
  }
});

const assistantMessageProvenance: AIProvenanceArtifact = {
  artifactId: "ai-artifact-assistant-test",
  feature: "assistant.test",
  providerId: "openai-compatible.test",
  model: "test-model",
  promptHash: "sha256:test",
  createdAt: "2026-05-20T12:00:00.000Z",
  actorName: "Test User",
  classification: "standard",
};

async function clickButton(scope: ParentNode, label: string) {
  act(() => {
    buttonWithText(scope, label).click();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function clickButtonByLabel(scope: ParentNode, label: string) {
  act(() => {
    buttonWithLabel(scope, label).click();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function buttonWithText(scope: ParentNode, label: string): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement && candidate.textContent?.includes(label) === true,
  );

  if (button === undefined) {
    throw new Error(`${label} button was not rendered.`);
  }

  return button;
}

function buttonWithLabel(scope: ParentNode, label: string): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement && candidate.getAttribute("aria-label") === label,
  );

  if (button === undefined) {
    throw new Error(`${label} button was not rendered.`);
  }

  return button;
}

function setTextAreaValue(textarea: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set?.bind(textarea);
  valueSetter?.(value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}
