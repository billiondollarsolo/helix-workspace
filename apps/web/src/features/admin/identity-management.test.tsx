// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityManagement } from "./identity-management";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const identityPayload = {
  idpConfigs: [
    {
      id: "idp-1",
      orgId: "org-1",
      protocol: "saml",
      isPrimary: true,
      displayName: "Acme Okta",
      config: { metadataUrl: "https://idp.example.com/metadata" },
      signingCertVaultPath: "tenants/org-1/idp/saml-signing-cert",
      attrMapping: { email: "$.email" },
      jitProvisioning: true,
      enabled: true,
      samlSpMetadataUrl: "https://app.helix.example/api/auth/saml/acme/metadata",
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
    {
      id: "idp-2",
      orgId: "org-1",
      protocol: "oidc",
      isPrimary: false,
      displayName: "Acme OIDC",
      config: { issuer: "https://idp.example.com", clientId: "helix" },
      signingCertVaultPath: null,
      attrMapping: {},
      jitProvisioning: true,
      enabled: true,
      samlSpMetadataUrl: null,
      createdAt: "2026-05-24T01:00:00.000Z",
      updatedAt: "2026-05-24T01:00:00.000Z",
    },
  ],
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

  it("renders IdP configs without hiding local login recovery", async () => {
    mockIdentityResponses(fetchMock);

    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("Identity");
      expect(container.textContent).toContain("Local email/password login");
      expect(container.textContent).toContain("Owner/admin recovery path");
      expect(container.textContent).toContain("enabled");
      expect(container.textContent).toContain("Acme Okta");
      expect(container.textContent).toContain("primary");
      const metadataLink = linkByText("Metadata");
      expect(metadataLink.href).toBe("https://app.helix.example/api/auth/saml/acme/metadata");
      expect(metadataLink.getAttribute("download")).toBe("acme-okta-sp-metadata.xml");
      expect(container.textContent).toContain("Acme OIDC");
    });
  });

  it("creates a SAML IdP config from the add form", async () => {
    mockIdentityResponses(fetchMock);

    await render();

    await waitFor(() => {
      expect(inputByLabel("IdP display name").value).toBe("");
    });
    await act(async () => {
      setInputValue(inputByLabel("IdP display name"), "Acme SAML");
      setInputValue(inputByLabel("SAML metadata URL"), "https://idp.example.com/metadata");
      setInputValue(inputByLabel("Signing cert Vault path"), "tenants/org-1/idp/saml-cert");
      buttonByText("Add IdP").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(postBody()).toMatchObject({
        protocol: "saml",
        displayName: "Acme SAML",
        config: { metadataUrl: "https://idp.example.com/metadata" },
        signingCertVaultPath: "tenants/org-1/idp/saml-cert",
        attrMapping: { email: "$.email", displayName: "$.name" },
        enabled: true,
        jitProvisioning: true,
      });
    });
  });

  it("previews attribute mappings against sample claims", async () => {
    mockIdentityResponses(fetchMock);

    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("Mapping preview");
      expect(container.textContent).toContain("alice@example.com");
      expect(container.textContent).toContain("Alice Example");
    });

    await act(async () => {
      setTextareaValue(
        textareaByLabel("Attribute mapping JSON"),
        '{ "email": "$.profile.email", "role": "$.groups.primary" }',
      );
      setTextareaValue(
        textareaByLabel("Sample claims JSON"),
        '{ "profile": { "email": "sso@example.com" }, "groups": { "primary": "admins" } }',
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("sso@example.com");
    expect(container.textContent).toContain("admins");

    await act(async () => {
      setTextareaValue(textareaByLabel("Sample claims JSON"), "[bad");
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Sample claims JSON must be a JSON object.");
    expect(container.textContent).toContain("Local email/password login");
  });

  it("edits common attribute mappings without hiding the JSON escape hatch", async () => {
    mockIdentityResponses(fetchMock);

    await render();

    await waitFor(() => {
      expect(inputByLabel("Email claim selector").value).toBe("$.email");
      expect(inputByLabel("Display name claim selector").value).toBe("$.name");
      expect(textareaByLabel("Attribute mapping JSON").value).toContain('"email": "$.email"');
    });

    await act(async () => {
      setInputValue(inputByLabel("Email claim selector"), "$.profile.email");
      setInputValue(inputByLabel("Given name claim selector"), "$.profile.given_name");
      setInputValue(inputByLabel("Family name claim selector"), "$.profile.family_name");
      setInputValue(inputByLabel("Groups claim selector"), "$.groups");
      await Promise.resolve();
    });

    expect(textareaByLabel("Attribute mapping JSON").value).toContain('"email": "$.profile.email"');
    expect(textareaByLabel("Attribute mapping JSON").value).toContain(
      '"givenName": "$.profile.given_name"',
    );

    await act(async () => {
      setInputValue(inputByLabel("IdP display name"), "Mapped SAML");
      setInputValue(inputByLabel("SAML metadata URL"), "https://idp.example.com/metadata");
      buttonByText("Add IdP").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(postBody()).toMatchObject({
        displayName: "Mapped SAML",
        attrMapping: {
          email: "$.profile.email",
          displayName: "$.name",
          givenName: "$.profile.given_name",
          familyName: "$.profile.family_name",
          groups: "$.groups",
        },
      });
      expect(container.textContent).toContain("Local email/password login");
    });
  });

  it("promotes a secondary IdP to primary", async () => {
    mockIdentityResponses(fetchMock);

    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("Acme OIDC");
    });
    await act(async () => {
      buttonByText("Make primary").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      const postUrls = fetchMock.mock.calls
        .filter((call) => call[1]?.method === "POST")
        .map((call) => requestUrlOf(call[0]));
      expect(postUrls).toContain("/api/admin/identity/idp-configs/idp-2/primary");
    });
  });

  it("updates an IdP config without hiding local recovery", async () => {
    mockIdentityResponses(fetchMock);

    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("Acme OIDC");
      expect(container.textContent).toContain("Local email/password login");
    });
    await act(async () => {
      buttonByText("Disable").click();
      await Promise.resolve();
    });
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (call) =>
          call[1]?.method === "PATCH" &&
          requestUrlOf(call[0]) === "/api/admin/identity/idp-configs/idp-1",
      );
      expect(patchCall?.[1]?.body).toBe(JSON.stringify({ enabled: false }));
      expect(container.textContent).toContain("Local email/password login");
      expect(container.textContent).toContain("Owner/admin recovery path");
    });
  });

  it("edits a SAML IdP with the reusable form without hiding local recovery", async () => {
    mockIdentityResponses(fetchMock);

    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("Acme Okta");
    });
    await act(async () => {
      buttonsByText("Edit")[0]?.click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Edit IdP");
      expect(inputByLabel("IdP display name").value).toBe("Acme Okta");
      expect(inputByLabel("SAML metadata URL").value).toBe("https://idp.example.com/metadata");
      expect(inputByLabel("Signing cert Vault path").value).toBe(
        "tenants/org-1/idp/saml-signing-cert",
      );
      expect(textareaByLabel("Attribute mapping JSON").value).toContain('"email": "$.email"');
    });

    await act(async () => {
      setInputValue(inputByLabel("IdP display name"), "Acme Okta updated");
      setInputValue(inputByLabel("SAML metadata URL"), "https://idp.example.com/new-metadata");
      setInputValue(inputByLabel("Signing cert Vault path"), "");
      setTextareaValue(textareaByLabel("Attribute mapping JSON"), '{ "email": "$.profile.email" }');
      setCheckboxValue(checkboxByText("Primary"), false);
      setCheckboxValue(checkboxByText("JIT provisioning"), false);
      buttonByText("Save IdP").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(patchBody("/api/admin/identity/idp-configs/idp-1")).toMatchObject({
        protocol: "saml",
        displayName: "Acme Okta updated",
        config: { metadataUrl: "https://idp.example.com/new-metadata" },
        signingCertVaultPath: null,
        attrMapping: { email: "$.profile.email" },
        isPrimary: false,
        jitProvisioning: false,
        enabled: true,
      });
      expect(container.textContent).toContain("Local email/password login");
      expect(container.textContent).toContain("Owner/admin recovery path");
    });
  });

  it("edits an OIDC IdP and can cancel edit mode", async () => {
    mockIdentityResponses(fetchMock);

    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("Acme OIDC");
    });
    await act(async () => {
      buttonsByText("Edit")[1]?.click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Edit IdP");
      expect(inputByLabel("IdP display name").value).toBe("Acme OIDC");
      expect(inputByLabel("OIDC issuer URL").value).toBe("https://idp.example.com");
      expect(inputByLabel("OIDC client ID").value).toBe("helix");
      expect(container.querySelector('input[aria-label="SAML metadata URL"]')).toBeNull();
    });

    await act(async () => {
      setInputValue(inputByLabel("OIDC issuer URL"), "https://login.example.com");
      buttonByText("Cancel edit").click();
      await Promise.resolve();
    });

    expect(inputByLabel("IdP display name").value).toBe("");
    expect(container.textContent).toContain("Add IdP");
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(0);

    await act(async () => {
      buttonsByText("Edit")[1]?.click();
      await Promise.resolve();
    });
    await act(async () => {
      setInputValue(inputByLabel("OIDC issuer URL"), "https://login.example.com");
      setInputValue(inputByLabel("OIDC client ID"), "helix-admin");
      buttonByText("Save IdP").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(patchBody("/api/admin/identity/idp-configs/idp-2")).toMatchObject({
        protocol: "oidc",
        displayName: "Acme OIDC",
        config: { issuer: "https://login.example.com", clientId: "helix-admin" },
        signingCertVaultPath: null,
        attrMapping: {},
        isPrimary: false,
        jitProvisioning: true,
        enabled: true,
      });
      expect(container.textContent).toContain("Local email/password login");
    });
  });

  it("deletes an IdP config after confirmation without hiding local recovery", async () => {
    mockIdentityResponses(fetchMock);

    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("Acme Okta");
      expect(container.textContent).toContain("Local email/password login");
    });
    await act(async () => {
      buttonByText("Delete").click();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Delete tenant IdP");
    });
    await act(async () => {
      documentButtonByText("Delete IdP").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      const deleteUrls = fetchMock.mock.calls
        .filter((call) => call[1]?.method === "DELETE")
        .map((call) => requestUrlOf(call[0]));
      expect(deleteUrls).toContain("/api/admin/identity/idp-configs/idp-1");
      expect(container.textContent).toContain("Local email/password login");
      expect(container.textContent).toContain("Owner/admin recovery path");
    });
  });

  it("checks IdP login readiness without hiding local recovery", async () => {
    mockIdentityResponses(fetchMock);

    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("Acme Okta");
      expect(container.textContent).toContain("Local email/password login");
    });
    await act(async () => {
      buttonByText("Test login").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      const postUrls = fetchMock.mock.calls
        .filter((call) => call[1]?.method === "POST")
        .map((call) => requestUrlOf(call[0]));
      expect(postUrls).toContain("/api/admin/identity/idp-configs/idp-1/test-login");
      expect(container.textContent).toContain("Runtime AuthnRequest/ACS handling is not connected");
      expect(container.textContent).toContain("Local email/password login");
    });
  });

  it("validates attribute mapping JSON before creating", async () => {
    mockIdentityResponses(fetchMock);

    await render();

    await waitFor(() => {
      expect(inputByLabel("IdP display name").value).toBe("");
    });
    await act(async () => {
      setInputValue(inputByLabel("IdP display name"), "Broken SAML");
      const mapping = fieldByLabel("Attribute mapping JSON", "textarea") as HTMLTextAreaElement;
      setTextareaValue(mapping, "[bad");
      buttonByText("Add IdP").click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Attribute mapping JSON must be a JSON object.");
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
  });

  async function render(): Promise<void> {
    await act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(IdentityManagement),
        ),
      );
      return Promise.resolve();
    });
  }

  function inputByLabel(label: string): HTMLInputElement {
    const element =
      container.querySelector(`input[aria-label="${cssEscape(label)}"]`) ??
      fieldByLabel(label, "input");
    if (!(element instanceof HTMLInputElement)) {
      throw new Error(`Input "${label}" not found.`);
    }
    return element;
  }

  function fieldByLabel(label: string, selector: "input" | "textarea"): Element {
    const match = [...container.querySelectorAll("label")].find((candidate) =>
      candidate.textContent?.includes(label),
    );
    const field = match?.querySelector(selector);
    if (field === undefined || field === null) {
      throw new Error(`Field "${label}" not found.`);
    }
    return field;
  }

  function textareaByLabel(label: string): HTMLTextAreaElement {
    const element =
      container.querySelector(`textarea[aria-label="${cssEscape(label)}"]`) ??
      fieldByLabel(label, "textarea");
    if (!(element instanceof HTMLTextAreaElement)) {
      throw new Error(`Textarea "${label}" not found.`);
    }
    return element;
  }

  function buttonByText(label: string): HTMLButtonElement {
    const button = buttonsByText(label)[0];
    if (button === undefined) {
      throw new Error(`Button "${label}" not found.`);
    }
    return button;
  }

  function buttonsByText(label: string): HTMLButtonElement[] {
    return [...container.querySelectorAll("button")].filter(
      (candidate) => candidate.textContent?.trim() === label && !candidate.disabled,
    );
  }

  function documentButtonByText(label: string): HTMLButtonElement {
    const button = [...document.body.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label && !candidate.disabled,
    );
    if (button === undefined) {
      throw new Error(`Document button "${label}" not found.`);
    }
    return button;
  }

  function linkByText(label: string): HTMLAnchorElement {
    const link = [...container.querySelectorAll("a")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!(link instanceof HTMLAnchorElement)) {
      throw new Error(`Link "${label}" not found.`);
    }
    return link;
  }

  function postBody(): Record<string, unknown> {
    const call = fetchMock.mock.calls.find(
      (candidate) =>
        candidate[1]?.method === "POST" &&
        requestUrlOf(candidate[0]) === "/api/admin/identity/idp-configs",
    );
    if (call === undefined || typeof call[1]?.body !== "string") {
      throw new Error("Create request not found.");
    }
    return JSON.parse(call[1].body) as Record<string, unknown>;
  }

  function patchBody(url: string): Record<string, unknown> {
    const call = fetchMock.mock.calls.find(
      (candidate) => candidate[1]?.method === "PATCH" && requestUrlOf(candidate[0]) === url,
    );
    if (call === undefined || typeof call[1]?.body !== "string") {
      throw new Error(`Patch request not found: ${url}`);
    }
    return JSON.parse(call[1].body) as Record<string, unknown>;
  }
});

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
    input,
    value,
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(
    textarea,
    value,
  );
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function setCheckboxValue(input: HTMLInputElement, checked: boolean): void {
  if (input.checked !== checked) {
    input.click();
  }
}

function checkboxByText(label: string): HTMLInputElement {
  const match = [...document.querySelectorAll("label")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  const input = match?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Checkbox "${label}" not found.`);
  }
  return input;
}

function mockIdentityResponses(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): void {
  fetchMock.mockImplementation((input, init) => {
    const url = requestUrlOf(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.endsWith("/primary")) {
      return Promise.resolve(
        Response.json({
          idpConfig: { ...identityPayload.idpConfigs[1], isPrimary: true },
          localLoginRecovery: identityPayload.localLoginRecovery,
        }),
      );
    }
    if (url.endsWith("/test-login")) {
      return Promise.resolve(
        Response.json({
          testLogin: {
            status: "runtime_pending",
            message:
              "SAML configuration is ready. Runtime AuthnRequest/ACS handling is not connected yet.",
          },
          localLoginRecovery: identityPayload.localLoginRecovery,
        }),
      );
    }
    if (method === "PATCH") {
      return Promise.resolve(
        Response.json({
          idpConfig: { ...identityPayload.idpConfigs[0], enabled: false, isPrimary: false },
          localLoginRecovery: identityPayload.localLoginRecovery,
        }),
      );
    }
    if (method === "DELETE") {
      return Promise.resolve(
        Response.json({
          idpConfig: identityPayload.idpConfigs[0],
          localLoginRecovery: identityPayload.localLoginRecovery,
        }),
      );
    }
    if (url === "/api/admin/identity/idp-configs" && method === "POST") {
      return Promise.resolve(
        Response.json({
          idpConfig: identityPayload.idpConfigs[0],
          localLoginRecovery: identityPayload.localLoginRecovery,
        }),
      );
    }
    return Promise.resolve(Response.json(identityPayload));
  });
}

function requestUrlOf(input: unknown): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input instanceof Request
        ? input.url
        : "";
}

function cssEscape(value: string): string {
  return value.replace(/"/g, '\\"');
}

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
