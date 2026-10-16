// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PreparedReply } from "./thread-controls";
import { prepareProductivityArtifact } from "./api";
import { callTool } from "@/lib/tool-call";
vi.mock("@/lib/tool-call", () => ({ callTool: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const artifact = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "reply",
  sourceKey: "thread:version",
  status: "ready",
  text: "Suggested reply",
  objectId: null,
  error: null,
  createdAt: "2026-10-16",
  updatedAt: "2026-10-16",
};
let node: HTMLDivElement, root: Root, client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(async () => {
  await act(() => Promise.resolve(root.unmount()));
  client.clear();
  node.remove();
});
async function button(name: string) {
  let found: HTMLButtonElement | undefined;
  await vi.waitFor(() => {
    found = [...document.querySelectorAll("button")].find((b) => b.textContent === name);
    expect(found).toBeDefined();
  });
  await act(() => Promise.resolve(found?.click()));
}
it("keeps approval-pending preparation explicit", async () => {
  vi.mocked(callTool).mockResolvedValue({
    status: "pending_confirmation",
    pending: { id: "pending" },
  });
  await expect(
    prepareProductivityArtifact("mail.reply.prepare", { threadId: "thread" }),
  ).rejects.toThrow("Open Approvals");
  expect(callTool).toHaveBeenCalledWith(
    "mail.reply.prepare",
    { threadId: "thread" },
    { autoApprove: false },
  );
});
it("refuses a suggestion that became stale while the review was open", async () => {
  let reads = 0;
  vi.mocked(callTool).mockImplementation((tool) =>
    Promise.resolve(
      tool === "mail.productivity.settings.get"
        ? { aiEnabled: true }
        : { artifacts: ++reads === 1 ? [artifact] : [] },
    ),
  );
  const apply = vi.fn();
  await act(() =>
    Promise.resolve(
      root.render(
        <QueryClientProvider client={client}>
          <PreparedReply threadId="thread" body="" onApply={apply} />
        </QueryClientProvider>,
      ),
    ),
  );
  await button("Review prepared reply");
  await button("Use in empty draft");
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("conversation or suggestion changed"),
  );
  expect(apply).not.toHaveBeenCalled();
});
it("preserves text typed while the final suggestion check is in flight", async () => {
  let reads = 0;
  let finish: ((value: unknown) => void) | undefined;
  vi.mocked(callTool).mockImplementation(async (tool) => {
    if (tool === "mail.productivity.settings.get") return { aiEnabled: true };
    if (++reads === 1) return { artifacts: [artifact] };
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const apply = vi.fn();
  const render = (body: string) =>
    root.render(
      <QueryClientProvider client={client}>
        <PreparedReply threadId="thread" body={body} onApply={apply} />
      </QueryClientProvider>,
    );
  await act(() => Promise.resolve(render("")));
  await button("Review prepared reply");
  await button("Use in empty draft");
  await act(() => {
    render("My unsent draft");
    return Promise.resolve();
  });
  await act(() => Promise.resolve(finish?.({ artifacts: [artifact] })));
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Your draft changed. It has been preserved."),
  );
  expect(apply).not.toHaveBeenCalled();
});
