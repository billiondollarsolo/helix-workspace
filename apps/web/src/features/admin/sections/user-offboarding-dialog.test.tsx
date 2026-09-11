// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UserOffboardingButton } from "./user-offboarding-dialog";
import type { AdminUser } from "../admin-users";
import type { OffboardPreview } from "../user-offboarding-api";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn<typeof fetch>() }));
vi.mock("@/lib/auth", async (original) => ({
  ...(await original<object>()),
  authenticatedFetch: fetchMock,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let actors: AdminUser[];
let previews: Record<string, unknown>[];
let executions: Record<string, unknown>[];
let failList: boolean;
let failPreview: boolean;
let stale: boolean;
let empty: boolean;
const counts = {
  driveFiles: 3,
  driveFolders: 1,
  mailMessages: 4,
  mailDrafts: 2,
  calendars: 1,
  contacts: 6,
  addressBooks: 1,
  assistantConversations: 2,
  assistantMemories: 3,
};
function actor(id: string, type = "user", disabledAt: string | null = null): AdminUser {
  return {
    id,
    orgId: "org-1",
    type,
    displayName: id,
    email: `${id}@example.test`,
    scopes: [],
    disabledAt,
    createdAt: "2026-09-10",
    updatedAt: "2026-09-10",
  };
}
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  actors = [
    actor("Morgan"),
    actor("Mira"),
    actor("Assistant agent", "agent"),
    actor("Disabled", "user", "2026-09-10"),
    actor("System", "system"),
  ];
  previews = [];
  executions = [];
  failList = false;
  failPreview = false;
  stale = false;
  empty = false;
  fetchMock.mockReset();
  fetchMock.mockImplementation((url, init) => {
    const path = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
      string,
      unknown
    >;
    let result: Response;
    if (path.includes("offboard/preview")) {
      previews.push(body);
      if (failPreview) {
        failPreview = false;
        result = Response.json(
          { error: { message: "Handoff preview is temporarily unavailable." } },
          { status: 503 },
        );
      } else {
        const successor = actors.find((entry) => entry.id === body.successorActorId) ?? null;
        const preview: OffboardPreview = {
          source: actors[0]!,
          successor,
          counts: empty
            ? {
                driveFiles: 0,
                driveFolders: 0,
                mailMessages: 0,
                mailDrafts: 0,
                calendars: 0,
                contacts: 0,
                addressBooks: 0,
                assistantConversations: 0,
                assistantMemories: 0,
              }
            : counts,
          blockers: !empty && !successor ? ["Choose a successor for owned resources."] : [],
          receivingAddresses: empty ? [] : ["morgan@example.test"],
          preserveReceivingAddresses: body.preserveReceivingAddresses === true,
          confirmationToken: `preview-${previews.length}`,
        };
        result = Response.json(preview);
      }
    } else if (path.endsWith("/offboard")) {
      executions.push(body);
      if (stale) {
        stale = false;
        result = Response.json(
          { error: { message: "Resources changed. Review the handoff again." } },
          { status: 409 },
        );
      } else
        result = Response.json({
          offboard: {
            actorId: "Morgan",
            orgId: "org-1",
            disabled: true,
            sessionsRevoked: 0,
            appPasswordsRevoked: 1,
            agentCredentialsRevoked: 2,
          },
        });
    } else if (failList) {
      failList = false;
      result = Response.json(
        { error: { message: "Account directory is unavailable." } },
        { status: 503 },
      );
    } else result = Response.json({ users: actors, nextCursor: null });
    return Promise.resolve(result);
  });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
}
async function render() {
  await act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <UserOffboardingButton actorId="Morgan" name="Morgan" />
      </QueryClientProvider>,
    );
    return Promise.resolve();
  });
  await click("Offboard account");
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing ${label}`);
  await act(() => {
    button.click();
    return Promise.resolve();
  });
  await settle();
}
async function select(value: string) {
  const field = document.querySelector<HTMLSelectElement>('[aria-label="New owner"]')!;
  await act(() => {
    field.value = value;
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return Promise.resolve();
  });
}

it("previews exact resources and a selected agent before one explicit offboard, preserving receive-only choices", async () => {
  await render();
  const values = [
    ...document.querySelectorAll<HTMLOptionElement>('select[aria-label="New owner"] option'),
  ].map((option) => option.value);
  expect(values).toEqual(["", "Mira", "Assistant agent"]);
  await click("Review handoff");
  expect(document.body.textContent).toContain("Choose a successor for owned resources.");
  expect(executions).toHaveLength(0);
  await select("Assistant agent");
  expect(document.querySelector('[aria-label="Account handoff preview"]')).toBeNull();
  await act(() => {
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    return Promise.resolve();
  });
  await click("Review handoff");
  const preview = document.querySelector('[aria-label="Account handoff preview"]')!;
  expect([...preview.querySelectorAll("dd")].map((element) => Number(element.textContent))).toEqual(
    Object.values(counts),
  );
  expect(preview.textContent).toContain("Assistant agent (agent)");
  expect(preview.textContent).toContain("receive only");
  expect(document.body.textContent).toContain("never grants permission to send");
  expect(executions).toHaveLength(0);
  const action = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Offboard account" && button.closest('[role="dialog"]'),
  )!;
  await act(() => {
    action.click();
    return Promise.resolve();
  });
  await settle();
  expect(executions).toEqual([
    {
      successorActorId: "Assistant agent",
      preserveReceivingAddresses: true,
      confirmationToken: "preview-2",
    },
  ]);
  expect(document.body.textContent).toContain("Access is disabled for Morgan.");
  await click("Done");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("keeps choices on preview failure and requires a fresh preview after a stale execute", async () => {
  await render();
  await select("Mira");
  failPreview = true;
  await click("Review handoff");
  expect(document.body.textContent).toContain("Handoff preview is temporarily unavailable.");
  expect(document.querySelector<HTMLSelectElement>('[aria-label="New owner"]')?.value).toBe("Mira");
  await click("Review handoff");
  stale = true;
  const confirmButton = () =>
    [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Offboard account" && button.closest('[role="dialog"]'),
    );
  await act(() => {
    confirmButton()?.click();
    return Promise.resolve();
  });
  await settle();
  expect(executions).toHaveLength(1);
  expect(document.body.textContent).toContain("Resources changed.");
  expect(confirmButton()).toBeUndefined();
  await click("Review handoff");
  await act(() => {
    confirmButton()?.click();
    return Promise.resolve();
  });
  await settle();
  expect(executions.at(-1)?.confirmationToken).toBe("preview-3");
});

it("retries the directory and permits a confirmed empty-account offboard without a successor", async () => {
  failList = true;
  empty = true;
  await render();
  expect(document.body.textContent).toContain("Account directory is unavailable.");
  await click("Retry accounts");
  await click("Review handoff");
  expect(document.body.textContent).toContain("No receiving addresses.");
  expect(previews).toEqual([{ preserveReceivingAddresses: false }]);
  const confirmButton = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Offboard account" && button.closest('[role="dialog"]'),
  )!;
  await act(() => {
    confirmButton.click();
    return Promise.resolve();
  });
  await settle();
  expect(executions).toEqual([
    { preserveReceivingAddresses: false, confirmationToken: "preview-1" },
  ]);
});
