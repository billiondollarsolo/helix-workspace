// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriveAccessRequests } from "./drive-access-requests";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("DriveAccessRequests", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let toolCalls: Array<{ readonly url: string; readonly body: unknown }>;

  beforeEach(() => {
    document.cookie = "helix_csrf=test-csrf; path=/";
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    toolCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        toolCalls.push({ url, body });
        if (url === "/v1/api/auth/csrf-token") {
          return Promise.resolve(Response.json({ csrfToken: "test-csrf" }));
        }
        if (url === "/v1/api/tools/drive.access.requests") {
          return Promise.resolve(
            Response.json({
              requests: [
                {
                  id: "req-1",
                  objectId: "file-1",
                  requesterActorId: "actor-2",
                  requesterDisplayName: "Maya Chen",
                  requesterEmail: "maya@helix.local",
                  objectName: "Q3 roadmap.pdf",
                  message: null,
                  createdAt: "2026-05-20T12:00:00.000Z",
                },
              ],
            }),
          );
        }
        if (url === "/v1/api/tools/drive.access.decide") {
          return Promise.resolve(Response.json({ requestId: "req-1", approved: true }));
        }
        return Promise.resolve(Response.json({}));
      }),
    );
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  async function settle() {
    for (let index = 0; index < 20; index += 1) {
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    }
  }

  it("lets an owner approve a pending request", async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DriveAccessRequests />
        </QueryClientProvider>,
      );
    });
    await settle();
    expect(container.textContent ?? "").toContain("Maya Chen wants access to Q3 roadmap.pdf");
    const approve = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Approve",
    );
    act(() => {
      approve?.click();
    });
    await settle();
    expect(
      toolCalls.find((call) => call.url === "/v1/api/tools/drive.access.decide")?.body,
    ).toEqual({ requestId: "req-1", approve: true });
  });
});
