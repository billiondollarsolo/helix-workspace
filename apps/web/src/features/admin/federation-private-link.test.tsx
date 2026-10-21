// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonNamed, control, typeInto } from "@/features/mail/settings/test-support";
import { axeViolations, mount, settle, unmountAll } from "@/test/ui";
import type { FederationApplication } from "./federation-applications-api";
import { FederationPrivateLink } from "./federation-private-link";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

type Connection = NonNullable<FederationApplication["connection"]>;
const application = (
  connection: Partial<Connection> = {},
): FederationApplication & { connection: Connection } => ({
  id: "11111111-1111-4111-8111-111111111111",
  origin: "https://agentspace.example",
  status: "active",
  installationId: "installation",
  tenantId: "team",
  lastSyncedAt: null,
  error: null,
  pending: false,
  rotationPending: false,
  connection: {
    path: "public",
    target: null,
    source: null,
    checkedAt: null,
    error: null,
    ...connection,
  },
});

function render(app: ReturnType<typeof application>) {
  return mount(
    <QueryClientProvider client={new QueryClient()}>
      <FederationPrivateLink application={app} connection={app.connection} />
    </QueryClientProvider>,
  );
}

describe("Connection path", () => {
  it("shows an automatically found private link", async () => {
    const view = render(
      application({ path: "private", target: "helix-agentspace:3000", source: "discovered" }),
    );
    await settle();
    expect(view.container.textContent).toContain("Private network");
    expect(view.container.textContent).toContain("helix-agentspace:3000");
    expect(view.container.textContent).toContain("Found automatically");
    expect(await axeViolations(view.container)).toEqual([]);
  });

  it("guides setup and tests the address before saving", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json(application({ path: "private", target: "10.0.0.5:3000", source: "manual" })),
      );
    const view = render(application());
    await settle();
    expect(view.container.textContent).toContain("Public internet");
    act(() => {
      buttonNamed("Set up a private link", view.container)?.click();
    });
    act(() => {
      control<HTMLInputElement>("Same cloud network", view.container)?.click();
    });
    expect(view.container.textContent).toContain("private network");
    typeInto(control("Private address (host:port)", view.container), "10.0.0.5:3000");
    act(() => {
      buttonNamed("Test and save", view.container)?.click();
    });
    await settle();
    expect(fetch).toHaveBeenLastCalledWith(
      expect.stringContaining("/private-link"),
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ target: "10.0.0.5:3000" }) }),
    );
  });

  it("hides the controls when the operator configured the route", async () => {
    const view = render(
      application({ path: "private", target: "10.0.0.5:3000", source: "configured" }),
    );
    await settle();
    expect(view.container.textContent).toContain("Set by your operator");
    expect(buttonNamed("Set up a private link", view.container)).toBeNull();
  });
});
