// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/lib/auth";
import { QUERY_RETRY_DEFAULTS } from "@/lib/query-retry";
import { useEnabledApps } from "@/features/apps/use-enabled-apps";
import { NotificationsPanel } from "./notifications-panel";

vi.mock("@/lib/auth", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const requestsFor = (suffix: string) =>
  vi
    .mocked(authenticatedFetch)
    .mock.calls.filter(([url]) => typeof url === "string" && url.endsWith(suffix));

function AppsConsumer() {
  const apps = useEnabledApps();
  return <span>{apps.isEnabled("mail") ? "Mail enabled" : "Mail disabled"}</span>;
}
async function render(open: boolean) {
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <AppsConsumer />
        <AppsConsumer />
        <NotificationsPanel open={open} onClose={() => undefined} />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: QUERY_RETRY_DEFAULTS } });
  vi.mocked(authenticatedFetch).mockImplementation((url) =>
    Promise.resolve(
      Response.json(
        typeof url === "string" && url.endsWith("core-apps")
          ? { role: "all", apps: [] }
          : { items: [] },
      ),
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

it("deduplicates shell app reads and defers the feed until opened, including invalidation while closed", async () => {
  await render(false);
  expect(requestsFor("core-apps")).toHaveLength(1);
  expect(requestsFor("notifications.list")).toHaveLength(0);
  await render(true);
  expect(requestsFor("notifications.list")).toHaveLength(1);
  await render(false);
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["notifications"] });
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(requestsFor("notifications.list")).toHaveLength(1);
  await render(true);
  expect(requestsFor("notifications.list")).toHaveLength(2);
});

it("keeps a persistent 429 visible after bounded retries and recovers only when retried", async () => {
  vi.mocked(authenticatedFetch).mockImplementation((url) =>
    Promise.resolve(
      Response.json(
        typeof url === "string" && url.endsWith("core-apps")
          ? { role: "all", apps: [] }
          : { error: { code: "RATE_LIMITED", message: "Too many requests." } },
        typeof url === "string" && url.endsWith("core-apps")
          ? {}
          : { status: 429, headers: { "Retry-After": "2" } },
      ),
    ),
  );
  await render(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(requestsFor("notifications.list")).toHaveLength(4);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not load notifications",
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(requestsFor("notifications.list")).toHaveLength(4);
  vi.mocked(authenticatedFetch).mockResolvedValue(Response.json({ items: [] }));
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  );
  expect(retry).toBeDefined();
  await act(async () => {
    retry?.click();
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(requestsFor("notifications.list")).toHaveLength(5);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
