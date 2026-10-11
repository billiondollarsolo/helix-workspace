// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, click, mount, settle, unmountAll } from "@/test/ui";
import { AssistantFeedbackButtons } from "./assistant-feedback";
import { hydrateConversation } from "./conversation-history";

const api = vi.hoisted(() => ({ setFeedback: vi.fn() }));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  setAssistantMessageFeedback: api.setFeedback,
}));
vi.mock("@/components/ui/toast", () => ({ notify: vi.fn() }));

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const MESSAGE = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  unmountAll();
  vi.clearAllMocks();
});

function render(initial?: { readonly rating: "up" | "down"; readonly comment: string | null }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return mount(
    <QueryClientProvider client={client}>
      <div>
        <AssistantFeedbackButtons
          conversationId={CONVERSATION}
          messageId={MESSAGE}
          initial={initial === undefined ? undefined : { ...initial, updatedAt: "2026-10-01" }}
        />
      </div>
    </QueryClientProvider>,
  );
}

function button(label: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (found === null) throw new Error(`No ${label} button`);
  return found;
}

describe("AssistantFeedbackButtons", () => {
  it("rates an answer up, and clears the rating when pressed again", async () => {
    api.setFeedback.mockImplementation(async (input: { rating: "up" | null }) => ({
      feedback: input.rating === null ? null : { rating: input.rating, comment: null },
    }));
    render();
    expect(button("Good response").getAttribute("aria-pressed")).toBe("false");

    click(button("Good response"));
    await settle();
    expect(api.setFeedback).toHaveBeenLastCalledWith({
      conversationId: CONVERSATION,
      messageId: MESSAGE,
      rating: "up",
    });
    expect(button("Good response").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("form")).toBeNull();

    click(button("Good response"));
    await settle();
    expect(api.setFeedback).toHaveBeenLastCalledWith(expect.objectContaining({ rating: null }));
    expect(button("Good response").getAttribute("aria-pressed")).toBe("false");
  });

  it("asks for an optional comment after a thumbs down and sends it", async () => {
    api.setFeedback.mockImplementation(async (input: { rating: "down"; comment?: string }) => ({
      feedback: { rating: input.rating, comment: input.comment ?? null },
    }));
    render();
    click(button("Bad response"));
    await settle();
    expect(button("Bad response").getAttribute("aria-pressed")).toBe("true");
    const form = document.querySelector<HTMLFormElement>(
      'form[aria-label="Feedback on this response"]',
    );
    const textarea = form?.querySelector("textarea");
    expect(textarea?.labels?.[0]?.textContent).toBe("What could be better? (optional)");
    expect(await axeViolations()).toEqual([]);

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "  Cite the contract  ");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      form?.requestSubmit();
    });
    await settle();
    expect(api.setFeedback).toHaveBeenLastCalledWith({
      conversationId: CONVERSATION,
      messageId: MESSAGE,
      rating: "down",
      comment: "Cite the contract",
    });
    expect(document.querySelector("form")).toBeNull();
  });

  it("restores the saved rating and rolls back when saving fails", async () => {
    api.setFeedback.mockRejectedValue(new Error("offline"));
    render({ rating: "up", comment: null });
    expect(button("Good response").getAttribute("aria-pressed")).toBe("true");
    click(button("Bad response"));
    await settle();
    expect(button("Good response").getAttribute("aria-pressed")).toBe("true");
    expect(button("Bad response").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("hydrateConversation", () => {
  it("keeps re-checked citations and feedback on the final answer of each turn", () => {
    const citation = { kind: "drive", id: "f-1", title: "Plan", path: "/drive/f-1" } as const;
    const feedback = { rating: "up", comment: null, updatedAt: "2026-10-01" } as const;
    const hydrated = hydrateConversation({
      messages: [
        { id: "u1", role: "user", content: "Find the plan" },
        { id: "a1", role: "assistant", content: "", citations: [citation] },
        { id: "a2", role: "assistant", content: "Here it is.", citations: [citation], feedback },
      ],
    });
    expect(hydrated?.map((message) => [message.id, message.citations, message.feedback])).toEqual([
      ["u1", undefined, undefined],
      ["a2", [citation], feedback],
    ]);
  });
});
