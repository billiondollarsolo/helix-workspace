// @vitest-environment jsdom

/* Capabilities of a domain: ownership, sending, receiving.
 *
 * Several of these assertions moved here from the Mail > Sending domains view,
 * which this panel replaced. They are about honesty rather than layout — what
 * the console is allowed to claim about mail that is or is not flowing — so
 * they had to survive the move rather than be deleted with the view.
 */

import { withAdminRouter } from "@/features/admin/console/test-router";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateDomainCapabilities, type DomainWithRecords } from "../domains-api";
import { DomainCapabilitiesPanel, domainSummary } from "./domain-capabilities";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function entry(overrides: Partial<DomainWithRecords> = {}): DomainWithRecords {
  return {
    domain: {
      id: "d-1",
      orgId: "org-1",
      domain: "helix.test",
      isPrimary: false,
      status: "verified",
      identityEnabled: false,
      mailEnabled: false,
      aliasesEnabled: false,
      customHostEnabled: false,
      federationEnabled: false,
      providerId: null,
      identityMode: "secondary",
      aliasTargetDomainId: null,
      verificationHost: "_helix.helix.test",
      verificationValue: "server-challenge",
      verificationExpiresAt: "2026-12-01T00:00:00Z",
      verificationAttempts: 0,
      verificationLastAttemptAt: null,
      quarantinedAt: null,
      releasedAt: null,
      claimableAfter: null,
      verifiedAt: "2026-01-02T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    dnsRecords: [],
    ...overrides,
  };
}

describe("domainSummary", () => {
  it("does not imply mail delivery from ownership alone", () => {
    expect(domainSummary(entry())).toContain("not used for anything yet");
    expect(domainSummary(entry({ domain: { ...entry().domain, status: "pending" } }))).toContain(
      "capabilities are disabled",
    );
    expect(domainSummary(entry({ domain: { ...entry().domain, mailEnabled: true } }))).toContain(
      "Enabled for mail",
    );
  });
});

describe("DomainCapabilitiesPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  function wrap(node: ReactNode): ReactNode {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      withAdminRouter(node, "domains"),
    );
  }

  async function render(value: DomainWithRecords): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      root.render(wrap(createElement(DomainCapabilitiesPanel, { entry: value })));
      await Promise.resolve();
    });
  }

  function labelled(label: string): HTMLButtonElement | null {
    return (
      [...document.querySelectorAll("button")].find(
        (element) => element.getAttribute("aria-label") === label,
      ) ?? null
    );
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
        ),
      ),
    );
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows the server challenge and hides capabilities until ownership is proved", async () => {
    await render(entry({ domain: { ...entry().domain, status: "pending", verifiedAt: null } }));
    expect(container.textContent).toContain("server-challenge");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(labelled("Verify ownership of helix.test")).not.toBeNull();
    await act(() => {
      labelled("Verify ownership of helix.test")?.click();
      return Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledWith(
      "/v1/api/admin/domains/d-1/verify",
      expect.objectContaining({ method: "POST" }),
    );
    expect(new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).has("content-type")).toBe(
      false,
    );
  });

  it("uses the canonical capability route and reports incomplete mail setup", async () => {
    await render(entry());
    expect(container.textContent).toContain("requires a configured provider and verified mail DNS");
    const mail = [...container.querySelectorAll("label")]
      .find((label) => label.textContent === "Mail")
      ?.querySelector("input");
    await act(() => {
      mail?.click();
      return Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledWith(
      "/v1/api/admin/domains/d-1/capabilities",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ mailEnabled: true }) }),
    );
  });

  it("offers only verified secondary identity targets and preserves the server gate when selecting automatic aliases", async () => {
    const value = entry({ domain: { ...entry().domain, mailEnabled: true, aliasesEnabled: true } });
    const target = entry({
      domain: { ...entry().domain, id: "target", domain: "target.test", identityEnabled: true },
    });
    const others = [
      value,
      target,
      entry({ domain: { ...target.domain, id: "pending", status: "pending" } }),
      entry({ domain: { ...target.domain, id: "alias", identityMode: "alias" } }),
    ];
    await act(async () => {
      await Promise.resolve();
      root.render(wrap(createElement(DomainCapabilitiesPanel, { entry: value, domains: others })));
    });
    const selects = () => [...container.querySelectorAll("select")];
    await act(async () => {
      await Promise.resolve();
      const mode = selects()[0]!;
      mode.value = "alias";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const targetSelect = selects()[1]!;
    expect([...targetSelect.options].map((option) => option.value)).toEqual(["", "target"]);
    await act(async () => {
      await Promise.resolve();
      targetSelect.value = "target";
      targetSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(fetch).toHaveBeenCalledWith(
      "/v1/api/admin/domains/d-1/capabilities",
      expect.objectContaining({
        body: JSON.stringify({ identityMode: "alias", aliasTargetDomainId: "target" }),
      }),
    );
    await render(entry({ domain: { ...entry().domain, isPrimary: true } }));
    expect(selects()[0]?.disabled).toBe(true);
  });
  it("explains lost delivery before disabling mail and retains stored keys", async () => {
    await render(entry({ domain: { ...entry().domain, mailEnabled: true } }));
    const mail = [...container.querySelectorAll("label")]
      .find((label) => label.textContent === "Mail")
      ?.querySelector("input");
    await act(() => {
      mail?.click();
      return Promise.resolve();
    });
    expect(document.body.textContent).toContain("stops accepting and sending mail");
    expect(document.body.textContent).toContain("keys are retained");
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("keeps crown-jewel MFA and approval requirements actionable without claiming a successful change", async () => {
  const mfa = () =>
    Promise.resolve(
      Response.json(
        { code: "crown_jewel_step_up_required", error: "Recent MFA verification is required." },
        { status: 403 },
      ),
    );
  const approval = () =>
    Promise.resolve(
      Response.json(
        { code: "crown_jewel_approval_required", approval: { id: "approval-1" } },
        { status: 202 },
      ),
    );
  await expect(updateDomainCapabilities("d-1", { aliasesEnabled: true }, mfa)).rejects.toThrow(
    "Recent MFA verification is required.",
  );
  await expect(updateDomainCapabilities("d-1", { aliasesEnabled: true }, approval)).rejects.toThrow(
    "A second administrator must approve this change (request approval-1). The requested change has not been applied.",
  );
});
