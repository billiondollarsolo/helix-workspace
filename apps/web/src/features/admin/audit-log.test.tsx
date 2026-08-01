// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  actorLabel,
  adminAuditLogQueryOptions,
  AuditLogList,
  buildActorOptions,
  formatPayloadSummary,
  listAuditLog,
  prefetchAdminAuditLogQuery,
  type AuditLogListResponse,
  type AuditLogRecord,
} from "./audit-log";
import type { AdminUser } from "./admin-users";
import { ADMIN_NAV_GROUPS } from "./admin-console-data";

/** The sidebar label for a section id — the name an operator clicked to get
 *  here, and therefore the name the page has to be headed with. */
function navLabel(id: string): string {
  const item = ADMIN_NAV_GROUPS.flatMap(
    (group) => group.items as readonly { id: string; label: string }[],
  ).find((candidate) => candidate.id === id);
  if (item === undefined) {
    throw new Error(`No sidebar entry for section: ${id}`);
  }
  return item.label;
}

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ACTOR_ID = "44444444-4444-4444-8444-444444444444";

/** `fetch` accepts a string, a URL, or a Request; stringifying the union blindly
 *  would yield "[object Object]" for the Request form and silently misroute. */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

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
    mockApi({ audit: [() => Response.json(auditLogPage({ nextCursor: "cursor-2" }))] });

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
    // Two independent queries now run, so the audit call is identified by URL
    // rather than by its position in the combined fetch log.
    expect(auditUrls()[0]).toBe("/api/admin/audit-log?limit=50");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("leads with the shared page heading and steps the table panel down one level", async () => {
    mockApi({});

    renderAuditLog();
    await waitForText("tool.invoked");

    // The h1 is the sidebar label, not a second name for the same page: an
    // operator who clicks `Audit log` must land on a page headed "Audit log".
    expect(headingOutline()).toEqual([`H1:${navLabel("audit")}`, "H2:Recent activity"]);
    expect(container.querySelector(".admin-page-subtitle")?.textContent).toContain(
      "Immutable, hash-chained record of privileged activity",
    );
    // One filled button per surface: Apply owns it, paging stays outlined.
    expect(buttonByText("Apply").dataset.variant).toBe("default");
    expect(buttonByText("Newest").dataset.variant).toBe("outline");
    expect(buttonByText("Next page").dataset.variant).toBe("outline");
  });

  it("keeps the table's horizontal overflow inside the table's own container", async () => {
    mockApi({});

    renderAuditLog();
    await waitForText("tool.invoked");

    /* jsdom has no layout, so this pins the mechanism rather than the pixels:
       the seven-column table is wider than the console, and the only thing
       stopping it from widening `.admin-page` — dragging the h1 and subtitle
       off-screen with it — is that every grid ancestor down to the table opts
       out of the automatic min-content minimum. */
    const scroller = container.querySelector('[data-slot="table-container"]');
    expect(scroller?.className).toContain("overflow-x-auto");

    const chain: string[] = [];
    for (let node = scroller?.parentElement; node !== null && node !== container;) {
      if (node === undefined) {
        throw new Error("Table container is not mounted under the page section");
      }
      chain.push(node.className);
      node = node.parentElement;
    }
    expect(chain.length).toBeGreaterThan(0);
    for (const className of chain) {
      expect(className, `ancestor "${className}" would size to the table's min-content`).toContain(
        "min-w-0",
      );
    }
  });

  it("explains an empty result set instead of rendering bare grey text", async () => {
    mockApi({ audit: [() => Response.json({ records: [], nextCursor: null })] });

    renderAuditLog();
    await waitForText("No audit records have been written for this organization yet.");

    expect(container.querySelector(".admin-empty-row")).not.toBeNull();
  });

  it("applies filters and advances cursor pages through query params", async () => {
    mockApi({
      audit: [
        () => Response.json(auditLogPage({ nextCursor: "cursor-2" })),
        () => Response.json(auditLogPage({ nextCursor: "cursor-2" })),
        () => Response.json(auditLogPage({ nextCursor: null })),
      ],
    });

    renderAuditLog();
    await waitForText("tool.invoked");
    await setInputValue("Audit verb filter", "agent.credential.created");
    await setInputValue("Audit object type filter", "credential");
    await clickButton("Apply");

    await waitFor(() =>
      expect(auditUrls()[1]).toBe(
        "/api/admin/audit-log?limit=50&objectType=credential&verb=agent.credential.created",
      ),
    );

    await waitFor(() => expect(buttonByText("Next page").disabled).toBe(false));
    await clickButton("Next page");
    await waitFor(() =>
      expect(auditUrls()[2]).toBe(
        "/api/admin/audit-log?limit=50&cursor=cursor-2&objectType=credential&verb=agent.credential.created",
      ),
    );
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("surfaces audit API failures without native dialogs", async () => {
    mockApi({ audit: [() => Response.json({ error: "denied" }, { status: 403 })] });

    renderAuditLog();

    await waitForText("Audit log is unavailable or missing admin audit scope.");
    const banner = container.querySelector('[data-kind="error"]');
    expect(banner?.textContent).toBe("Audit log is unavailable or missing admin audit scope.");
    expect(banner?.className).toContain("admin-banner");
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("names the actor and keeps the raw id one level in for correlation", async () => {
    mockApi({});

    renderAuditLog();
    await waitForText("Ada Lovelace (ada@helix.local)");

    const cell = actorCell();
    // The name answers "what did this person do?" — the id stays reachable.
    expect(cell.querySelector("summary")?.textContent).toBe("Ada Lovelace (ada@helix.local)");
    expect(cell.querySelector("summary")?.getAttribute("title")).toBe(`Actor id ${ACTOR_ID}`);
    expect(cell.querySelector("details.admin-disclosure")?.textContent).toContain(ACTOR_ID);
    // Disabled actors are the usual subject of an audit search, so the lookup
    // must ask for them explicitly.
    expect(directoryUrls()[0]).toBe("/api/admin/users?includeDisabled=true&limit=250");
  });

  it("renders an actor the directory does not hold as its id, never as a name", async () => {
    mockApi({
      users: () =>
        Response.json(adminUsersPage({ users: [directoryUser({ id: OTHER_ACTOR_ID })] })),
    });

    renderAuditLog();
    await waitForText("tool.invoked");

    const cell = actorCell();
    expect(cell.textContent).not.toContain("Ada Lovelace");
    expect(cell.querySelector("summary")?.textContent).toBe("11111111...1111");
    expect(cell.textContent).toContain(ACTOR_ID);
    expect(cell.textContent).toContain("Not in the current user directory.");
  });

  it("reports a record with no actor as absent rather than naming one", async () => {
    mockApi({
      audit: [() => Response.json(auditLogPage({ records: [auditRecord({ actorId: null })] }))],
    });

    renderAuditLog();
    await waitForText("tool.invoked");

    expect(actorCell().textContent).toBe("No actor recorded");
    expect(actorCell().querySelector("details")).toBeNull();
  });

  it("filters by actor server-side across the whole log, not just loaded rows", async () => {
    mockApi({});

    renderAuditLog();
    await waitForText("Ada Lovelace (ada@helix.local)");

    const select = selectByLabel("Audit actor filter");
    expect(select.disabled).toBe(false);
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["", ACTOR_ID]);

    await setSelectValue("Audit actor filter", ACTOR_ID);
    await clickButton("Apply");

    // The endpoint takes actorId, so the filter spans the whole log — the
    // subtitle is allowed to say so only because of this request.
    await waitFor(() =>
      expect(auditUrls()[1]).toBe(`/api/admin/audit-log?limit=50&actorId=${ACTOR_ID}`),
    );
    expect(container.querySelector(".admin-page-subtitle")?.textContent).toContain(
      "run on the server across the whole log",
    );
  });

  it("clears the actor filter on reset", async () => {
    mockApi({});

    renderAuditLog();
    await waitForText("Ada Lovelace (ada@helix.local)");
    await setSelectValue("Audit actor filter", ACTOR_ID);
    await clickButton("Apply");
    await waitFor(() =>
      expect(auditUrls()[1]).toBe(`/api/admin/audit-log?limit=50&actorId=${ACTOR_ID}`),
    );

    await clickButton("Reset audit log filters");

    await waitFor(() => expect(auditUrls().at(-1)).toBe("/api/admin/audit-log?limit=50"));
    expect(selectByLabel("Audit actor filter").value).toBe("");
  });

  it("keeps rendering rows with raw ids when only the directory lookup fails", async () => {
    mockApi({ users: () => Response.json({ error: "directory down" }, { status: 503 }) });

    renderAuditLog();
    await waitForText("tool.invoked");
    await waitForText("Actor names are unavailable, so the log shows raw actor ids.");

    // The log is the point of the page; a failed secondary lookup must not hide it.
    expect(tableByLabel("Audit log").textContent).toContain("tool.invoked");
    expect(actorCell().textContent).toContain("11111111...1111");
    expect(actorCell().textContent).toContain(ACTOR_ID);
    expect(container.textContent).toContain("only the name lookup failed");
    expect(buttonByText("Retry")).toBeInstanceOf(HTMLButtonElement);
    // Absence is only claimed when the directory actually answered.
    expect(container.textContent).not.toContain("Not in the current user directory.");
    // Ids seen in the loaded rows stay filterable even with no directory.
    const select = selectByLabel("Audit actor filter");
    expect(select.disabled).toBe(false);
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["", ACTOR_ID]);
  });

  it("disables the actor filter with a stated reason when there is nothing to pick", async () => {
    mockApi({
      audit: [() => Response.json({ records: [], nextCursor: null })],
      users: () => Response.json(adminUsersPage({ users: [] })),
    });

    renderAuditLog();
    await waitForText("No audit records have been written for this organization yet.");

    expect(selectByLabel("Audit actor filter").disabled).toBe(true);
    expect(container.querySelector(".admin-unavailable-reason")?.textContent).toBe(
      "No actors available to filter by yet.",
    );
  });

  it("says so when the directory page is truncated instead of implying deletion", async () => {
    mockApi({ users: () => Response.json(adminUsersPage({ nextCursor: "users-2" })) });

    renderAuditLog();
    await waitForText("tool.invoked");

    await waitForText("The directory returned its first 250 actors.");
    expect(container.querySelector('[data-kind="info"]')?.textContent).toContain(
      "not listed in the actor filter",
    );
  });

  function renderAuditLog() {
    act(() => {
      root.render(
        createElement(QueryClientProvider, { client: queryClient }, createElement(AuditLogList)),
      );
    });
  }

  /** The page now issues two independent requests, so responses are routed by
   *  URL. `audit` is a queue of factories (a Response body is single-use); the
   *  last entry repeats for any further calls. */
  function mockApi(options: {
    readonly audit?: readonly (() => Response)[];
    readonly users?: () => Response;
  }) {
    const auditQueue = [...(options.audit ?? [() => Response.json(auditLogPage({}))])];
    const usersHandler = options.users ?? (() => Response.json(adminUsersPage({})));
    fetchMock.mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.startsWith("/api/admin/users")) {
        return Promise.resolve(usersHandler());
      }
      const next = auditQueue.length > 1 ? auditQueue.shift() : auditQueue[0];
      return Promise.resolve(next === undefined ? Response.json(auditLogPage({})) : next());
    });
  }

  function requestUrls(prefix: string): string[] {
    return fetchMock.mock.calls
      .map((call) => requestUrl(call[0]))
      .filter((url) => url.startsWith(prefix));
  }

  function auditUrls(): string[] {
    return requestUrls("/api/admin/audit-log");
  }

  function directoryUrls(): string[] {
    return requestUrls("/api/admin/users");
  }

  function actorCell(): HTMLElement {
    // Column order is asserted separately; Actor is the second cell.
    const cell = tableByLabel("Audit log").querySelector("tbody tr td:nth-child(2)");
    if (!(cell instanceof HTMLElement)) {
      throw new Error("Actor cell not found");
    }
    return cell;
  }

  function selectByLabel(label: string): HTMLSelectElement {
    const select = container.querySelector(`select[aria-label="${label}"]`);
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error(`Select not found: ${label}`);
    }
    return select;
  }

  async function setSelectValue(label: string, value: string) {
    const select = selectByLabel(label);
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")
        ?.set as ((this: HTMLSelectElement, value: string) => void) | undefined;
      valueSetter?.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function headingOutline(): string[] {
    return Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6")).map(
      (heading) => `${heading.tagName}:${heading.textContent ?? ""}`,
    );
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

function auditRecord(overrides: Partial<AuditLogRecord> = {}): AuditLogRecord {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    orgId: "22222222-2222-4222-8222-222222222222",
    actorId: ACTOR_ID,
    verb: "tool.invoked",
    objectType: "tool",
    objectId: "33333333-3333-4333-8333-333333333333",
    traceId: "trace-1",
    payload: { toolId: "mail.send", subject: "Quarterly update" },
    prevHash: null,
    thisHash: "abcdef0123456789",
    createdAt: "2026-05-20T12:05:00.000Z",
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

function directoryUser(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: ACTOR_ID,
    orgId: "22222222-2222-4222-8222-222222222222",
    type: "user",
    email: "ada@helix.local",
    displayName: "Ada Lovelace",
    scopes: ["admin.audit"],
    disabledAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function adminUsersPage(input: {
  readonly nextCursor?: string | null;
  readonly users?: readonly AdminUser[];
}) {
  return {
    users: input.users ?? [directoryUser()],
    nextCursor: input.nextCursor ?? null,
  };
}

describe("audit actor resolution", () => {
  it("labels a directory actor by name and email, omitting an absent address", () => {
    expect(actorLabel(directoryUser())).toBe("Ada Lovelace (ada@helix.local)");
    // A service actor has no address; "Name ()" would read as a missing value.
    expect(actorLabel(directoryUser({ email: null, displayName: "Backup Agent" }))).toBe(
      "Backup Agent",
    );
  });

  it("offers directory actors plus ids only the log knows about", () => {
    const options = buildActorOptions(
      [directoryUser()],
      [auditRecord({ actorId: OTHER_ACTOR_ID }), auditRecord({ actorId: null })],
      "",
    );

    // A deleted actor still has rows, so it must stay filterable — as its id,
    // never under a borrowed name. Named actors lead: sorting the merged list
    // by label alone would float every uuid above the people.
    expect(options).toEqual([
      { id: ACTOR_ID, label: "Ada Lovelace (ada@helix.local)" },
      { id: OTHER_ACTOR_ID, label: OTHER_ACTOR_ID },
    ]);
  });

  it("retains the current selection so an empty result cannot erase its own filter", () => {
    expect(buildActorOptions([], [], OTHER_ACTOR_ID)).toEqual([
      { id: OTHER_ACTOR_ID, label: OTHER_ACTOR_ID },
    ]);
    expect(buildActorOptions(undefined, [], "")).toEqual([]);
  });
});
