// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriveAdminSection, policyToForm } from "./drive-admin";
import {
  DRIVE_PLATFORM_DEFAULT_ORPHAN_GRACE_HOURS,
  DRIVE_PLATFORM_DEFAULT_TRASH_RETENTION_DAYS,
  mapLifecycleFormToToolInput,
} from "./drive-admin-api";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

async function waitFor(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

describe("DriveAdminSection helpers", () => {
  it("hydrates form fields from a configured policy", () => {
    expect(
      policyToForm({
        orgId: "11111111-1111-4111-8111-111111111111",
        trashRetentionDays: 60,
        orphanGraceHours: 12,
        updatedByActorId: null,
        updatedAt: "2026-08-01T00:00:00.000Z",
        configured: true,
      }),
    ).toEqual({ trashRetentionDays: "60", orphanGraceHours: "12" });
  });

  it("keeps lifecycle mapper aligned with tool contracts", () => {
    expect(
      mapLifecycleFormToToolInput({
        trashRetentionDays: String(DRIVE_PLATFORM_DEFAULT_TRASH_RETENTION_DAYS),
        orphanGraceHours: String(DRIVE_PLATFORM_DEFAULT_ORPHAN_GRACE_HOURS),
      }),
    ).toEqual({
      trashRetentionDays: DRIVE_PLATFORM_DEFAULT_TRASH_RETENTION_DAYS,
      orphanGraceHours: DRIVE_PLATFORM_DEFAULT_ORPHAN_GRACE_HOURS,
    });
  });
});

describe("DriveAdminSection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    fetchMock = vi.fn<typeof fetch>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders quota and lifecycle panels from tool responses", async () => {
    fetchMock.mockImplementation((input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("drive.quota.usage")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              orgId: "11111111-1111-4111-8111-111111111111",
              usedBytes: 1024,
              limitBytes: 2048,
              unlimited: false,
              percentUsed: 50,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (url.includes("drive.lifecycle.get")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              orgId: "11111111-1111-4111-8111-111111111111",
              trashRetentionDays: 30,
              orphanGraceHours: 24,
              updatedByActorId: null,
              updatedAt: null,
              configured: false,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    await act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(DriveAdminSection),
        ),
      );
      return Promise.resolve();
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="drive-admin-section"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="drive-quota-panel"]')?.textContent ?? "").toMatch(
        /50%/,
      );
      expect(container.textContent ?? "").toMatch(/Lifecycle policy/i);
      expect(container.textContent ?? "").toMatch(/Trash retention/i);
    });
  });

  it("surfaces missing-scope unavailability without silent controls", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );

    await act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(DriveAdminSection),
        ),
      );
      return Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent ?? "").toMatch(/admin\.drive/);
    });
  });
});
