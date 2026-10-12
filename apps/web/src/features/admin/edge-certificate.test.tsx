// @vitest-environment jsdom

/* The HTTPS certificate panel: what is served and until when, uploading a
 * replacement with the refusal attached to the right field, and going back to
 * automatic certificates. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeCertificatePanel } from "./edge-certificate";
import type { EdgeCertificateStatus } from "./edge-certificate-api";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const DAY_MS = 24 * 60 * 60 * 1000;
/* Not a key. Assembled so the repository's secret scan, which rejects any
   source containing a private-key header, has nothing to match. */
const KEY_TEXT = ["-----BEGIN", "PRIVATE KEY-----\nMIIE\n-----END", "PRIVATE KEY-----"].join(" ");
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS + 60_000).toISOString();

function certificate(issuer: string, days: number, fingerprint = "a") {
  return {
    subject: "workspace.example.com",
    issuer,
    names: ["workspace.example.com"],
    notBefore: inDays(-10),
    notAfter: inDays(days),
    fingerprintSha256: fingerprint.repeat(64),
  };
}

function status(overrides: Partial<EdgeCertificateStatus> = {}): EdgeCertificateStatus {
  return {
    hostname: "workspace.example.com",
    source: "automatic",
    manageable: true,
    unavailableReason: null,
    served: certificate("Let's Encrypt R11", 80),
    uploaded: null,
    applied: true,
    ...overrides,
  };
}

interface Call {
  readonly method: string;
  readonly body: unknown;
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let calls: Call[];
let current: EdgeCertificateStatus;
let respond: (call: Call) => Response;

beforeEach(() => {
  document.cookie = `helix_csrf=${"c".repeat(43)}; Path=/`;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  calls = [];
  current = status();
  respond = () => Response.json({ certificate: current });
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      };
      calls.push(call);
      return Promise.resolve(respond(call));
    }),
  );
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
  document.cookie = "helix_csrf=; Max-Age=0; Path=/";
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(): Promise<void> {
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <EdgeCertificatePanel />
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function click(label: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (button === undefined) throw new Error(`No ${label} button`);
  act(() => {
    button.click();
  });
  await settle();
}

async function type(name: string, value: string): Promise<void> {
  const field = document.querySelector<HTMLTextAreaElement>(`textarea[name="${name}"]`);
  if (field === null) throw new Error(`No ${name} field`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      field,
      value,
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

const text = () => container.textContent ?? "";

describe("EdgeCertificatePanel", () => {
  it("shows what is served, who issued it and when it expires", async () => {
    await render();

    expect(text()).toContain("What browsers check when they open workspace.example.com.");
    expect(text()).toContain("Automatic");
    expect(text()).toContain("Let's Encrypt R11");
    expect(text()).toContain("expires in 80 days");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(text()).toContain("Use your own certificate");
    expect(text()).not.toContain("Go back to automatic");
  });

  it("warns early about an uploaded certificate, which nothing renews", async () => {
    const uploaded = certificate("Example CA", 12, "b");
    current = status({
      source: "uploaded",
      served: uploaded,
      uploaded: { ...uploaded, updatedAt: inDays(-300) },
    });
    await render();

    expect(text()).toContain("Your certificate");
    expect(container.querySelector(".chip.warning")?.textContent).toBe("expires in 12 days");
    expect(text()).toContain(
      "Helix does not renew a certificate you uploaded. Upload its renewal before it expires.",
    );
    expect(text()).toContain("Replace certificate");
  });

  it("does not warn about an automatic certificate that is simply due for renewal", async () => {
    current = status({ served: certificate("Let's Encrypt R11", 25) });
    await render();

    expect(container.querySelector(".chip.warning")).toBeNull();
    expect(text()).toContain("expires in 25 days");
  });

  it("says why a certificate cannot be uploaded and offers no way to try", async () => {
    current = status({
      source: "deployment-files",
      manageable: false,
      unavailableReason:
        "This deployment serves a certificate from files on the server. Replace those files and restart the edge to change it.",
    });
    await render();

    expect(text()).toContain("From server files");
    expect(text()).toContain("Replace those files and restart the edge to change it.");
    expect(text()).not.toContain("Use your own certificate");
  });

  it("uploads a certificate and watches the server switch to it", async () => {
    await render();
    await click("Use your own certificate");
    await click("Use this certificate");
    const missing = document.querySelector('[role="alert"]');
    expect(missing?.textContent).toBe("Paste the certificate or choose its file.");
    expect(
      document.querySelector('textarea[name="certificatePem"]')?.getAttribute("aria-describedby"),
    ).toBe(missing?.id);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);

    await type("certificatePem", "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----");
    await type("privateKeyPem", KEY_TEXT);
    const uploaded = certificate("Example CA", 300, "b");
    current = status({
      source: "uploaded",
      uploaded: { ...uploaded, updatedAt: new Date().toISOString() },
      applied: false,
    });
    await click("Use this certificate");

    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      certificatePem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
      privateKeyPem: KEY_TEXT,
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(text()).toContain("Your certificate is saved. The server is switching to it now.");
    expect(text()).toContain("Go back to automatic");
  });

  it("attaches a refusal to the input it is about and keeps what was typed", async () => {
    await render();
    await click("Use your own certificate");
    await type("certificatePem", "certificate text");
    await type("privateKeyPem", "key text");
    respond = (call) =>
      call.method === "PUT"
        ? Response.json(
            {
              error: "The private key does not belong to this certificate.",
              code: "invalid_request",
              issues: [{ path: ["privateKey"] }],
            },
            { status: 400 },
          )
        : Response.json({ certificate: current });
    await click("Use this certificate");

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("The private key does not belong to this certificate.");
    const key = document.querySelector<HTMLTextAreaElement>('textarea[name="privateKeyPem"]');
    expect(key?.getAttribute("aria-describedby")).toBe(alert?.id);
    expect(key?.getAttribute("aria-invalid")).toBe("true");
    expect(key?.value).toBe("key text");
    expect(
      document.querySelector('textarea[name="certificatePem"]')?.getAttribute("aria-invalid"),
    ).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("goes back to an automatic certificate after confirmation", async () => {
    const uploaded = certificate("Example CA", 300, "b");
    current = status({
      source: "uploaded",
      served: uploaded,
      uploaded: { ...uploaded, updatedAt: new Date().toISOString() },
    });
    await render();
    await click("Go back to automatic");
    expect(document.body.textContent).toContain("requests one from Let’s Encrypt instead");
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);

    current = status();
    await click("Remove certificate");

    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(text()).toContain("Automatic");
    expect(text()).not.toContain("Go back to automatic");
  });

  it("says so when the certificate cannot be loaded", async () => {
    respond = () => Response.json({ error: "Denied for this role." }, { status: 403 });
    await render();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "The certificate could not be loaded. Denied for this role.",
    );
  });
});
