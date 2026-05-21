// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebhookManagement } from "./webhook-management";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("WebhookManagement", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let deferredResponses: Map<string, Deferred<Response>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 0,
        },
      },
    });
    deferredResponses = new Map();
    fetchMock = vi.fn<typeof fetch>((input) => {
      if (typeof input === "string") {
        const deferredResponse = deferredResponses.get(input);
        if (deferredResponse !== undefined) {
          return deferredResponse.promise;
        }
      }
      if (input === "/api/tools/webhook.outbound.list") {
        return Promise.resolve(
          Response.json({
            webhooks: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                orgId: "22222222-2222-4222-8222-222222222222",
                name: "Slack launch channel",
                url: "https://hooks.slack.test/launch",
                eventSubjects: ["activity.mail.received"],
                secretRef: "inline:redacted",
                headers: {},
                enabled: true,
                metadata: { format: "slack" },
                createdByActorId: null,
                createdAt: "2026-05-20T12:00:00.000Z",
                updatedAt: "2026-05-20T12:05:00.000Z",
              },
            ],
          }),
        );
      }
      if (input === "/api/tools/webhook.inbound.list") {
        return Promise.resolve(
          Response.json({
            webhooks: [
              {
                id: "33333333-3333-4333-8333-333333333333",
                orgId: "22222222-2222-4222-8222-222222222222",
                name: "GitHub deploy hook",
                slug: "github-deploy",
                source: "github",
                secretRef: "inline:redacted",
                enabled: true,
                metadata: { action: { toolId: "chat.send" } },
                createdByActorId: null,
                lastReceivedAt: "2026-05-20T12:10:00.000Z",
                createdAt: "2026-05-20T12:00:00.000Z",
                updatedAt: "2026-05-20T12:05:00.000Z",
              },
            ],
          }),
        );
      }
      if (input === "/api/tools/webhook.delivery.list") {
        return Promise.resolve(
          Response.json({
            deliveries: Array.from({ length: 24 }, (_, index) => ({
              id: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`,
              orgId: "22222222-2222-4222-8222-222222222222",
              direction: index % 2 === 0 ? "outbound" : "inbound",
              outboundWebhookId: index % 2 === 0 ? "11111111-1111-4111-8111-111111111111" : null,
              inboundWebhookId: index % 2 === 0 ? null : "33333333-3333-4333-8333-333333333333",
              eventSubject: `activity.webhook.${String(index)}`,
              status: index === 0 ? "failed" : "delivered",
              attempt: index + 1,
              payload: { index },
              payloadSha256: null,
              signature: null,
              requestHeaders: { "x-delivery": String(index) },
              responseStatus: index === 0 ? 500 : 200,
              responseHeaders: { "content-type": "application/json" },
              error: index === 0 ? "boom" : null,
              nextAttemptAt: null,
              deliveredAt: "2026-05-20T12:12:00.000Z",
              createdAt: "2026-05-20T12:11:00.000Z",
              updatedAt: "2026-05-20T12:12:00.000Z",
            })),
          }),
        );
      }
      return Promise.resolve(Response.json({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders outbound, inbound, and virtualized delivery tables from query data", async () => {
    renderWebhooks();
    await waitForText("Slack launch channel");
    expect(container.textContent).toContain("https://hooks.slack.test/launch");

    await clickTab("Inbound");
    await waitForText("GitHub deploy hook");
    expect(container.textContent).toContain("/webhooks/github-deploy");

    await clickTab("Deliveries");
    await waitForText("activity.webhook.0");
    expect(container.textContent).toContain("failed");
    expect(container.querySelector(".webhooks-table-wrap.deliveries")).not.toBeNull();
    expect(fetchBody("/api/tools/webhook.delivery.list")).toMatchObject({ limit: 100 });

    await clickDeliveryAction("View");
    expect(container.textContent).toContain("delivery detail");
    expect(container.textContent).toContain("Response status");
    expect(container.textContent).toContain('"payload"');
    expect(container.textContent).toContain('"response"');
  });

  it("passes webhook id and time range delivery filters through to the list API", async () => {
    renderWebhooks();
    await waitForText("Slack launch channel");

    await clickTab("Deliveries");
    await waitForText("activity.webhook.0");
    await setFieldValue("Direction", "outbound");
    await setFieldValue("Status", "failed");
    await setFieldValue("Webhook ID", " 11111111-1111-4111-8111-111111111111 ");
    await setFieldValue("From", "2026-05-20T08:00");
    await setFieldValue("To", "2026-05-20T12:30");
    await setFieldValue("Limit", "25");

    await waitFor(() =>
      expect(latestFetchBody("/api/tools/webhook.delivery.list")).toMatchObject({
        direction: "outbound",
        status: "failed",
        webhookId: "11111111-1111-4111-8111-111111111111",
        createdAfter: new Date("2026-05-20T08:00").toISOString(),
        createdBefore: new Date("2026-05-20T12:30").toISOString(),
        limit: 25,
      }),
    );
  });

  it("submits outbound form values as a create payload", async () => {
    renderWebhooks();
    await waitForText("Slack launch channel");

    await clickHeaderAction("Outbound");
    await setFieldValue("Name", "  PagerDuty alerts  ");
    await setFieldValue("Destination URL", "  https://example.test/webhook  ");
    await setCheckbox("Enabled", false);
    await clickEditorAction("Continue");
    await setFieldValue(
      "Event subjects",
      "activity.mail.received\nplatform.pending_action.created",
    );
    await setFieldValue("Format", "slack");
    await setFieldValue("Template", "  Hello {{event.subject}}  ");
    await setFieldValue("Headers JSON", '{ "x-team": "ops" }');
    await clickEditorAction("Continue");
    await setFieldValue("Metadata JSON", '{ "owner": "platform" }');
    expect(container.textContent).toContain("https://example.test/webhook");
    expect(container.textContent).toContain(
      "activity.mail.received, platform.pending_action.created",
    );
    await submitEditor();

    await waitFor(() =>
      expect(fetchBody("/api/tools/webhook.outbound.create")).toMatchObject({
        name: "PagerDuty alerts",
        url: "https://example.test/webhook",
        eventSubjects: ["activity.mail.received", "platform.pending_action.created"],
        headers: { "x-team": "ops" },
        enabled: false,
        metadata: {
          owner: "platform",
          format: "slack",
          template: "  Hello {{event.subject}}  ",
        },
      }),
    );
  });

  it("submits inbound form values as a create payload", async () => {
    renderWebhooks();
    await waitForText("Slack launch channel");

    await clickHeaderAction("Inbound");
    await setFieldValue("Name", "  Linear intake  ");
    await setFieldValue("Slug", "linear-intake");
    await setFieldValue("Source", "linear");
    await setCheckbox("Enabled", false);
    await clickEditorAction("Continue");
    await setFieldValue("Action tool ID", "  chat.send  ");
    await setFieldValue("Action scopes", "admin.webhooks, chat.send");
    await setFieldValue("Action input JSON", '{ "channel": "ops" }');
    await clickEditorAction("Continue");
    await setFieldValue("Metadata JSON", '{ "owner": "platform" }');
    expect(container.textContent).toContain("/webhooks/linear-intake");
    expect(container.textContent).toContain("chat.send");
    await submitEditor();

    await waitFor(() =>
      expect(fetchBody("/api/tools/webhook.inbound.create")).toMatchObject({
        name: "Linear intake",
        slug: "linear-intake",
        source: "linear",
        enabled: false,
        metadata: {
          owner: "platform",
          action: {
            toolId: "chat.send",
            scopes: ["admin.webhooks", "chat.send"],
            input: { channel: "ops" },
          },
        },
      }),
    );
  });

  it("offers PRD inbound source plugins in the receiver editor", async () => {
    renderWebhooks();
    await waitForText("Slack launch channel");

    await clickHeaderAction("Inbound");
    const sourceField = findField("Source");
    const options = Array.from(sourceField.querySelectorAll("option")).map(
      (option) => option.value,
    );
    expect(options).toEqual([
      "generic",
      "github",
      "gitlab",
      "stripe",
      "linear",
      "grafana",
      "prometheus",
    ]);

    await setFieldValue("Name", "  Grafana alerts  ");
    await setFieldValue("Slug", "grafana-alerts");
    await setFieldValue("Source", "grafana");
    await clickEditorAction("Continue");
    await clickEditorAction("Continue");
    await submitEditor();

    await waitFor(() =>
      expect(fetchBody("/api/tools/webhook.inbound.create")).toMatchObject({
        name: "Grafana alerts",
        slug: "grafana-alerts",
        source: "grafana",
      }),
    );
  });

  it("keeps invalid outbound create payloads local to the editor", async () => {
    renderWebhooks();
    await waitForText("Slack launch channel");

    await clickHeaderAction("Outbound");
    await setFieldValue("Name", "PagerDuty alerts");
    await setFieldValue("Destination URL", "https://example.test/webhook");
    await clickEditorAction("Continue");
    await setFieldValue("Headers JSON", '{ "x-team": 1 }');
    await clickEditorAction("Continue");
    await submitEditor();

    await waitForText("Headers JSON values must be strings.");
    expect(
      fetchMock.mock.calls.some((call) => call[0] === "/api/tools/webhook.outbound.create"),
    ).toBe(false);
  });

  it("keeps invalid inbound create payloads local to the editor", async () => {
    renderWebhooks();
    await waitForText("Slack launch channel");

    await clickHeaderAction("Inbound");
    await setFieldValue("Name", "Linear intake");
    await setFieldValue("Slug", "Linear Intake");
    await setFieldValue("Source", "linear");
    await clickEditorAction("Continue");
    await clickEditorAction("Continue");
    await submitEditor();

    await waitForText(
      "Slug must start with a lowercase letter or number and use only lowercase letters, numbers, and hyphens.",
    );
    expect(
      fetchMock.mock.calls.some((call) => call[0] === "/api/tools/webhook.inbound.create"),
    ).toBe(false);
  });

  it("optimistically creates outbound webhooks and rolls back failed saves", async () => {
    const createResponse = defer<Response>();
    deferredResponses.set("/api/tools/webhook.outbound.create", createResponse);
    renderWebhooks();
    await waitForText("Slack launch channel");

    await clickHeaderAction("Outbound");
    await setFieldValue("Name", "PagerDuty alerts");
    await setFieldValue("Destination URL", "https://example.test/webhook");
    await clickEditorAction("Continue");
    await clickEditorAction("Continue");
    await submitEditor();

    await waitFor(() => expect(outboundCache()).toHaveLength(2));
    expect(outboundCache()[0]?.name).toBe("PagerDuty alerts");

    createResponse.resolve(Response.json({ error: "Outbound save failed" }, { status: 500 }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Outbound save failed"));
    expect(outboundCache()).toHaveLength(1);
    expect(outboundCache()[0]?.name).toBe("Slack launch channel");
  });

  it("optimistically creates inbound webhooks and rolls back failed saves", async () => {
    const createResponse = defer<Response>();
    deferredResponses.set("/api/tools/webhook.inbound.create", createResponse);
    renderWebhooks();
    await waitForText("Slack launch channel");

    await clickHeaderAction("Inbound");
    await setFieldValue("Name", "Linear intake");
    await setFieldValue("Slug", "linear-intake");
    await setFieldValue("Source", "linear");
    await clickEditorAction("Continue");
    await clickEditorAction("Continue");
    await submitEditor();

    await waitFor(() => expect(inboundCache()).toHaveLength(2));
    expect(inboundCache()[0]?.name).toBe("Linear intake");

    createResponse.resolve(Response.json({ error: "Inbound save failed" }, { status: 500 }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Inbound save failed"));
    expect(inboundCache()).toHaveLength(1);
    expect(inboundCache()[0]?.name).toBe("GitHub deploy hook");
  });

  it("optimistically rotates inbound secrets and rolls back failed refreshes", async () => {
    const rotateResponse = defer<Response>();
    deferredResponses.set("/api/tools/webhook.inbound.rotate-secret", rotateResponse);
    renderWebhooks();
    await waitForText("Slack launch channel");

    await clickTab("Inbound");
    await waitForText("GitHub deploy hook");
    await clickRowAction("Rotate secret");

    await waitFor(() => expect(inboundCache()[0]?.secretRef).toBe("inline:pending"));

    rotateResponse.resolve(Response.json({ error: "Secret refresh failed" }, { status: 500 }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Secret refresh failed"));
    expect(inboundCache()[0]?.secretRef).toBe("inline:redacted");
  });

  it("optimistically applies outbound row actions and rolls back failed actions", async () => {
    const updateResponse = defer<Response>();
    deferredResponses.set("/api/tools/webhook.outbound.update", updateResponse);
    renderWebhooks();
    await waitForText("Slack launch channel");

    await clickRowAction("Disable");
    await waitFor(() => expect(outboundCache()[0]?.enabled).toBe(false));

    updateResponse.resolve(Response.json({ error: "Outbound action failed" }, { status: 500 }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Outbound action failed"));
    expect(outboundCache()[0]?.enabled).toBe(true);
  });

  it("optimistically applies inbound row actions and rolls back failed actions", async () => {
    const updateResponse = defer<Response>();
    deferredResponses.set("/api/tools/webhook.inbound.update", updateResponse);
    renderWebhooks();
    await waitForText("Slack launch channel");

    await clickTab("Inbound");
    await waitForText("GitHub deploy hook");
    await clickRowAction("Disable");
    await waitFor(() => expect(inboundCache()[0]?.enabled).toBe(false));

    updateResponse.resolve(Response.json({ error: "Inbound action failed" }, { status: 500 }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Inbound action failed"));
    expect(inboundCache()[0]?.enabled).toBe(true);
  });

  function renderWebhooks() {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <WebhookManagement />
        </QueryClientProvider>,
      );
    });
  }

  async function clickHeaderAction(label: string) {
    const button = Array.from(container.querySelectorAll(".webhooks-header-actions button")).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Header action not found: ${label}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
  }

  async function clickTab(label: string) {
    const tab = Array.from(container.querySelectorAll('[role="tab"]')).find((candidate) =>
      candidate.textContent?.includes(label),
    );
    if (!(tab instanceof HTMLButtonElement)) {
      throw new Error(`Tab not found: ${label}`);
    }
    act(() => {
      tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
  }

  async function clickRowAction(title: string) {
    const button = Array.from(container.querySelectorAll(".webhooks-row-actions button")).find(
      (candidate) => candidate.getAttribute("title") === title,
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Row action not found: ${title}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
  }

  async function clickDeliveryAction(label: string) {
    const button = Array.from(
      container.querySelectorAll(".webhooks-table-wrap.deliveries button"),
    ).find((candidate) => candidate.textContent?.trim() === label);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Delivery action not found: ${label}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
  }

  async function setFieldValue(label: string, value: string) {
    const field = findField(label);
    const input = field.querySelector("input, textarea, select");
    if (
      !(
        input instanceof HTMLInputElement ||
        input instanceof HTMLTextAreaElement ||
        input instanceof HTMLSelectElement
      )
    ) {
      throw new Error(`Input not found for field: ${label}`);
    }
    await setNativeValue(input, value);
  }

  async function setCheckbox(label: string, checked: boolean) {
    const checkboxLabel = Array.from(container.querySelectorAll("label.webhooks-checkbox")).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    const input = checkboxLabel?.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error(`Checkbox not found: ${label}`);
    }
    act(() => {
      if (input.checked !== checked) {
        input.click();
      }
    });
    await flush();
  }

  async function submitEditor() {
    const form = container.querySelector("form.webhooks-editor");
    if (!(form instanceof HTMLFormElement)) {
      throw new Error("Editor form not found.");
    }
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
  }

  async function clickEditorAction(label: string) {
    const button = Array.from(container.querySelectorAll(".webhooks-form-actions button")).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Editor action not found: ${label}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
  }

  function findField(label: string) {
    const field = Array.from(container.querySelectorAll("label.webhooks-field")).find(
      (candidate) => candidate.querySelector("span")?.textContent === label,
    );
    if (!(field instanceof HTMLLabelElement)) {
      throw new Error(`Field not found: ${label}`);
    }
    return field;
  }

  async function setNativeValue(
    input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    value: string,
  ) {
    act(() => {
      setNativeInputValue(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
  }

  function setNativeInputValue(
    input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    value: string,
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value");
    descriptor?.set?.call(input, value);
  }

  function fetchBody(url: string) {
    const body = fetchMock.mock.calls.find((call) => call[0] === url)?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error(`Expected request body for ${url}.`);
    }
    return JSON.parse(body) as unknown;
  }

  function latestFetchBody(url: string) {
    const matchingCalls = fetchMock.mock.calls.filter((call) => call[0] === url);
    const body = matchingCalls[matchingCalls.length - 1]?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error(`Expected request body for ${url}.`);
    }
    return JSON.parse(body) as unknown;
  }

  function outboundCache() {
    return (
      queryClient.getQueryData<readonly { readonly name: string; readonly enabled: boolean }[]>([
        "webhooks",
        "outbound",
      ]) ?? []
    );
  }

  function inboundCache() {
    return (
      queryClient.getQueryData<
        readonly {
          readonly name: string;
          readonly enabled: boolean;
          readonly secretRef: string | null;
        }[]
      >(["webhooks", "inbound"]) ?? []
    );
  }

  async function waitForText(text: string) {
    await waitFor(() => expect(container.textContent).toContain(text));
  }

  async function waitFor(assertion: () => void | Promise<void>) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await flush();
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

  async function flush() {
    await act(async () => {
      await Promise.resolve();
    });
  }
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
