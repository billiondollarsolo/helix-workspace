// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { axeViolations, click, mount, settle, unmountAll } from "@/test/ui";
import { BotWorkspaces } from "./workspaces";

const { callTool } = vi.hoisted(() => ({ callTool: vi.fn() }));
vi.mock("@/lib/tool-call", () => ({ callTool }));
afterEach(() => {
  unmountAll();
  vi.clearAllMocks();
});

const id = "11111111-1111-4111-8111-111111111111";
const bot = { id, displayName: "Helix", email: null, disabled: false };
const button = (name: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === name,
  ) ?? null;
async function waitFor(text: string) {
  for (let attempt = 0; attempt < 20 && !document.body.textContent?.includes(text); attempt++)
    await settle();
  expect(document.body.textContent).toContain(text);
}

it("opens a linked bot, pages rooms and history, then hides content when access is revoked", async () => {
  let revoked = false;
  callTool.mockImplementation(
    (
      toolId: string,
      input: { surface?: string; roomId?: string; offset?: number; cursor?: string },
    ) => {
      if (toolId === "agent.workspace.list")
        return Promise.resolve({ bots: [bot], hasMore: false });
      if (revoked)
        return Promise.reject(
          Object.assign(new Error("Observation access was revoked."), { status: 404 }),
        );
      if (input.surface === "mail") return Promise.resolve({ threads: [], total: 0 });
      if (!input.roomId)
        return Promise.resolve({
          rooms: [
            {
              id,
              subject: input.offset ? "Older conversation" : "Recent conversation",
              kind: "chat_room",
            },
          ],
          hasMore: !input.offset,
        });
      return Promise.resolve({
        messages: [
          {
            id,
            body: input.cursor ? "Older private message" : "Recent private message",
            sentAt: "2026-01-01T00:00:00Z",
          },
        ],
        nextCursor: input.cursor ? null : "older-page",
      });
    },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const change = vi.fn();
  mount(
    <QueryClientProvider client={client}>
      <BotWorkspaces tab={id} onTabChange={change} onNavigate={vi.fn()} />
    </QueryClientProvider>,
  );
  await waitFor("Read-only. Access is audited");
  click(button("Chat"));
  await waitFor("Recent conversation");
  click(button("Next page"));
  await waitFor("Older conversation");
  click(button("Older conversation"));
  await waitFor("Recent private message");
  click(button("Next page"));
  await waitFor("Older private message");
  expect(callTool).toHaveBeenCalledWith(
    "agent.workspace.read",
    expect.objectContaining({ roomId: id, cursor: "older-page" }),
  );
  expect(await axeViolations()).toEqual([]);
  revoked = true;
  await client.invalidateQueries({ queryKey: ["bots", "workspace"] });
  await waitFor("Observation access was revoked.");
  expect(document.body.textContent).not.toContain("Older private message");
  expect(
    callTool.mock.calls.every(([toolId]) =>
      ["agent.workspace.list", "agent.workspace.read"].includes(String(toolId)),
    ),
  ).toBe(true);
  client.clear();
});
