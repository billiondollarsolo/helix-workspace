// @vitest-environment jsdom

/* Capabilities of a domain: ownership, sending, receiving.
 *
 * Several of these assertions moved here from the Mail > Sending domains view,
 * which this panel replaced. They are about honesty rather than layout — what
 * the console is allowed to claim about mail that is or is not flowing — so
 * they had to survive the move rather than be deleted with the view.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainWithRecords } from "../domains-api";
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
      verificationStatus: "verified",
      verifiedAt: "2026-01-02T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    dnsRecords: [],
    sending: null,
    receiving: null,
    ...overrides,
  };
}

function sending(overrides: Record<string, unknown> = {}) {
  return { id: "s-1", isDefault: false, verifiedAt: null, dkimKeyCount: 0, ...overrides };
}

describe("domainSummary", () => {
  it("leads with ownership when the domain is unproved", () => {
    const summary = domainSummary(
      entry({ domain: { ...entry().domain, verificationStatus: "pending", verifiedAt: null } }),
    );
    expect(summary).toContain("not proved");
    expect(summary).toContain("no mail flows");
  });

  it("says a proved domain is unused rather than implying it works", () => {
    /* "Ownership is proved" alone reads as done. It is not — nothing is
       switched on, and no mail moves either way. */
    expect(domainSummary(entry())).toContain("not used for anything yet");
  });

  it("flags a sending domain whose DNS has not completed", () => {
    // Reporting plain "sending" here would claim mail is being signed.
    const summary = domainSummary(entry({ sending: sending({ verifiedAt: null }) }));
    expect(summary).toContain("DNS incomplete");
  });

  it("counts receiving only when the domain is actually accepting mail", () => {
    const setUpButOff = domainSummary(
      entry({ receiving: { id: "r-1", status: "verified" as const } }),
    );
    expect(setUpButOff).not.toContain("receiving");

    const live = domainSummary(entry({ receiving: { id: "r-1", status: "active" as const } }));
    expect(live).toContain("receiving");
  });
});

describe("DomainCapabilitiesPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  function wrap(node: ReactNode): ReactNode {
    return createElement(QueryClientProvider, { client: queryClient }, node);
  }

  async function render(value: DomainWithRecords): Promise<void> {
    await act(async () => {
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

  it("hides the capabilities until ownership is proved", async () => {
    /* Progressive disclosure with teeth: the server refuses to enable a
       capability on an unproved domain, so rendering the controls would offer
       buttons that can only fail. */
    await render(
      entry({ domain: { ...entry().domain, verificationStatus: "pending", verifiedAt: null } }),
    );

    expect(container.textContent).toContain("Not proved");
    expect(labelled("Turn on sending for helix.test")).toBeNull();
    expect(labelled("Turn on receiving for helix.test")).toBeNull();
    // The way forward is still offered.
    expect(labelled("Issue a verification record for helix.test")).not.toBeNull();
  });

  it("offers both capabilities once the domain is proved", async () => {
    await render(entry());

    expect(labelled("Turn on sending for helix.test")).not.toBeNull();
    expect(labelled("Turn on receiving for helix.test")).not.toBeNull();
  });

  it("prompts for a first DKIM key and hides rotation until one exists", async () => {
    // Moved from the Sending domains view: rotating nothing is not an action.
    await render(entry({ sending: sending({ dkimKeyCount: 0 }) }));

    expect(labelled("Generate a DKIM key for helix.test")).not.toBeNull();
    expect(labelled("Rotate the DKIM key for helix.test")).toBeNull();
  });

  it("offers rotation once a key exists", async () => {
    await render(entry({ sending: sending({ dkimKeyCount: 1 }) }));

    expect(labelled("Rotate the DKIM key for helix.test")).not.toBeNull();
    expect(labelled("Generate a DKIM key for helix.test")).toBeNull();
  });

  it("will not claim mail is signed when DKIM has not verified", async () => {
    /* The signature bug this guards: an else-branch that reads as a positive
       claim. A domain switched on for sending with unverified DNS is the
       dangerous state, and the note has to say so. */
    await render(entry({ sending: sending({ verifiedAt: null, dkimKeyCount: 0 }) }));

    expect(container.textContent).toContain("have not both verified");
    expect(container.textContent).toContain("No DKIM key has been generated");
    expect(container.textContent).not.toContain("mail from this domain is signed");
  });

  it("states the real key count rather than guessing", async () => {
    await render(entry({ sending: sending({ verifiedAt: null, dkimKeyCount: 2 }) }));

    expect(container.textContent).toContain("2 DKIM key(s) present");
  });

  it("warns that rotating a key opens a window where mail can fail", async () => {
    // Rotation is not a deletion, but it is a timed outage.
    await render(entry({ sending: sending({ dkimKeyCount: 1 }) }));

    await act(async () => {
      labelled("Rotate the DKIM key for helix.test")?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("can fail DKIM");
    expect(document.body.textContent).toContain("until the new selector");
  });

  it("names the DKIM keys lost when sending is turned off", async () => {
    await render(entry({ sending: sending({ dkimKeyCount: 3 }) }));

    await act(async () => {
      labelled("Turn off sending for helix.test")?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("3 DKIM signing key(s) are destroyed");
    expect(document.body.textContent).toContain("published and verified again");
  });

  it("does not claim keys are lost when there are none", async () => {
    await render(entry({ sending: sending({ dkimKeyCount: 0 }) }));

    await act(async () => {
      labelled("Turn off sending for helix.test")?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("no DKIM keys to lose");
  });

  it("warns that live inbound mail starts bouncing", async () => {
    await render(entry({ receiving: { id: "r-1", status: "active" } }));

    await act(async () => {
      labelled("Turn off receiving for helix.test")?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("stops accepting mail");
    expect(document.body.textContent).toContain("bounce");
  });

  it("does not claim mail stops for a domain that never accepted any", async () => {
    // The false alarm: warning about delivery a domain never carried.
    await render(entry({ receiving: { id: "r-1", status: "pending" } }));

    await act(async () => {
      labelled("Turn off receiving for helix.test")?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("not accepting mail right now");
    expect(document.body.textContent).not.toContain("senders get a bounce");
  });

  it("says mail is rejected while receiving is set up but not switched on", async () => {
    /* `verified` is the state that looks finished and is not: ownership is
       proven, delivery is still off. */
    await render(entry({ receiving: { id: "r-1", status: "verified" } }));

    expect(container.textContent).toContain("Not accepting");
    expect(container.textContent).toContain("still rejected");
  });
});
