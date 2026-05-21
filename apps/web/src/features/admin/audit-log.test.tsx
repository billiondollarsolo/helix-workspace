// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminAuditLogQueryOptions,
  AuditLogList,
  formatPayloadSummary,
  listAuditLog,
  prefetchAdminAuditLogQuery,
  type AuditLogListResponse,
} from "./audit-log";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("AuditLogList admin UI", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let alertMock: ReturnType<typeof vi.fn>;
  let confirmMock: ReturnType<typeof vi.fn>;
  let promptMock: ReturnType<typeof vi.fn>;

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
    alertMock = vi.fn();
    confirmMock = vi.fn();
    promptMock = vi.fn();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("alert", alertMock);
    vi.stubGlobal("confirm", confirmMock);
    vi.stubGlobal("prompt", promptMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders audit records with TanStack table semantics", async () => {
    fetchMock.mockResolvedValue(Response.json(auditLogPage({ nextCursor: "cursor-2" })));

    renderAuditLog();
    await waitForText("tool.invoked");

    const table = tableByLabel("Audit log");
    const headers = Array.from(table.querySelectorAll('[role="columnheader"]')).map(
      (header) => header.textContent,
    );
    expect(headers).toEqual(["Time", "Actor", "Event", "Object", "Trace", "Hash", "Payload"]);
    expect(table.textContent).toContain("tool.invoked");
    expect(table.textContent).toContain("tool:33333333...3333");
    expect(table.textContent).toContain("toolId: mail.send");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/audit-log?limit=50");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("applies filters and advances cursor pages through query params", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(auditLogPage({ nextCursor: "cursor-2" })))
      .mockResolvedValueOnce(Response.json(auditLogPage({ nextCursor: "cursor-2" })))
      .mockResolvedValueOnce(Response.json(auditLogPage({ nextCursor: null })));

    renderAuditLog();
    await waitForText("tool.invoked");
    await setInputValue("Audit verb filter", "agent.credential.created");
    await setInputValue("Audit object type filter", "credential");
    await clickButton("Apply");

    await waitFor(() =>
      expect(fetchMock.mock.calls[1]?.[0]).toBe(
        "/api/admin/audit-log?limit=50&objectType=credential&verb=agent.credential.created",
      ),
    );

    await waitFor(() => expect(buttonByText("Next page").disabled).toBe(false));
    await clickButton("Next page");
    await waitFor(() =>
      expect(fetchMock.mock.calls[2]?.[0]).toBe(
        "/api/admin/audit-log?limit=50&cursor=cursor-2&objectType=credential&verb=agent.credential.created",
      ),
    );
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("surfaces audit API failures without native dialogs", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "denied" }, { status: 403 }));

    renderAuditLog();

    await waitForText("Audit log is unavailable or missing admin audit scope.");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Audit log is unavailable or missing admin audit scope.",
    );
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  function renderAuditLog() {
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(AuditLogList),
        ),
      );
    });
  }

  function tableByLabel(label: string): HTMLElement {
    const table = container.querySelector(`[role="table"][aria-label="${label}"]`);
    if (!(table instanceof HTMLElement)) {
      throw new Error(`Table not found: ${label}`);
    }
    return table;
  }

  async function clickButton(name: string) {
    const button = buttonByText(name);
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function buttonByText(name: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(name),
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Button not found: ${name}`);
    }
    return button;
  }

  async function setInputValue(label: string, value: string) {
    const input = container.querySelector(`input[aria-label="${label}"]`);
    if (!(input instanceof HTMLInputElement)) {
      throw new Error(`Input not found: ${label}`);
    }
    act(() => {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        ?.set as ((this: HTMLInputElement, value: string) => void) | undefined;
      valueSetter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function waitForText(text: string) {
    await waitFor(() => expect(container.textContent).toContain(text));
  }

  async function waitFor(assertion: () => void | Promise<void>) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await act(async () => {
          await Promise.resolve();
        });
        await assertion();
        return;
      } catch (error) {
        lastError = error;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
    }
    throw lastError;
  }
});

describe("audit log API helpers", () => {
  it("builds list query params and validates response shape", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(auditLogPage({})));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: vi.fn(() => null) },
    });

    await expect(
      listAuditLog({ limit: 25, verb: " tool.invoked ", objectType: "tool" }),
    ).resolves.toEqual(auditLogPage({}));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/admin/audit-log?limit=25&objectType=tool&verb=tool.invoked",
    );

    vi.unstubAllGlobals();
  });

  it("prefetches the default audit log query with contained errors", async () => {
    const ensureQueryData = vi
      .fn<(options: ReturnType<typeof adminAuditLogQueryOptions>) => Promise<unknown>>()
      .mockRejectedValue(new Error("audit unavailable"));

    await expect(prefetchAdminAuditLogQuery({ ensureQueryData })).resolves.toBeUndefined();

    expect(ensureQueryData).toHaveBeenCalledTimes(1);
  });

  it("summarizes common payload values for compact table cells", () => {
    expect(
      formatPayloadSummary({
        toolId: "mail.send",
        approved: true,
        count: 2,
        ignored: "later",
      }),
    ).toBe("toolId: mail.send, approved: true, count: 2");
    expect(formatPayloadSummary({ nested: { id: "x" }, values: ["a", "b"] })).toBe(
      "nested: {...}, values: [2 items]",
    );
  });
});

function auditLogPage(input: { readonly nextCursor?: string | null }): AuditLogListResponse {
  return {
    records: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        orgId: "22222222-2222-4222-8222-222222222222",
        actorId: "11111111-1111-4111-8111-111111111111",
        verb: "tool.invoked",
        objectType: "tool",
        objectId: "33333333-3333-4333-8333-333333333333",
        traceId: "trace-1",
        payload: { toolId: "mail.send", subject: "Quarterly update" },
        prevHash: null,
        thisHash: "abcdef0123456789",
        createdAt: "2026-05-20T12:05:00.000Z",
      },
    ],
    nextCursor: input.nextCursor ?? null,
  };
}
