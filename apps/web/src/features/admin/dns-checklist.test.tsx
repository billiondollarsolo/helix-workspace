// @vitest-environment jsdom

/* Admin › Domains › DNS and proxy — each hostname with its purpose, what its
 * record should be and is, advice only where something needs doing, a
 * Refresh that asks again, and a failure that says so. */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DnsChecklistPanel } from "./dns-checklist";
import type { DnsChecklistRow } from "./dns-checklist-api";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const ROWS: DnsChecklistRow[] = [
  {
    hostname: "workspace.example.com",
    role: "web",
    expected: "proxied",
    observed: "proxied",
    addresses: ["104.16.1.1"],
    status: "ok",
    advice: "",
  },
  {
    hostname: "mail.example.com",
    role: "mail",
    expected: "dns-only",
    observed: "proxied",
    addresses: ["104.16.1.2"],
    status: "problem",
    advice: "Mail and TURN can’t pass through an HTTP proxy. Set this record to DNS-only.",
  },
  {
    hostname: "app.example.com",
    role: "app",
    expected: "proxied",
    observed: "dns-only",
    addresses: ["203.0.113.5"],
    status: "recommend",
    advice: "Proxy this record and keep the origin locked to the proxy’s addresses.",
  },
];

describe("DnsChecklistPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  /** Polls with real timers — react-query settles over several ticks. */
  async function waitFor(assertion: () => void, timeout = 1000): Promise<void> {
    const start = Date.now();
    let lastError: unknown;
    while (Date.now() - start <= timeout) {
      try {
        assertion();
        return;
      } catch (error) {
        lastError = error;
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async function render(): Promise<void> {
    await act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(DnsChecklistPanel),
        ),
      );
      return Promise.resolve();
    });
  }

  function rowText(hostname: string): string {
    const row = [...container.querySelectorAll('[role="row"], tr')].find((element) =>
      element.textContent?.includes(hostname),
    );
    if (row === undefined) throw new Error(`No row for ${hostname}`);
    return row.textContent ?? "";
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ rows: ROWS })));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  it("lists each hostname with its purpose, expectation, state, and advice", async () => {
    await render();
    await waitFor(() => expect(container.textContent).toContain("mail.example.com"));

    expect(container.textContent).toContain(
      "Web apps can sit behind Cloudflare (orange cloud). Mail and Meet’s relay must stay DNS-only.",
    );
    expect(fetchMock.mock.calls[0]?.[0] as string).toContain("/api/admin/domains/dns-checklist");

    const web = rowText("workspace.example.com");
    expect(web).toContain("Workspace");
    expect(web).not.toContain("Proxy this record");

    const mail = rowText("mail.example.com");
    expect(mail).toContain("Mail");
    expect(mail).toContain("DNS-only");
    expect(mail).toContain("Set this record to DNS-only.");
    expect(
      [...container.querySelectorAll(".chip.danger")].some((chip) =>
        chip.textContent?.includes("Proxied"),
      ),
    ).toBe(true);

    const app = rowText("app.example.com");
    expect(app).toContain("Federated app");
    expect(app).toContain("Proxy this record and keep the origin locked");
  });

  it("checks again when Refresh is pressed", async () => {
    await render();
    await waitFor(() => expect(container.textContent).toContain("mail.example.com"));
    const refresh = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Refresh",
    );
    expect(refresh).toBeDefined();
    await act(async () => {
      refresh?.click();
      await Promise.resolve();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("says when the records could not be checked", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ error: "Not allowed" }, { status: 403 })),
    );
    await render();
    await waitFor(() =>
      expect(container.textContent).toContain("DNS records could not be checked."),
    );
  });
});
