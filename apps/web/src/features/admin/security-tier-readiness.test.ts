// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminPlatformConfigQueryKey,
  adminPluginCatalogQueryKey,
  backendStatusToCheckStatus,
  formatRequirementFields,
  prefetchAdminReadinessQueries,
  readinessCheckFromBackend,
  SecurityTierReadiness,
  serviceFromBackendRequirement,
  tierGatesForTier,
  type PlatformConfigPatch,
} from "./security-tier-readiness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("SecurityTierReadiness admin UI", () => {
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
    confirmMock = vi.fn(() => true);
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

  it("PATCHes the selected security tier shape and reflects success state without native dialogs", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (input === "/api/tools/plugin.list") {
        return Promise.resolve(Response.json(pluginCatalog()));
      }
      if (input === "/api/admin/platform-config" && init?.method === "PATCH") {
        return Promise.resolve(Response.json(platformStatus("enterprise", true)));
      }
      return Promise.resolve(Response.json(platformStatus("business", true)));
    });

    renderAdminUI();
    await waitForText("Live platform config connected");
    await clickButton("Enterprise");
    await clickButton("Apply tier draft");
    await clickDialogButton("Apply Enterprise");

    await waitFor(() => expect(platformPatchCall()).toBeDefined());
    expect(platformPatchCall()?.[0]).toBe("/api/admin/platform-config");
    expect(platformPatchCall()?.[1]?.method).toBe("PATCH");
    expect(platformPatchCall()?.[1]?.headers).toEqual({ "content-type": "application/json" });

    const payload = requestBodyForCall<PlatformConfigPatch>(platformPatchCall());
    expect(payload).toEqual({ security: { tier: "enterprise" } });
    await waitForText("Enterprise platform state");
    expect(container.textContent).toContain("Live tierEnterprise");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("shows the mutation error state without browser-native alert, confirm, or prompt", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (input === "/api/tools/plugin.list") {
        return Promise.resolve(Response.json(pluginCatalog()));
      }
      if (input === "/api/admin/platform-config" && init?.method === "PATCH") {
        return Promise.resolve(Response.json({ error: "denied" }, { status: 403 }));
      }
      return Promise.resolve(Response.json(platformStatus("business", true)));
    });

    renderAdminUI();
    await waitForText("Live platform config connected");
    await clickButton("Enterprise");
    await clickButton("Apply tier draft");
    await clickDialogButton("Apply Enterprise");

    await waitForText("Could not apply the tier draft.");
    expect(requestBodyForCall<PlatformConfigPatch>(platformPatchCall())).toEqual({
      security: { tier: "enterprise" },
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not apply the tier draft.",
    );
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("optimistically updates the tier cache and rolls back when the patch fails", async () => {
    const patchResponse = deferred<Response>();
    fetchMock.mockImplementation((input, init) => {
      if (input === "/api/tools/plugin.list") {
        return Promise.resolve(Response.json(pluginCatalog()));
      }
      if (input === "/api/admin/platform-config" && init?.method === "PATCH") {
        return patchResponse.promise;
      }
      return Promise.resolve(Response.json(platformStatus("business", true)));
    });

    renderAdminUI();
    await waitForText("Live platform config connected");
    await clickButton("Enterprise");
    await clickButton("Apply tier draft");
    await clickDialogButton("Apply Enterprise");

    await waitFor(() => {
      expect(platformPatchCall()).toBeDefined();
      expect(platformConfigCache()?.config.security.tier).toBe("enterprise");
    });

    patchResponse.resolve(Response.json({ error: "denied" }, { status: 403 }));

    await waitForText("Could not apply the tier draft.");
    expect(platformConfigCache()?.config.security.tier).toBe("business");
    expect(container.textContent).toContain("Live tierBusiness");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  /* Applying a tier the platform cannot meet is a configuration change made
   * against failing gates. It stays reachable — staging a tier before every
   * gate closes is legitimate — but it confirms, and the confirmation has to
   * name the gates that are actually blocking rather than warn in general. */
  it("confirms an apply that runs against blocking gates, naming the tier and the gates", async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          input === "/api/tools/plugin.list"
            ? pluginCatalog()
            : // Blockers the PLATFORM reported for the tier it is running —
              // the only kind that may be counted.
              enterpriseStatusWithBlockingGates(),
        ),
      ),
    );

    renderAdminUI();
    await waitForText("Live platform config connected");
    await waitForText("2 blocking");
    await clickButton("Apply tier draft");

    // One click must not have changed the platform's tier.
    expect(platformPatchCall()).toBeUndefined();

    expect(confirmDialog().textContent).toContain("Apply Enterprise tier");
    // The real gate titles from the rendered checks, not a generic warning.
    expect(blastRadiusText()).toBe(
      "2 readiness gates block Enterprise: Audit destinations, HA Postgres. Applying the tier does not clear them.",
    );
    expect(blastRadiusText()).not.toContain("cannot be undone");

    await clickDialogButton("Cancel");
    await waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    // The modal blanks body pointer events while open; failing to restore them
    // on dismiss leaves the whole console unclickable.
    expect(document.body.style.pointerEvents).not.toBe("none");
    expect(platformPatchCall()).toBeUndefined();
    expect(container.textContent).toContain("Live tierEnterprise");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  /* The dominance of the control tracks the score: it is the card's primary
   * action only while the platform can actually meet the selected tier. */
  it("de-emphasises the apply control while the tier is blocked, and keeps it enabled", async () => {
    let blocked = false;
    fetchMock.mockImplementation((input) => {
      if (input === "/api/tools/plugin.list") {
        return Promise.resolve(Response.json(pluginCatalog()));
      }
      return Promise.resolve(
        Response.json(
          blocked ? enterpriseStatusWithBlockingGates() : platformStatus("business", true),
        ),
      );
    });

    renderAdminUI();
    await waitForText("Live platform config connected");

    // Business is the live tier and nothing blocks it: primary, no caveat.
    const metApply = buttonByText("Apply tier draft");
    expect(metApply.className).not.toContain("helix-button-secondary");
    expect(container.textContent).not.toContain("asks you to confirm first");

    blocked = true;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: adminPlatformConfigQueryKey });
    });
    await waitForText("2 blocking");

    const blockedApply = buttonByText("Apply tier draft");
    expect(blockedApply.className).toContain("helix-button-secondary");
    // The caveat is announced with the control, not just placed near it.
    expect(blockedApply.getAttribute("aria-describedby")).toBe("apply-tier-note");
    expect(container.querySelector("#apply-tier-note")?.textContent).toContain(
      "2 readiness gates block Enterprise",
    );
    // Disabling with no escape would be wrong: an operator may legitimately
    // apply a tier before every gate passes.
    expect(blockedApply.disabled).toBe(false);
    expect(container.textContent).toContain(
      "2 readiness gates block Enterprise. Applying it asks you to confirm first.",
    );
  });

  /* A tier whose readiness cannot be scored is a third state. Reading it as
   * "no blocking gates" is the same error as the old 100%-for-no-data score,
   * so it must confirm — and say that nothing verified the platform. */
  it("confirms an unscoreable apply instead of treating unknown readiness as no blockers", async () => {
    let configFails = false;
    fetchMock.mockImplementation((input) => {
      if (input === "/api/tools/plugin.list") {
        return Promise.resolve(Response.json(pluginCatalog()));
      }
      return Promise.resolve(
        configFails
          ? Response.json({ error: "forbidden" }, { status: 403 })
          : Response.json(platformStatus("business", true)),
      );
    });

    renderAdminUI();
    await waitForText("Live platform config connected");
    expect(buttonByText("Apply tier draft").className).not.toContain("helix-button-secondary");

    // The score goes unknown while the last-known config is still in cache, so
    // the control stays enabled — the state the "0 blocking" reading hides.
    configFails = true;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: adminPlatformConfigQueryKey });
    });
    await waitForText("readiness unknown");

    const apply = buttonByText("Apply tier draft");
    expect(apply.disabled).toBe(false);
    expect(apply.className).toContain("helix-button-secondary");
    expect(container.textContent).toContain(
      "Readiness for Business could not be scored. Applying it asks you to confirm first.",
    );

    await clickButton("Apply tier draft");
    expect(platformPatchCall()).toBeUndefined();
    expect(confirmDialog().textContent).toContain("Apply Business tier");
    expect(blastRadiusText()).toContain("could not be scored");
    expect(blastRadiusText()).not.toContain("0 readiness gates");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  /* Selecting a target tier is the entire point of this screen, and the
   * platform measures readiness only for the tier it is RUNNING. The gate list
   * used to fall back to the static catalogue's guesses for every other tier —
   * rendered identically to measured gates, with green "Ready" chips, a
   * percentage and a blocking count for a platform nobody had evaluated. */
  it("shows a target tier's gates as unevaluated expectations, never as measured statuses", async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          input === "/api/tools/plugin.list" ? pluginCatalog() : platformStatus("business", true),
        ),
      ),
    );

    renderAdminUI();
    await waitForText("Live platform config connected");
    await clickButton("Enterprise");
    await waitForText("not evaluated");

    // No score, and no bar: both would be claims about an unmeasured platform.
    const score = container.querySelector(".admin-tier-score");
    expect(score?.getAttribute("data-unknown")).toBe("");
    expect(score?.querySelector("strong")?.textContent).toBe("—");
    expect(score?.getAttribute("aria-label")).toContain("not evaluated");
    expect(container.querySelector(".admin-tier-progress")).toBeNull();
    expect(container.textContent).not.toContain("100%");
    expect(container.textContent).not.toContain("0 blocking");

    // The requirements are still shown — the catalogue does know what the tier
    // wants — but every row reads as unknown, with no measured-looking chip.
    const gateGroup = container.querySelector('[role="group"][aria-label*="not evaluated"]');
    expect(gateGroup).not.toBeNull();
    const gateRows = [...(gateGroup?.querySelectorAll(".admin-check-row") ?? [])];
    expect(gateRows.length).toBeGreaterThan(0);
    for (const row of gateRows) {
      expect(row.getAttribute("data-status")).toBe("unknown");
      expect(["Not evaluated", "Not required at this tier"]).toContain(
        row.querySelector("span:last-of-type")?.textContent,
      );
      // Expected/observed evidence exists only where something observed.
      expect(row.querySelector(".admin-requirement-facts")).toBeNull();
    }
    expect(gateGroup?.textContent).toContain("Enterprise is not the tier this platform runs");
    expect(gateGroup?.textContent).toContain("HA Postgres");

    // A third state, not "the backend is down".
    expect(container.textContent).toContain("Not evaluated for Enterprise");
    expect(container.textContent).not.toContain("Backend unavailable");
    expect(container.textContent).toContain("Live gates only for Business");
  });

  /* A fabricated "0 blocking" would have made this a one-click apply. */
  it("confirms an apply to a tier the platform has not evaluated", async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          input === "/api/tools/plugin.list" ? pluginCatalog() : platformStatus("business", true),
        ),
      ),
    );

    renderAdminUI();
    await waitForText("Live platform config connected");
    await clickButton("Enterprise");
    await waitForText("not evaluated");

    const apply = buttonByText("Apply tier draft");
    expect(apply.disabled).toBe(false);
    expect(apply.className).toContain("helix-button-secondary");
    expect(container.querySelector("#apply-tier-note")?.textContent).toBe(
      "Enterprise has not been evaluated on this platform — it reports gates only for Business. Applying it asks you to confirm first.",
    );

    await clickButton("Apply tier draft");
    expect(platformPatchCall()).toBeUndefined();
    expect(confirmDialog().textContent).toContain("Apply Enterprise tier");
    // Distinct from the config-outage wording: the backend is fine, it simply
    // has not measured this tier.
    expect(blastRadiusText()).toContain("Nothing has evaluated this platform against Enterprise");
    expect(blastRadiusText()).not.toContain("could not be scored");
    expect(blastRadiusText()).not.toContain("0 readiness gates");

    await clickDialogButton("Apply Enterprise");
    await waitFor(() => expect(platformPatchCall()).toBeDefined());
    expect(requestBodyForCall<PlatformConfigPatch>(platformPatchCall())).toEqual({
      security: { tier: "enterprise" },
    });
  });

  /* The other half of the policy: a tier the platform already meets is one
   * click. Confirming everything is how operators learn to click through. */
  it("applies a tier with no blocking gates in one click", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (input === "/api/tools/plugin.list") {
        return Promise.resolve(Response.json(pluginCatalog()));
      }
      if (input === "/api/admin/platform-config" && init?.method === "PATCH") {
        return Promise.resolve(Response.json(platformStatus("business", true)));
      }
      return Promise.resolve(Response.json(platformStatus("business", true)));
    });

    renderAdminUI();
    await waitForText("Live platform config connected");
    await clickButton("Apply tier draft");

    await waitFor(() => expect(platformPatchCall()).toBeDefined());
    expect(requestBodyForCall<PlatformConfigPatch>(platformPatchCall())).toEqual({
      security: { tier: "business" },
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  /* "Nothing was measured" and "everything measured is satisfied" produce the
   * same arithmetic — zero over zero — and only the second one is 100%. */
  it("refuses to score a live tier with no reported gates, but scores one whose gates are all not required", async () => {
    let gateReported = false;
    fetchMock.mockImplementation((input) => {
      if (input === "/api/tools/plugin.list") {
        return Promise.resolve(Response.json(pluginCatalog()));
      }
      return Promise.resolve(
        Response.json(
          gateReported ? personalStatusWithNotRequiredGate() : personalStatusWithNoGates(),
        ),
      );
    });

    renderAdminUI();
    await waitForText("Live platform config connected");
    await waitForText("readiness unknown");

    expect(container.textContent).not.toContain("100%");
    expect(container.textContent).toContain("No gates reported");
    expect(container.querySelector(".admin-tier-progress")).toBeNull();
    expect(buttonByText("Apply tier draft").className).toContain("helix-button-secondary");

    gateReported = true;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: adminPlatformConfigQueryKey });
    });

    // The platform did look, and Tier 1 asks nothing of this gate: that is 100%.
    await waitForText("100%");
    expect(container.textContent).toContain("0 blocking");
    expect(buttonByText("Apply tier draft").className).not.toContain("helix-button-secondary");
  });

  it("surfaces malformed config API responses instead of falling back to static readiness", async () => {
    fetchMock.mockResolvedValue(Response.json({}));

    renderAdminUI();

    await waitForText("Platform config response was missing required fields.");
    expect(container.textContent).toContain("Unavailable platform state");
    expect(container.textContent).toContain(
      "Readiness gates are unavailable until the admin config API returns a valid response.",
    );
    expect(container.textContent).not.toContain("Static preview");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("displays backend Vault and CloudNativePG evidence without placeholder readiness copy", async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          input === "/api/tools/plugin.list" ? pluginCatalog() : enterpriseStatusWithEvidence(),
        ),
      ),
    );

    renderAdminUI();
    await waitForText("Vault endpoint observed from runtime configuration.");
    await waitForText("CloudNativePG wiring observed from runtime configuration.");

    const renderedText = container.textContent ?? "";
    expect(renderedText).toContain("Secrets backend");
    expect(renderedText).toContain("HA Postgres");
    expect(renderedText).toContain("https://vault.internal:8200");
    expect(renderedText).toContain("postgres://helix-postgres-rw:5432/helix");
    expect(renderedText.toLowerCase()).not.toContain("placeholder");
    expect(renderedText).not.toContain("backend wiring lands");
    expect(renderedText).not.toContain("currently a placeholder");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  /* A readiness dashboard must never report a clean bill of health for a
   * platform it cannot see. With the config API down the gate list is empty,
   * and the old score divided zero ready gates by zero actionable gates to
   * print "100%" and "0 blocking" — the most dangerous possible reading. */
  it("reports readiness as unknown, not 100%, when the config API is unavailable", async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        input === "/api/tools/plugin.list"
          ? Response.json(pluginCatalog())
          : Response.json({ error: "forbidden" }, { status: 403 }),
      ),
    );

    renderAdminUI();
    await waitForText("Admin config API unavailable or unauthorized");

    expect(container.textContent).not.toContain("100%");
    expect(container.textContent).not.toContain("0 blocking");
    expect(container.textContent).toContain("readiness unknown");

    const score = container.querySelector(".admin-tier-score");
    expect(score?.getAttribute("data-unknown")).toBe("");
    expect(score?.getAttribute("aria-label")).toContain("unknown");
    // A 0%-wide progress bar would still read as "nothing is ready".
    expect(container.querySelector(".admin-tier-progress")).toBeNull();
  });

  it("does not claim AI audit or classification gating are on when nothing was reported", async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          input === "/api/tools/plugin.list"
            ? pluginCatalog()
            : // Live config, but the AI block is absent entirely.
              platformStatus("business", true),
        ),
      ),
    );

    renderAdminUI();
    await waitForText("Live platform config connected");
    await waitForText("Classification gating");

    // Previously "metadata-only" and "Enabled" — both positive security
    // findings synthesised from `undefined`.
    expect(container.textContent).toContain("Not reported");
    expect(container.textContent).not.toContain("metadata-only");
    expect(container.textContent).not.toContain("No AI privacy config reported: Enabled");
  });

  it("marks services with no live requirement as not verified rather than online", async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          input === "/api/tools/plugin.list" ? pluginCatalog() : platformStatus("business", true),
        ),
      ),
    );

    renderAdminUI();
    await waitForText("Live platform config connected");

    /* Only the four ids in `serviceRequirementKeyById` have a backend
     * requirement behind them. Every other card used to print its catalogue
     * literal — "Online", styled green — for something nothing had checked. */
    const cards = [...container.querySelectorAll(".admin-service-card")];
    expect(cards.length).toBeGreaterThan(0);
    const unverified = cards.filter((card) => card.textContent?.includes("Not verified"));
    expect(unverified.length).toBeGreaterThan(0);
    for (const card of unverified) {
      expect(card.getAttribute("data-status")).toBe("unknown");
    }
  });

  it("renders the config-API connection state as status text, not a dead button", async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          input === "/api/tools/plugin.list" ? pluginCatalog() : platformStatus("business", true),
        ),
      ),
    );

    renderAdminUI();
    await waitForText("Config API connected");

    // It was a <button> with no onClick, in the tab order, styled like the
    // Apply control beside it.
    const readout = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Config API connected"),
    );
    expect(readout).toBeUndefined();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Config API connected",
    );
  });

  it("labels the control table as reference values and resets one to the tier default", async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          input === "/api/tools/plugin.list" ? pluginCatalog() : platformStatus("business", true),
        ),
      ),
    );

    renderAdminUI();
    await waitForText("Live platform config connected");
    // These are catalogue values held in component state — nothing reads or
    // writes them on the platform — so the column must not claim to show this
    // deployment's live posture.
    await waitForText("Reference value");
    expect(container.textContent).not.toContain("Current override");
    expect(container.textContent).toContain("admins required, passkeys enabled");

    await clickButtonByLabel("Reset MFA to tier default");

    expect(container.textContent).not.toContain("admins required, passkeys enabled");
    expect(container.textContent).toContain("admins required");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("surfaces AI cost limits and audit evidence from live admin config", async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          input === "/api/tools/plugin.list"
            ? pluginCatalog()
            : platformStatus("business", true, {
                costLimits: { perUserPerDayUSD: 5, perOrgPerDayUSD: 500 },
                audit: { logRequests: "metadata-only", retainDays: 90 },
                privacy: {
                  classificationGating: true,
                  blockExternalForClassifications: ["confidential", "restricted"],
                },
              }),
        ),
      ),
    );

    renderAdminUI();
    await waitForText("Cost limits and audit evidence");
    await waitForText("Live platform config connected");
    await waitForText("$5.00");

    expect(container.textContent).toContain("User daily AI cost");
    expect(container.textContent).toContain("$5.00");
    expect(container.textContent).toContain("$10.00");
    expect(container.textContent).toContain("Org daily AI cost");
    expect(container.textContent).toContain("$500.00");
    expect(container.textContent).toContain("90 day retention");
    expect(container.textContent).toContain("Blocks Confidential, Restricted");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("renders plugin catalog headers and rows with TanStack table semantics", async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          input === "/api/tools/plugin.list" ? pluginCatalog() : platformStatus("business", true),
        ),
      ),
    );

    renderAdminUI();
    await waitForText("Community importer");

    const pluginTable = tableByLabel("Plugin catalog");
    const headers = Array.from(pluginTable.querySelectorAll('[role="columnheader"]')).map(
      (header) => header.textContent,
    );
    expect(headers).toEqual(["Plugin", "Kind", "Version", "Permissions", "Lifecycle", "Action"]);
    expect(pluginTable.textContent).toContain("Community importer");
    expect(pluginTable.textContent).toContain("com.example.community");
    expect(pluginTable.textContent).toContain("Mail auditor");
    expect(pluginTable.textContent).toContain("com.example.mail-auditor");
    expect(pluginTable.querySelectorAll('[role="row"]')).toHaveLength(3);

    await clickButton("Review");
    expect(container.textContent).toContain("mail.audit");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("blocks non-official plugin install until every permission is confirmed", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (input === "/api/tools/plugin.list") {
        return Promise.resolve(Response.json(pluginCatalog()));
      }
      if (input === "/api/tools/plugin.install" && init?.method === "POST") {
        return Promise.resolve(
          Response.json({
            status: "installed",
            source: "sideload",
            plugin: pluginCatalog().plugins[0],
            confirmations: [],
          }),
        );
      }
      return Promise.resolve(Response.json(platformStatus("business", true)));
    });

    renderAdminUI();
    await waitForText("Community importer");
    expect(tableByLabel("Plugin catalog").textContent).toContain("Community importer");
    await setSelectValue("Plugin source", "sideload");
    await waitForText("Install from a non-official source");
    expect(buttonByText("Install plugin").disabled).toBe(true);

    await clickAllPluginConfirmations();
    expect(buttonByText("Install plugin").disabled).toBe(false);
    await clickButton("Install plugin");

    await waitForText("Install validated for Community importer.");
    const installCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/tools/plugin.install",
    );
    expect(requestBodyForCall(installCall)).toMatchObject({
      pluginId: "com.example.community",
      version: "1.2.3",
      source: "sideload",
      confirmations: [
        "source.non_official",
        "permissions.scopes.drive.write",
        "permissions.outbound-network.api.example.com",
        "capabilities.provides.example.importer",
        "signature.missing",
      ],
    });
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("calls plugin lifecycle tools from the admin plugin table", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (input === "/api/tools/plugin.list") {
        return Promise.resolve(Response.json(pluginCatalog()));
      }
      if (input === "/api/tools/plugin.enable" && init?.method === "POST") {
        return Promise.resolve(
          Response.json({
            status: "enabled",
            plugin: pluginCatalog().plugins[0],
            lifecycle: { state: "enabled", installed: true },
          }),
        );
      }
      if (input === "/api/tools/plugin.disable" && init?.method === "POST") {
        return Promise.resolve(
          Response.json({
            status: "disabled",
            plugin: pluginCatalog().plugins[1],
            lifecycle: { state: "disabled", installed: true },
          }),
        );
      }
      return Promise.resolve(Response.json(platformStatus("business", true)));
    });

    renderAdminUI();
    await waitForText("Community importer");
    await waitForText("Disabled");

    await clickPluginAction("com.example.community", "Enable");
    await waitFor(() => expect(pluginLifecycleCall("enable")).toBeDefined());
    expect(requestBodyForCall(pluginLifecycleCall("enable"))).toEqual({
      pluginId: "com.example.community",
    });

    await clickPluginAction("com.example.mail-auditor", "Disable");
    await waitFor(() => expect(pluginLifecycleCall("disable")).toBeDefined());
    expect(requestBodyForCall(pluginLifecycleCall("disable"))).toEqual({
      pluginId: "com.example.mail-auditor",
    });

    // Neither reversible action drags a confirmation id along.
    const bodies = fetchMock.mock.calls.map(([, init]) =>
      typeof init?.body === "string" ? init.body : "",
    );
    expect(bodies).not.toContainEqual(expect.stringContaining("plugin.uninstall"));
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  /* The backend answers `plugin.uninstall` with the `ConfirmationRequirement`s
   * it wants acknowledged and refuses until their ids come back. This client
   * used to post `confirmations: ["plugin.uninstall"]` unconditionally —
   * answering a server-side safety gate on behalf of an operator who was never
   * asked. The id may now only reach the wire after a human ticks it. */
  it("asks the backend for its uninstall requirements instead of forging their ids", async () => {
    mockPluginUninstallBackend();

    renderAdminUI();
    await waitForText("Community importer");
    await clickPluginAction("com.example.mail-auditor", "Uninstall");

    // Opening the row action must not have called the tool at all.
    expect(pluginLifecycleCalls("uninstall")).toHaveLength(0);
    expect(confirmDialog().textContent).toContain("Uninstall Mail auditor");
    // A real consequence from the manifest, not "this cannot be undone".
    expect(blastRadiusText()).toContain("active runtime hooks");
    expect(blastRadiusText()).toContain("mail.audit");
    expect(blastRadiusText()).not.toContain("cannot be undone");

    await clickDialogButton("Uninstall Mail auditor");

    // First request carries no confirmations: the backend states them.
    await waitFor(() => expect(pluginLifecycleCalls("uninstall")).toHaveLength(1));
    expect(requestBodyForCall(pluginLifecycleCalls("uninstall")[0])).toEqual({
      pluginId: "com.example.mail-auditor",
      confirmations: [],
    });

    // The refusal is surfaced with the backend's own label and detail.
    await waitForText("Uninstall com.example.mail-auditor and remove its active runtime hooks.");
    const acknowledgement = uninstallAcknowledgementCard();
    expect(acknowledgement.textContent).toContain("Uninstall plugin");
    const uninstallCta = buttonByText("Uninstall Mail auditor");
    expect(uninstallCta.disabled).toBe(true);
    expect(uninstallCta.getAttribute("aria-describedby")).toBe("uninstall-acknowledgement-note");
    expect(container.querySelector("#uninstall-acknowledgement-note")?.textContent).toContain(
      "Tick every requirement the platform listed",
    );

    await tickUninstallAcknowledgements();
    expect(buttonByText("Uninstall Mail auditor").disabled).toBe(false);

    await clickButton("Uninstall Mail auditor");
    expect(blastRadiusText()).toContain("Uninstall plugin");
    await clickDialogButton("Uninstall Mail auditor");

    await waitFor(() => expect(pluginLifecycleCalls("uninstall")).toHaveLength(2));
    // Only now, and only because a human ticked it.
    expect(requestBodyForCall(pluginLifecycleCalls("uninstall")[1])).toEqual({
      pluginId: "com.example.mail-auditor",
      confirmations: ["plugin.uninstall"],
    });
    await waitForText("Uninstalled Mail auditor.");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  /* Dismissing the confirmation must leave the platform untouched — and the
   * unacknowledged requirement must not be sent by the retry either. */
  it("sends nothing when the uninstall confirmation is cancelled", async () => {
    mockPluginUninstallBackend();

    renderAdminUI();
    await waitForText("Community importer");
    await clickPluginAction("com.example.mail-auditor", "Uninstall");
    await clickDialogButton("Cancel");

    await waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    expect(pluginLifecycleCalls("uninstall")).toHaveLength(0);
    expect(document.body.style.pointerEvents).not.toBe("none");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("optimistically marks plugin install cache and rolls back when validation fails", async () => {
    const installResponse = deferred<Response>();
    fetchMock.mockImplementation((input, init) => {
      if (input === "/api/tools/plugin.list") {
        return Promise.resolve(Response.json(pluginCatalog()));
      }
      if (input === "/api/tools/plugin.install" && init?.method === "POST") {
        return installResponse.promise;
      }
      return Promise.resolve(Response.json(platformStatus("business", true)));
    });

    renderAdminUI();
    await waitForText("Community importer");
    await setSelectValue("Plugin source", "sideload");
    await clickAllPluginConfirmations();
    await clickButton("Install plugin");

    await waitFor(() => {
      expect(pluginInstallCall()).toBeDefined();
      expect(communityPluginCache()?.install).toMatchObject({
        optimisticStatus: "installing",
        source: "sideload",
      });
    });

    installResponse.resolve(Response.json({ error: "denied" }, { status: 403 }));

    await waitForText("Could not validate the plugin install request.");
    expect(pluginCatalogCache()).toEqual(pluginCatalog());
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  function renderAdminUI() {
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(SecurityTierReadiness),
        ),
      );
    });
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

  // The confirmation is portaled to document.body, outside the section root.
  function confirmDialog(): HTMLElement {
    const dialog = document.querySelector('[role="alertdialog"]');
    if (!(dialog instanceof HTMLElement)) {
      throw new Error("Confirmation dialog not found.");
    }
    return dialog;
  }

  function blastRadiusText(): string {
    return confirmDialog().querySelector(".admin-confirm-blast")?.textContent ?? "";
  }

  async function clickDialogButton(label: string) {
    const button = Array.from(confirmDialog().querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (button === undefined) {
      throw new Error(`Dialog button not found: ${label}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function tableByLabel(label: string): HTMLElement {
    const table = container.querySelector(`[role="table"][aria-label="${label}"]`);
    if (!(table instanceof HTMLElement)) {
      throw new Error(`Table not found: ${label}`);
    }
    return table;
  }

  async function clickButtonByLabel(label: string) {
    const button = container.querySelector(`button[aria-label="${label}"]`);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Button not found: ${label}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function clickPluginAction(pluginId: string, action: string) {
    const row = Array.from(tableByLabel("Plugin catalog").querySelectorAll('[role="row"]')).find(
      (candidate) => candidate.textContent?.includes(pluginId),
    );
    const button = Array.from(row?.querySelectorAll("button") ?? []).find((candidate) =>
      candidate.textContent?.includes(action),
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Plugin action not found: ${pluginId} ${action}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function setSelectValue(label: string, value: string) {
    const select = container.querySelector(`select[aria-label="${label}"]`);
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error(`Select not found: ${label}`);
    }
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")
        ?.set as ((this: HTMLSelectElement, value: string) => void) | undefined;
      if (valueSetter !== undefined) {
        Reflect.apply(valueSetter, select, [value]);
      }
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  /* Mirrors apps/helix/src/platform/plugins/tools.ts: `plugin.uninstall`
     refuses with its `ConfirmationRequirement`s until their ids come back. */
  function mockPluginUninstallBackend() {
    fetchMock.mockImplementation((input, init) => {
      if (input === "/api/tools/plugin.list") {
        return Promise.resolve(Response.json(pluginCatalog()));
      }
      if (input === "/api/tools/plugin.uninstall" && init?.method === "POST") {
        const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as {
          readonly confirmations?: string[];
        };
        if (!(body.confirmations ?? []).includes("plugin.uninstall")) {
          return Promise.resolve(
            Response.json({
              status: "blocked_confirmation_required",
              plugin: pluginCatalog().plugins[1],
              confirmations: [
                {
                  id: "plugin.uninstall",
                  label: "Uninstall plugin",
                  category: "capability",
                  detail: "Uninstall com.example.mail-auditor and remove its active runtime hooks.",
                },
              ],
            }),
          );
        }
        return Promise.resolve(
          Response.json({
            status: "uninstalled",
            plugin: pluginCatalog().plugins[1],
            lifecycle: { state: "uninstalled", installed: false },
          }),
        );
      }
      return Promise.resolve(Response.json(platformStatus("business", true)));
    });
  }

  function uninstallAcknowledgementCard(): HTMLElement {
    const card = container.querySelector('.admin-plugin-card[data-status="warning"]');
    if (!(card instanceof HTMLElement)) {
      throw new Error("Uninstall acknowledgement card not found.");
    }
    return card;
  }

  async function tickUninstallAcknowledgements() {
    const checkboxes = [
      ...uninstallAcknowledgementCard().querySelectorAll("input[type='checkbox']"),
    ];
    if (checkboxes.length === 0) {
      throw new Error("Uninstall acknowledgement checkboxes not found.");
    }
    for (const checkbox of checkboxes) {
      act(() => {
        checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  async function clickAllPluginConfirmations() {
    const checkboxes = Array.from(
      container.querySelectorAll(".admin-plugin-confirmations input[type='checkbox']"),
    );
    if (checkboxes.length === 0) {
      throw new Error("Plugin confirmation checkboxes not found.");
    }
    for (const checkbox of checkboxes) {
      if (!(checkbox instanceof HTMLInputElement)) {
        continue;
      }
      act(() => {
        checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await act(async () => {
        await Promise.resolve();
      });
    }
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

  function platformConfigCache() {
    return queryClient.getQueryData<ReturnType<typeof platformStatus>>(adminPlatformConfigQueryKey);
  }

  function pluginCatalogCache() {
    return queryClient.getQueryData<ReturnType<typeof pluginCatalog>>(adminPluginCatalogQueryKey);
  }

  function communityPluginCache() {
    return pluginCatalogCache()?.plugins.find((plugin) => plugin.id === "com.example.community");
  }
});

describe("admin security tier readiness helpers", () => {
  it("prefetches route data for platform config and plugin catalog with contained errors", async () => {
    const ensureQueryData = vi
      .fn<(options: { readonly queryKey: readonly unknown[] }) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("platform config unavailable"))
      .mockResolvedValueOnce({ plugins: [] });

    await expect(prefetchAdminReadinessQueries({ ensureQueryData })).resolves.toBeUndefined();

    expect(ensureQueryData).toHaveBeenCalledTimes(2);
    expect(ensureQueryData.mock.calls.map(([options]) => options.queryKey)).toEqual([
      adminPlatformConfigQueryKey,
      adminPluginCatalogQueryKey,
    ]);
  });

  it("formats backend expected and observed requirement fields for display", () => {
    const check = readinessCheckFromBackend({
      key: "auditDestinations",
      label: "Audit destinations",
      required: true,
      status: "missing",
      expected: { destinations: ["postgres", "immutable-s3", "siem"] },
      observed: { destinations: ["postgres"], status: "missing" },
      missing: ["immutable-s3", "siem"],
    });

    expect(check.status).toBe("blocked");
    expect(check.expectedFields).toContainEqual({
      label: "Destinations",
      value: "Postgres, Immutable S3, SIEM",
    });
    expect(check.observedFields).toContainEqual({
      label: "Status",
      value: "Missing",
    });
    expect(check.missing).toEqual(["immutable-s3", "siem"]);
  });

  /* The catalogue's `statusByTier` is a hand-written guess about some
   * hypothetical deployment. This assertion used to require that guess to be
   * returned as `status` for a gate the backend never reported ("blocked" for
   * audit-destinations) — the assertion encoded the fabrication, so it is the
   * assertion that was wrong. An unreported gate is now an expectation with no
   * status at all. */
  it("overlays backend readiness evidence and leaves unreported gates unevaluated", () => {
    const gates = tierGatesForTier("enterprise", [
      {
        key: "vault",
        label: "Vault",
        required: true,
        status: "ready",
        expected: { running: true },
        observed: {
          enabled: true,
          endpoint: "https://vault.internal:8200",
          evidence: "Vault endpoint observed from runtime configuration.",
        },
      },
      {
        key: "cloudNativePg",
        label: "CloudNativePG",
        required: true,
        status: "ready",
        expected: { running: true },
        observed: {
          enabled: true,
          endpoint: "postgres://helix-postgres-rw:5432/helix",
          evidence: "CloudNativePG wiring observed from runtime configuration.",
        },
      },
    ]);

    expect(gates.measured.find((check) => check.id === "secrets-backend")).toMatchObject({
      detail: "Vault endpoint observed from runtime configuration.",
      status: "ready",
    });
    expect(gates.measured.find((check) => check.id === "ha-postgres")).toMatchObject({
      detail: "CloudNativePG wiring observed from runtime configuration.",
      status: "ready",
    });
    // Nothing reported it, so it carries no status anywhere.
    expect(gates.measured.map((check) => check.id)).not.toContain("audit-destinations");
    expect(gates.unevaluated.find((gate) => gate.id === "audit-destinations")).toEqual({
      id: "audit-destinations",
      title: "Audit destinations",
      detail:
        "Postgres audit is local; higher tiers require immutable object storage, SIEM, or WORM destinations.",
      requiredByTier: true,
    });
  });

  /* The platform reports readiness for the tier it RUNS. Asked about any other
   * tier it has measured nothing, so there is nothing to project a status
   * from — the catalogue only knows which gates the tier wants. */
  it("returns every gate as an unevaluated expectation when the platform measured nothing", () => {
    const gates = tierGatesForTier("business", undefined);

    expect(gates.measured).toEqual([]);
    expect(gates.unevaluated.length).toBeGreaterThan(0);
    // `requiredByTier` describes the TIER definition, never this deployment.
    expect(gates.unevaluated.find((gate) => gate.id === "backup-encryption")).toMatchObject({
      requiredByTier: true,
    });
    expect(gates.unevaluated.find((gate) => gate.id === "workload-identity")).toMatchObject({
      requiredByTier: false,
    });
    // No status field to mistake for a measurement.
    for (const gate of gates.unevaluated) {
      expect(gate).not.toHaveProperty("status");
      expect(gate).not.toHaveProperty("statusByTier");
    }
  });

  it("maps backend requirement states to UI status buckets", () => {
    expect(backendStatusToCheckStatus("ready")).toBe("ready");
    expect(backendStatusToCheckStatus("not_required")).toBe("not-required");
    expect(backendStatusToCheckStatus("missing")).toBe("blocked");
    expect(backendStatusToCheckStatus("unknown")).toBe("warning");
    expect(backendStatusToCheckStatus("degraded")).toBe("warning");
  });

  it("projects backend service gates onto service cards", () => {
    const service = serviceFromBackendRequirement(
      {
        id: "vault",
        name: "HashiCorp Vault",
        description: "Mandatory Tier 3+ secrets backend and rotation source",
        icon: (() => null) as never,
        status: "pending",
      },
      {
        key: "vault",
        label: "Vault",
        required: true,
        status: "missing",
        expected: { running: true },
        observed: { enabled: false, status: "missing" },
      },
    );

    expect(service.status).toBe("missing");
    expect(service.backendStatus).toBe("missing");
  });

  it("formats primitive backend field values without raw JSON for common shapes", () => {
    expect(
      formatRequirementFields({
        successfulBackupRequired: true,
        lastSuccessfulBackupAt: "2026-05-20T12:00:00Z",
      }),
    ).toEqual([
      { label: "Successful Backup Required", value: "Yes" },
      { label: "Last Successful Backup At", value: "2026-05-20T12:00:00Z" },
    ]);
  });
});

function requestBodyForCall<T = unknown>(call: Parameters<typeof fetch> | undefined): T {
  const body = call?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("Expected string request body.");
  }
  return JSON.parse(body) as T;
}

function platformPatchCall(): Parameters<typeof fetch> | undefined {
  return (globalThis.fetch as unknown as ReturnType<typeof vi.fn<typeof fetch>>).mock.calls.find(
    (call) => call[0] === "/api/admin/platform-config" && call[1]?.method === "PATCH",
  );
}

function pluginInstallCall(): Parameters<typeof fetch> | undefined {
  return (globalThis.fetch as unknown as ReturnType<typeof vi.fn<typeof fetch>>).mock.calls.find(
    (call) => call[0] === "/api/tools/plugin.install" && call[1]?.method === "POST",
  );
}

function pluginLifecycleCall(
  action: "enable" | "disable" | "uninstall",
): Parameters<typeof fetch> | undefined {
  return pluginLifecycleCalls(action)[0];
}

/** Every call to one lifecycle tool, in order: uninstall is now a conversation
 *  (ask, get refused with requirements, resend what was acknowledged), so the
 *  first request and the last one have to be inspected separately. */
function pluginLifecycleCalls(
  action: "enable" | "disable" | "uninstall",
): Parameters<typeof fetch>[] {
  return (globalThis.fetch as unknown as ReturnType<typeof vi.fn<typeof fetch>>).mock.calls.filter(
    (call) => call[0] === `/api/tools/plugin.${action}` && call[1]?.method === "POST",
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function platformStatus(
  tier: PlatformConfigPatch["security"]["tier"],
  ready: boolean,
  ai?: {
    costLimits?: {
      perUserPerDayUSD?: number;
      perOrgPerDayUSD?: number;
      perAgentPerDayUSD?: number;
    };
    audit?: { logRequests?: "off" | "metadata-only" | "full"; retainDays?: number };
    privacy?: {
      classificationGating?: boolean;
      blockExternalForClassifications?: readonly string[];
    };
  },
) {
  return {
    config: {
      security: { tier },
      ...(ai === undefined ? {} : { ai }),
    },
    readiness: {
      ready,
      requirements: [
        {
          key: "auditDestinations",
          label: "Audit destinations",
          required: tier !== "personal",
          status: "ready",
          expected: { destinations: ["postgres", "immutable-s3"] },
          observed: { destinations: ["postgres", "immutable-s3"] },
        },
      ],
    },
  };
}

/** A live platform that reported no readiness gates at all. */
function personalStatusWithNoGates() {
  return {
    config: { security: { tier: "personal" } },
    readiness: { ready: true, requirements: [] },
  };
}

/** A live platform that measured its one gate and found the tier does not
 *  require it — a real, scoreable result, unlike the empty list above. */
function personalStatusWithNotRequiredGate() {
  return {
    config: { security: { tier: "personal" } },
    readiness: {
      ready: true,
      requirements: [
        {
          key: "auditDestinations",
          label: "Audit destinations",
          required: false,
          status: "not_required",
          expected: {},
          observed: {},
        },
      ],
    },
  };
}

/* A live Enterprise platform reporting two of its own gates as missing. The
   blockers on screen must come from here — the tier engine's own measurement —
   never from the console's static catalogue. */
function enterpriseStatusWithBlockingGates() {
  return {
    config: {
      security: { tier: "enterprise" },
    },
    readiness: {
      ready: false,
      requirements: [
        {
          key: "auditDestinations",
          label: "Audit destinations",
          required: true,
          status: "missing",
          expected: { destinations: ["postgres", "immutable-s3", "siem"] },
          observed: { destinations: ["postgres"] },
          missing: ["immutable-s3", "siem"],
        },
        {
          key: "vault",
          label: "Vault",
          required: true,
          status: "ready",
          expected: { running: true },
          observed: { enabled: true, endpoint: "https://vault.internal:8200" },
        },
        {
          key: "cloudNativePg",
          label: "CloudNativePG",
          required: true,
          status: "missing",
          expected: { running: true },
          observed: { enabled: false },
        },
      ],
    },
  };
}

function enterpriseStatusWithEvidence() {
  return {
    config: {
      security: { tier: "enterprise" },
    },
    readiness: {
      ready: true,
      requirements: [
        {
          key: "auditDestinations",
          label: "Audit destinations",
          required: true,
          status: "ready",
          expected: { destinations: ["postgres", "immutable-s3", "siem"] },
          observed: { destinations: ["postgres", "immutable-s3", "siem"] },
        },
        {
          key: "vault",
          label: "Vault",
          required: true,
          status: "ready",
          expected: { running: true },
          observed: {
            enabled: true,
            endpoint: "https://vault.internal:8200",
            evidence: "Vault endpoint observed from runtime configuration.",
            status: "ready",
          },
        },
        {
          key: "siem",
          label: "SIEM",
          required: true,
          status: "ready",
          expected: { running: true },
          observed: {
            enabled: true,
            endpoint: "https://siem.internal/ingest",
            evidence: "SIEM endpoint observed from runtime configuration with CEF format.",
            status: "ready",
          },
        },
        {
          key: "cloudNativePg",
          label: "CloudNativePG",
          required: true,
          status: "ready",
          expected: { running: true },
          observed: {
            enabled: true,
            endpoint: "postgres://helix-postgres-rw:5432/helix",
            evidence: "CloudNativePG wiring observed from runtime configuration.",
            status: "ready",
          },
        },
      ],
    },
  };
}

function pluginCatalog() {
  return {
    plugins: [
      {
        id: "com.example.community",
        name: "Community importer",
        version: "1.2.3",
        kind: "in-process",
        capabilities: {
          provides: ["example.importer"],
          consumes: [],
        },
        permissions: {
          scopes: ["drive.write"],
          "outbound-network": ["api.example.com"],
          filesystem: [],
          envVars: [],
        },
        install: null,
        lifecycle: {
          state: "disabled",
          installed: true,
        },
        signature: null,
        tierRequirements: null,
      },
      {
        id: "com.example.mail-auditor",
        name: "Mail auditor",
        version: "0.9.0",
        kind: "in-process",
        capabilities: {
          provides: ["mail.audit"],
          consumes: ["mail.message"],
        },
        permissions: {
          scopes: ["mail.read"],
          "outbound-network": [],
          filesystem: [],
          envVars: [],
        },
        install: null,
        lifecycle: {
          state: "enabled",
          installed: true,
        },
        signature: { verified: true },
        tierRequirements: null,
      },
    ],
  };
}
