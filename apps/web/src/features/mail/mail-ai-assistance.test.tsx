// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { axeViolations, click, mount, settle, unmountAll } from "@/test/ui";
import { callTool } from "@/lib/tool-call";
import { MailAiAssistance } from "./mail-ai-assistance";
vi.mock("@/lib/tool-call", () => ({ callTool: vi.fn() }));
afterEach(() => {
  unmountAll();
  vi.resetAllMocks();
});
function button(text: string) {
  const found = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing ${text}`);
  return found;
}
function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Example() {
    const [body, setBody] = useState("My draft");
    return (
      <>
        <button onClick={() => setBody("My newer draft")}>Edit draft</button>
        <p data-testid="draft">{body}</p>
        <MailAiAssistance body={body} onApply={setBody} />
      </>
    );
  }
  mount(
    <QueryClientProvider client={client}>
      <Example />
    </QueryClientProvider>,
  );
}
it("reviews text in an accessible nonblocking panel and never sends it", async () => {
  vi.mocked(callTool)
    .mockResolvedValueOnce({ enabled: true })
    .mockResolvedValue({ text: "Generated reply", classification: "standard" });
  render();
  await settle();
  await settle();
  click(button("Help me write"));
  await settle();
  await settle();
  click(button("Generate"));
  await settle();
  await settle();
  expect(document.querySelector("textarea")?.value).toBe("Generated reply");
  expect(document.querySelector('[data-testid="draft"]')?.textContent).toBe("My draft");
  expect(await axeViolations()).toEqual([]);
  click(button("Use in draft"));
  await settle();
  await settle();
  expect(document.querySelector('[data-testid="draft"]')?.textContent).toBe("Generated reply");
  expect(vi.mocked(callTool).mock.calls.map((call) => call[0])).toEqual([
    "mail.ai.status",
    "mail.ai.suggest",
  ]);
});
it("preserves edits made while the suggestion panel is open", async () => {
  vi.mocked(callTool)
    .mockResolvedValueOnce({ enabled: true })
    .mockResolvedValue({ text: "Old suggestion", classification: "standard" });
  render();
  await settle();
  await settle();
  click(button("Help me write"));
  await settle();
  await settle();
  click(button("Generate"));
  await settle();
  await settle();
  click(button("Edit draft"));
  await settle();
  await settle();
  expect(button("Use in draft").disabled).toBe(true);
  expect(document.querySelector('[data-testid="draft"]')?.textContent).toBe("My newer draft");
});
it("hides assistance until an administrator enables it", async () => {
  vi.mocked(callTool).mockResolvedValue({ enabled: false });
  render();
  await settle();
  await settle();
  expect(document.body.textContent).not.toContain("Help me write");
});
