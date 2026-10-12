// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axeViolations, mount, unmountAll } from "@/test/ui";
import type { DecisionModelView } from "./mail-decision-model-api";
import { decisionModelQueryKeys } from "./mail-decision-model-api";
import { DecisionModelSettings } from "./mail-decision-model-settings";
import { decisionModelViewFixture } from "./mail-decision-model.test-fixtures";

// Low-entropy stand-in so secret scanners never mistake it for a credential.
const TYPESAFE_TEST_KEY = "x".repeat(16);

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let view: DecisionModelView;
let calls: Call[];
let putResponse: (body: unknown) => Response;
let testResponse: (body: unknown) => Response;

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api/auth/csrf-token")) return Promise.resolve(json({ csrfToken: "csrf" }));
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, url, body });
      if (url.endsWith("/api/admin/mail/decision-model/test")) {
        return Promise.resolve(testResponse(body));
      }
      if (url.endsWith("/api/admin/mail/decision-model")) {
        return Promise.resolve(
          method === "PUT" ? putResponse(body) : json({ decisionModel: view }),
        );
      }
      return Promise.resolve(json({ error: "not found" }, 404));
    }),
  );
}

let queryClient: QueryClient;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void, timeout = 2000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - started > timeout) throw error;
      await settle();
    }
  }
}

async function renderSettings() {
  const mounted = mount(
    <QueryClientProvider client={queryClient}>
      <DecisionModelSettings />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(field("Provider")).toBeTruthy());
  return mounted;
}

function field<T extends HTMLElement = HTMLInputElement>(label: string): T {
  const element = [...document.querySelectorAll("label")].find(
    (candidate) => candidate.textContent === label,
  );
  const id = element?.htmlFor;
  const control = id === undefined || id === "" ? null : document.getElementById(id);
  if (control === null) throw new Error(`No control labelled ${label}`);
  return control as T;
}

function radio(label: string): HTMLInputElement {
  const option = [...document.querySelectorAll("label")].find((candidate) =>
    candidate.textContent?.startsWith(label),
  );
  const input = option?.querySelector<HTMLInputElement>('input[type="radio"]');
  if (input === null || input === undefined) throw new Error(`No radio ${label}`);
  return input;
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (found === undefined) throw new Error(`No button ${name}`);
  return found;
}

async function type(control: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype =
    control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
    await Promise.resolve();
  });
}

async function press(target: HTMLElement) {
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}

function statusText(): string {
  return document.querySelector('form [role="status"]')?.textContent ?? "";
}

function puts(): Call[] {
  return calls.filter((call) => call.method === "PUT");
}

beforeEach(() => {
  view = decisionModelViewFixture();
  calls = [];
  putResponse = (body) => {
    const settings = (body as { settings: Partial<DecisionModelView> }).settings;
    view = { ...view, ...settings };
    return json({ decisionModel: view });
  };
  testResponse = () =>
    json({
      test: {
        ok: true,
        latencyMs: 412,
        model: "clef-flash",
        answer: "legitimate",
        confidence: 0.98,
        provider: "cloudflare",
      },
    });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  installFetch();
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe("DecisionModelSettings", () => {
  it("loads the saved settings, shows the stored key, and has no axe violations", async () => {
    await renderSettings();
    expect(field<HTMLSelectElement>("Provider").value).toBe("cloudflare");
    expect(field<HTMLSelectElement>("Model").value).toBe("clef-flash");
    expect(field("Cloudflare account ID").value).toBe("0123456789abcdef0123456789abcdef");
    expect(radio("Shadow").checked).toBe(true);
    expect(document.body.textContent).toContain("Stored");
    expect(document.body.textContent).toContain("Saved mode: Shadow");
    // The password field only appears when replacing the stored key.
    expect(document.querySelector('input[type="password"]')).toBeNull();
    const fieldset = document.querySelector("fieldset");
    expect(fieldset?.querySelector("legend")?.textContent).toBe("Mode");
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("shows the provider data notice only while the mode is not Off", async () => {
    await renderSettings();
    expect(document.body.textContent).toContain(
      "Message content is sent to Cloudflare Workers AI for classification.",
    );
    await press(radio("Off"));
    expect(document.body.textContent).not.toContain("Message content is sent to");
    await press(radio("Enforce"));
    expect(document.body.textContent).toContain("Message content is sent to Cloudflare Workers AI");
    await type(field<HTMLSelectElement>("Provider"), "typesafe");
    expect(document.body.textContent).toContain("Message content is sent to TypeSafe");
  });

  it("saves the exact settings with a replacement key and announces success", async () => {
    await renderSettings();
    await type(field("Spam confidence"), "0.95");
    await press(button("Replace"));
    const key = field("Cloudflare API token");
    expect(key.type).toBe("password");
    expect(document.activeElement).toBe(key);
    await type(key, "cf-new-token-123");
    await press(button("Save"));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.body).toEqual({
      settings: {
        mode: "shadow",
        provider: "cloudflare",
        model: "clef-flash",
        cloudflareAccountId: "0123456789abcdef0123456789abcdef",
        spamThreshold: 0.95,
        phishingThreshold: 0.8,
        categoryThreshold: 0.75,
        applyCategories: false,
        dailyMessageCap: 5000,
      },
      apiKey: "cf-new-token-123",
    });
    await waitFor(() => expect(statusText()).toContain("Saved. The AI decision model is shadow."));
    // The key is write-only: the field is gone and nothing echoes it back.
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain("cf-new-token-123");
  });

  it("sends clearApiKey when the stored key is removed and the model is turned off", async () => {
    await renderSettings();
    await press(radio("Off"));
    await press(button("Remove"));
    expect(document.body.textContent).toContain("The stored key will be removed when you save.");
    expect(document.activeElement).toBe(button("Keep the stored key"));
    await press(button("Save"));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.body).toMatchObject({ settings: { mode: "off" }, clearApiKey: true });
    expect(puts()[0]?.body).not.toHaveProperty("apiKey");
  });

  it("blocks turning the model on without a key, with a field-level error", async () => {
    await renderSettings();
    await press(button("Remove"));
    await press(button("Save"));
    expect(puts()).toHaveLength(0);
    expect(document.body.textContent).toContain(
      "Add the Cloudflare API token before turning on shadow mode.",
    );
  });

  it("shows server issues on the matching field", async () => {
    putResponse = () =>
      json(
        {
          error: "Invalid decision model settings.",
          code: "invalid_request",
          issues: [
            { path: ["dailyMessageCap"], message: "Number must be less than or equal to 1000000" },
          ],
        },
        400,
      );
    await renderSettings();
    await press(button("Save"));
    await waitFor(() =>
      expect(document.body.textContent).toContain("Number must be less than or equal to 1000000"),
    );
    const cap = field("Daily message limit");
    expect(cap.getAttribute("aria-invalid")).toBe("true");
    const describedBy = cap.getAttribute("aria-describedby") ?? "";
    expect(
      describedBy
        .split(" ")
        .some((id) => document.getElementById(id)?.textContent?.includes("1000000")),
    ).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Invalid decision model settings.",
    );
  });

  it("validates thresholds and the account id before sending", async () => {
    await renderSettings();
    await type(field("Phishing confidence"), "0.3");
    await type(field("Cloudflare account ID"), "not-an-id");
    await press(button("Save"));
    expect(puts()).toHaveLength(0);
    expect(field("Phishing confidence").getAttribute("aria-invalid")).toBe("true");
    expect(document.body.textContent).toContain("Enter a confidence between 0.5 and 1.");
    expect(document.body.textContent).toContain("Enter the 32-character account ID");
  });

  it("tests the connection with the unsaved settings and typed key", async () => {
    await renderSettings();
    await type(field<HTMLSelectElement>("Model"), "clef");
    await press(button("Replace"));
    await type(field("Cloudflare API token"), "cf-typed-token-1");
    await press(button("Test connection"));
    await waitFor(() => expect(statusText()).toContain("Connected to Cloudflare Workers AI"));
    expect(statusText()).toContain("412 ms");
    expect(statusText()).toContain("98% confidence");
    const test = calls.find((call) => call.url.endsWith("/decision-model/test"));
    expect(test?.body).toMatchObject({
      settings: { provider: "cloudflare", model: "clef" },
      apiKey: "cf-typed-token-1",
    });
    expect(puts()).toHaveLength(0);
  });

  it("explains a failed connection test", async () => {
    testResponse = () =>
      json(
        {
          error: "Cloudflare rejected the API token. Check that it has Workers AI permission.",
          code: "provider_error",
          providerCode: "unauthorized",
          providerStatus: 401,
        },
        502,
      );
    await renderSettings();
    await press(button("Test connection"));
    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Cloudflare rejected the API token",
      ),
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("unauthorized");
  });

  it("keeps unsaved edits when the settings refetch", async () => {
    await renderSettings();
    await type(field("Daily message limit"), "250");
    view = decisionModelViewFixture({ phishingThreshold: 0.85 });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: decisionModelQueryKeys.settings() });
    });
    await settle();
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
    expect(field("Daily message limit").value).toBe("250");
    // Same element: typing does not remount the form.
    const cap = field("Daily message limit");
    await type(cap, "260");
    expect(field("Daily message limit")).toBe(cap);
  });

  it("switches to TypeSafe with a free-text model, advanced base URL, and a new key", async () => {
    await renderSettings();
    await type(field<HTMLSelectElement>("Provider"), "typesafe");
    expect(field("Model").value).toBe("jev-latest");
    expect(() => field("Cloudflare account ID")).toThrow();
    // The stored key belongs to Cloudflare, so TypeSafe needs its own.
    const key = field("TypeSafe API key");
    await type(key, TYPESAFE_TEST_KEY);
    await type(field("TypeSafe base URL"), "https://typesafe.internal.example");
    await press(button("Save"));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.body).toEqual({
      settings: {
        mode: "shadow",
        provider: "typesafe",
        model: "jev-latest",
        baseUrl: "https://typesafe.internal.example",
        spamThreshold: 0.9,
        phishingThreshold: 0.8,
        categoryThreshold: 0.75,
        applyCategories: false,
        dailyMessageCap: 5000,
      },
      apiKey: TYPESAFE_TEST_KEY,
    });
  });
});
