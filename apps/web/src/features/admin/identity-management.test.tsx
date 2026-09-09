// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityManagement } from "./identity-management";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const oidc = {
  id: "idp-1",
  orgId: "org-1",
  protocol: "oidc",
  isPrimary: true,
  displayName: "Acme OIDC",
  config: { issuer: "https://idp.example.com", clientId: "helix" },
  signingCertSecretHandle: "oidc-private-key",
  attrMapping: { email: "$.email" },
  jitProvisioning: false,
  enabled: true,
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
};
const identity = {
  idpConfigs: [oidc],
  localLoginRecovery: { enabled: true, scope: "owner_admin_recovery" },
};

describe("IdentityManagement", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(identity));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows OIDC and local break-glass without SAML or inert JIT controls", async () => {
    await render();
    await waitFor(() => expect(container.textContent).toContain("Acme OIDC"));
    expect(container.textContent).toContain("Owner/admin recovery path");
    expect(container.textContent).toContain("OpenID Connect (OIDC)");
    expect(container.textContent).not.toContain("SAML");
    expect(container.textContent).not.toContain("JIT provisioning");
  });

  it("creates the minimal private-key OIDC configuration", async () => {
    fetchMock.mockImplementation((_input, init) =>
      init?.method === "POST"
        ? Promise.resolve(
            Response.json({ idpConfig: oidc, localLoginRecovery: identity.localLoginRecovery }),
          )
        : Promise.resolve(Response.json(identity)),
    );
    await render();
    await waitFor(() => expect(input("IdP display name").value).toBe(""));
    await act(async () => {
      change(input("IdP display name"), "Acme OIDC");
      change(input("OIDC issuer URL"), "https://idp.example.com");
      change(input("OIDC client ID"), "helix");
      change(input("OIDC private-key secret handle"), "oidc-private-key");
      button("Add IdP").click();
    });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
        protocol: "oidc",
        config: { issuer: "https://idp.example.com", clientId: "helix" },
        signingCertSecretHandle: "oidc-private-key",
        jitProvisioning: false,
      });
    });
  });

  it("reports the production OIDC runtime as ready", async () => {
    fetchMock.mockImplementation((request) =>
      requestUrl(request).endsWith("/test-login")
        ? Promise.resolve(
            Response.json({
              testLogin: { status: "ready", message: "OIDC callback validation is ready." },
              localLoginRecovery: identity.localLoginRecovery,
            }),
          )
        : Promise.resolve(Response.json(identity)),
    );
    await render();
    await waitFor(() => expect(container.textContent).toContain("Acme OIDC"));
    await act(async () => button("Test login").click());
    await waitFor(() =>
      expect(container.textContent).toContain("OIDC callback validation is ready."),
    );
  });

  async function render(): Promise<void> {
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(IdentityManagement),
        ),
      );
    });
  }

  function input(label: string): HTMLInputElement {
    const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (field === null) throw new Error(`Input ${label} not found.`);
    return field;
  }

  function button(label: string): HTMLButtonElement {
    const match = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes(label),
    );
    if (match === undefined) throw new Error(`Button ${label} not found.`);
    return match;
  }
});

function change(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
  }
  throw lastError;
}
