// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminAuditLogQueryOptions,
  listAuditLog,
  readableEvent,
  type AuditLogListResponse,
  type AuditLogRecord,
} from "./audit-api";
import { auditDateBounds, EMPTY_AUDIT_FILTERS } from "./audit-filters";
import { AuditLogList, prefetchAdminAuditLogQuery } from "./audit-log";
import type { AdminUser } from "./admin-users";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("AuditLogList", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  function renderAuditLog() {
    act(() => {
      root.render(
        createElement(QueryClientProvider, { client: queryClient }, createElement(AuditLogList)),
      );
    });
  }

  function mockApi(options: { readonly audit?: () => Response; readonly users?: () => Response }) {
    fetchMock.mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.startsWith("/v1/api/admin/users")) {
        return Promise.resolve((options.users ?? (() => Response.json(usersPage())))());
      }
      return Promise.resolve((options.audit ?? (() => Response.json(auditLogPage({}))))());
    });
  }

  function auditUrls(): string[] {
    return fetchMock.mock.calls
      .map((call) => requestUrl(call[0]))
      .filter((url) => url.startsWith("/v1/api/admin/audit-log"));
  }

  function tableText(): string {
    return container.querySelector('table[aria-label="Audit log"]')?.textContent ?? "";
  }

  async function waitFor(assertion: () => void) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await act(async () => {
          await Promise.resolve();
        });
        assertion();
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

  async function setSelect(label: string, value: string) {
    const field = [...container.querySelectorAll("label")].find(
      (candidate) => candidate.querySelector("span")?.textContent === label,
    );
    const select = field?.querySelector("select");
    if (!select) {
      throw new Error(`Select not found: ${label}`);
    }
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
        select,
        value,
      );
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("shows a readable event, outcome, actor name, and relative date per record", async () => {
    mockApi({});
    renderAuditLog();

    await waitFor(() => {
      expect(tableText()).toContain("Tool invocation executed");
    });
    const headers = [...container.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(headers).toEqual(["Event", "Outcome", "Actor", "Date"]);
    expect(tableText()).toContain("Succeeded");
    await waitFor(() => {
      expect(tableText()).toContain("Ada Lovelace");
    });
    const time = container.querySelector("tbody time");
    expect(time?.getAttribute("dateTime")).toBe("2026-05-20T12:05:00.000Z");
    expect(time?.getAttribute("title")).not.toBe("");
    /* The raw hash and payload are no longer table columns. */
    expect(tableText()).not.toContain("abcdef0123456789");
    expect(auditUrls()[0]).toBe("/v1/api/admin/audit-log?limit=50");
  });

  it("uses a fixed-layout table so the page never scrolls sideways", async () => {
    mockApi({});
    renderAuditLog();
    await waitFor(() => {
      expect(tableText()).toContain("Tool invocation executed");
    });
    expect(container.querySelector(".admin-audit-table table")).not.toBeNull();
    expect(container.querySelectorAll("thead th")).toHaveLength(4);
  });

  it("opens the full record, raw JSON included, in a details sheet", async () => {
    mockApi({});
    renderAuditLog();
    await waitFor(() => {
      expect(tableText()).toContain("Tool invocation executed");
    });

    const open = container.querySelector<HTMLButtonElement>(".admin-audit-event");
    act(() => {
      open?.click();
    });

    await waitFor(() => {
      expect(document.querySelector('[data-slot="side-sheet"]')).not.toBeNull();
    });
    const sheet = document.querySelector('[data-slot="side-sheet"]');
    expect(sheet?.textContent).toContain("tool.invocation.executed");
    const raw = sheet?.querySelector("pre")?.textContent ?? "";
    expect(JSON.parse(raw)).toMatchObject({ thisHash: "abcdef0123456789", outcome: "success" });
  });

  it("marks failed and denied events", async () => {
    mockApi({
      audit: () =>
        Response.json(
          auditLogPage({
            records: [
              auditRecord({ id: "a", verb: "tool.invocation.denied", outcome: "denied" }),
              auditRecord({ id: "b", verb: "scim.auth.failed", outcome: "failure" }),
            ],
          }),
        ),
    });
    renderAuditLog();
    await waitFor(() => {
      expect(tableText()).toContain("Denied");
    });
    expect(tableText()).toContain("Failed");
  });

  it("filters by outcome and date range on the server", async () => {
    mockApi({});
    renderAuditLog();
    await waitFor(() => {
      expect(tableText()).toContain("Tool invocation executed");
    });

    await setSelect("Outcome", "denied");
    await waitFor(() => {
      expect(auditUrls().at(-1)).toContain("outcome=denied");
    });

    await setSelect("Date", "7d");
    await waitFor(() => {
      expect(auditUrls().at(-1)).toMatch(/since=\d{4}-\d{2}-\d{2}T/u);
    });
    expect(auditUrls().at(-1)).toContain("outcome=denied");
  });

  it("offers a custom range with From and To pickers", async () => {
    mockApi({});
    renderAuditLog();
    await setSelect("Date", "custom");
    const range = container.querySelector('[role="group"][aria-label="Custom date range"]');
    expect(range?.textContent).toContain("From");
    expect(range?.textContent).toContain("To");
  });

  it("picks the actor with the people picker", () => {
    mockApi({});
    renderAuditLog();
    const actor = container.querySelector(".admin-audit-actor [role='combobox']");
    expect(actor).not.toBeNull();
    expect(container.querySelector(".admin-audit-actor label")?.textContent).toBe("Actor");
  });

  it("filters by event name when Enter is pressed", async () => {
    mockApi({});
    renderAuditLog();
    const field = [...container.querySelectorAll("label")].find(
      (candidate) => candidate.querySelector("span")?.textContent === "Event",
    );
    const input = field?.querySelector("input");
    if (!input) throw new Error("Event input not found");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "tool.invocation.denied",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await waitFor(() => {
      expect(auditUrls().at(-1)).toContain("verb=tool.invocation.denied");
    });
  });

  it("pages older records through the cursor", async () => {
    mockApi({ audit: () => Response.json(auditLogPage({ nextCursor: "cursor-2" })) });
    renderAuditLog();
    await waitFor(() => {
      expect(tableText()).toContain("Tool invocation executed");
    });
    const older = container.querySelector<HTMLButtonElement>('button[aria-label="Older"]');
    act(() => {
      older?.click();
    });
    await waitFor(() => {
      expect(auditUrls().at(-1)).toContain("cursor=cursor-2");
    });
  });

  it("shows an empty state that matches the filters", async () => {
    mockApi({ audit: () => Response.json(auditLogPage({ records: [] })) });
    renderAuditLog();
    await waitFor(() => {
      expect(container.textContent).toContain("No activity yet");
    });
    await setSelect("Outcome", "failure");
    await waitFor(() => {
      expect(container.textContent).toContain("No activity matches these filters");
    });
  });

  it("reports a failure with a retry", async () => {
    mockApi({ audit: () => Response.json({ error: "Audit denied." }, { status: 403 }) });
    renderAuditLog();
    await waitFor(() => {
      expect(container.textContent).toContain("The audit log couldn't be loaded");
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain("Audit denied.");
  });

  it("names an actor the directory does not hold as unknown and a missing actor as none", async () => {
    mockApi({
      audit: () =>
        Response.json(
          auditLogPage({
            records: [
              auditRecord({ id: "a", actorId: "99999999-9999-4999-8999-999999999999" }),
              auditRecord({ id: "b", actorId: null }),
            ],
          }),
        ),
    });
    renderAuditLog();
    await waitFor(() => {
      expect(tableText()).toContain("Unknown account");
    });
    expect(tableText()).toContain("No actor");
  });
});

describe("audit log API helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds list query params, including outcome and dates, and validates the response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(auditLogPage({})));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listAuditLog({
        limit: 25,
        verb: " tool.invoked ",
        objectType: "tool",
        outcome: "failure",
        since: "2026-05-01T00:00:00.000Z",
      }),
    ).resolves.toEqual(auditLogPage({}));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/v1/api/admin/audit-log?limit=25&objectType=tool&outcome=failure&since=2026-05-01T00%3A00%3A00.000Z&verb=tool.invoked",
    );
  });

  it("rejects a record without an outcome", async () => {
    const withoutOutcome = Object.fromEntries(
      Object.entries(auditRecord()).filter(([key]) => key !== "outcome"),
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ records: [withoutOutcome], nextCursor: null })),
    );
    await expect(listAuditLog()).rejects.toThrow("missing required fields");
  });

  it("prefetches the default audit log query with contained errors", async () => {
    const ensureQueryData = vi
      .fn<(options: ReturnType<typeof adminAuditLogQueryOptions>) => Promise<unknown>>()
      .mockRejectedValue(new Error("audit unavailable"));

    await expect(prefetchAdminAuditLogQuery({ ensureQueryData })).resolves.toBeUndefined();
    expect(ensureQueryData).toHaveBeenCalledTimes(1);
  });

  it("turns a verb into a readable event name", () => {
    expect(readableEvent("tool.invocation.executed")).toBe("Tool invocation executed");
    expect(readableEvent("admin.tenant_config.updated")).toBe("Admin tenant config updated");
  });

  it("turns date presets into server bounds", () => {
    const now = new Date("2026-05-20T12:00:00.000Z");
    expect(auditDateBounds(EMPTY_AUDIT_FILTERS, now)).toEqual({});
    expect(auditDateBounds({ ...EMPTY_AUDIT_FILTERS, datePreset: "24h" }, now)).toEqual({
      since: "2026-05-19T12:00:00.000Z",
    });
    const from = new Date("2026-05-01T00:00:00.000Z");
    const to = new Date("2026-05-02T00:00:00.000Z");
    expect(
      auditDateBounds({ ...EMPTY_AUDIT_FILTERS, datePreset: "custom", from, to }, now),
    ).toEqual({ since: "2026-05-01T00:00:00.000Z", until: "2026-05-03T00:00:00.000Z" });
  });
});

function auditRecord(overrides: Partial<AuditLogRecord> = {}): AuditLogRecord {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    orgId: "22222222-2222-4222-8222-222222222222",
    actorId: ACTOR_ID,
    verb: "tool.invocation.executed",
    objectType: "tool",
    objectId: "33333333-3333-4333-8333-333333333333",
    traceId: "trace-1",
    payload: { toolId: "mail.send" },
    prevHash: null,
    thisHash: "abcdef0123456789",
    createdAt: "2026-05-20T12:05:00.000Z",
    outcome: "success",
    ...overrides,
  };
}

function auditLogPage(input: {
  readonly nextCursor?: string | null;
  readonly records?: readonly AuditLogRecord[];
}): AuditLogListResponse {
  return {
    records: input.records ?? [auditRecord()],
    nextCursor: input.nextCursor ?? null,
  };
}

function usersPage() {
  const user: AdminUser = {
    id: ACTOR_ID,
    orgId: "22222222-2222-4222-8222-222222222222",
    type: "user",
    email: "ada@helix.local",
    displayName: "Ada Lovelace",
    scopes: ["admin.audit"],
    status: "active",
    disabledAt: null,
    lastSignInAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return { users: [user], nextCursor: null };
}
