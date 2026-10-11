// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellOverlayContext } from "@/components/shell";
import { MAIL_COMPOSE_RECOVERY_KEY, writeMailComposeRecovery } from "./mail-compose-recovery";
import { MailShell } from "./mail-shell";
import { FOLDERS, LABELS, threadRow, UPDATES_ROW, THREAD_DETAIL } from "./mail-shell.test-fixtures";
import { shellOverlaysForTest } from "@/test/shell-overlays";

const navigateMock = vi.fn();
const uploadDriveFileMock = vi.fn();
const trashDriveObjectMock = vi.fn();
vi.mock("@/features/drive/api", () => ({
  uploadDriveFile: (...args: unknown[]) => uploadDriveFileMock(...args),
  trashDriveObject: (...args: unknown[]) => trashDriveObjectMock(...args),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  useRouter: () => ({ navigate: navigateMock }),
  useSearch: () => ({}),
  useBlocker: () => ({
    status: "idle",
    current: undefined,
    next: undefined,
    action: undefined,
    proceed: undefined,
    reset: undefined,
  }),
}));

vi.mock("@helix/sdk-web", () => ({
  SuggestionSlot: ({ emptyFallback }: { readonly emptyFallback?: React.ReactNode }) =>
    emptyFallback ?? null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const overlayApi = shellOverlaysForTest();

describe("MailShell", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  function urlOf(input: RequestInfo | URL): string {
    if (typeof input === "string") {
      return input;
    }
    if (input instanceof URL) {
      return input.href;
    }
    return input.url;
  }

  function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = urlOf(input);
    if (url.endsWith("/api/auth/csrf-token")) {
      return Promise.resolve(Response.json({ csrfToken: "test-csrf-token" }));
    }
    if (url.endsWith("/mail.folders.list")) {
      return Promise.resolve(Response.json({ folders: FOLDERS }));
    }
    if (url.endsWith("/mail.labels.list")) {
      return Promise.resolve(Response.json({ labels: LABELS }));
    }
    if (url.endsWith("/mail.threads.list")) {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        readonly folder?: string;
        readonly tab?: string;
        readonly query?: string;
      };
      if (body.folder === "drafts") {
        return Promise.resolve(Response.json({ threads: [], total: 0, limit: 50, offset: 0 }));
      }
      if (body.tab === "updates") {
        return Promise.resolve(
          Response.json({ threads: [UPDATES_ROW], total: 1, limit: 50, offset: 0 }),
        );
      }
      if (body.query === "from:nobody") {
        return Promise.resolve(Response.json({ threads: [], total: 0, limit: 50, offset: 0 }));
      }
      return Promise.resolve(
        Response.json({ threads: [threadRow()], total: 1, limit: 50, offset: 0 }),
      );
    }
    if (url.endsWith("/mail.thread.get")) {
      return Promise.resolve(Response.json({ thread: THREAD_DETAIL }));
    }
    if (url.endsWith("/mail/addresses"))
      return Promise.resolve(
        Response.json({
          actorId: "actor-1",
          primaryEmail: "alex@helix.io",
          eligibleDomains: [],
          addresses: [
            {
              id: null,
              address: "alex@helix.io",
              displayName: "Alex",
              isPrimary: true,
              receiveEnabled: true,
              sendAsEnabled: true,
              source: "primary",
            },
          ],
        }),
      );
    if (url.endsWith("/mail.draft.list")) {
      return Promise.resolve(Response.json({ drafts: [] }));
    }
    if (url.endsWith("/mail.draft.save")) {
      return Promise.resolve(
        Response.json({
          id: "11111111-1111-4111-8111-111111111111",
          revision: 1,
          updatedAt: "2026-05-21T11:00:00.000Z",
        }),
      );
    }
    return Promise.resolve(Response.json({ id: "m1", status: "sent" }));
  }

  beforeEach(() => {
    navigateMock.mockClear();
    uploadDriveFileMock.mockResolvedValue({
      objectId: "33333333-3333-4333-8333-333333333333",
    });
    trashDriveObjectMock.mockResolvedValue(null);
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    fetchMock = vi.fn<typeof fetch>(defaultFetch);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function render() {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ShellOverlayContext.Provider value={overlayApi}>
            <MailShell />
          </ShellOverlayContext.Provider>
        </QueryClientProvider>,
      );
    });
  }

  async function flush() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    }
  }

  function clickButtonText(text: string) {
    const buttons = Array.from(container.querySelectorAll("button"));
    const button =
      buttons.find((candidate) => candidate.textContent?.trim() === text) ??
      buttons.find((candidate) => candidate.textContent?.includes(text));
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Button not found: ${text}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function clickAriaButton(label: string) {
    const button = container.querySelector(`button[aria-label="${label}"]`);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Icon button not found: ${label}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    const setter = Reflect.get(descriptor ?? {}, "set") as
      ((this: HTMLElement, value: string) => void) | undefined;
    if (setter === undefined) {
      throw new Error("value setter not found");
    }
    act(() => {
      Reflect.apply(setter, input, [value]);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("opens the compose modal and sends through the mail.send backend tool", async () => {
    render();
    await flush();
    clickButtonText("Compose");
    await flush();
    expect(container.textContent).toContain("New message");

    const sendButton = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Send",
    );
    expect(sendButton?.disabled).toBe(false);

    const toInput = container.querySelector('input[aria-label="To"]');
    if (!(toInput instanceof HTMLInputElement)) {
      throw new Error("To input not found");
    }
    setInputValue(toInput, "mira@helix.io");

    clickButtonText("Cc");
    const ccInput = container.querySelector('input[aria-label="Cc"]');
    if (ccInput instanceof HTMLInputElement) {
      setInputValue(ccInput, "ops@helix.io");
    }

    const subjectInput = container.querySelector('input[aria-label="Subject"]');
    if (subjectInput instanceof HTMLInputElement) {
      setInputValue(subjectInput, "Hello");
    }

    clickButtonText("Send");
    await flush();

    const sendCall = fetchMock.mock.calls.find((call) => call[0] === "/v1/api/tools/mail.send");
    expect(sendCall).toBeDefined();
    const rawBody = (sendCall?.[1] as RequestInit).body;
    const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as {
      readonly to: ReadonlyArray<{ readonly address: string }>;
      readonly cc: ReadonlyArray<{ readonly address: string }>;
      readonly subject: string;
    };
    expect(body.to).toEqual([{ address: "mira@helix.io" }]);
    expect(body.cc).toEqual([{ address: "ops@helix.io" }]);
    expect(body.subject).toBe("Hello");
    expect(container.textContent).not.toContain("New message");
  });

  it("schedules compose mail through the durable mail.send queue", async () => {
    render();
    await flush();
    clickButtonText("Compose");
    await flush();
    const toInput = container.querySelector('input[aria-label="To"]');
    const scheduleInput = container.querySelector('input[aria-label="Send later"]');
    if (!(toInput instanceof HTMLInputElement) || !(scheduleInput instanceof HTMLInputElement)) {
      throw new Error("Compose scheduling inputs not found");
    }
    setInputValue(toInput, "mira@helix.io");
    const localSendAt = "2026-10-01T12:30";
    setInputValue(scheduleInput, localSendAt);

    clickButtonText("Schedule");
    await flush();

    const sendCall = fetchMock.mock.calls.find((call) => call[0] === "/v1/api/tools/mail.send");
    const rawBody = sendCall?.[1]?.body;
    const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as {
      readonly sendAt?: string;
    };
    expect(body.sendAt).toBe(new Date(localSendAt).toISOString());
  });

  it("validates recipients inline and focuses the first invalid field", async () => {
    render();
    await flush();
    clickButtonText("Compose");
    await flush();

    clickButtonText("Send");
    expect(container.textContent).toContain("Enter at least one recipient email address.");
    expect(document.activeElement).toBe(container.querySelector('input[aria-label="To"]'));

    const toInput = container.querySelector('input[aria-label="To"]');
    if (!(toInput instanceof HTMLInputElement)) throw new Error("To input not found");
    setInputValue(toInput, "not-an-address");
    clickButtonText("Send");

    expect(container.textContent).toContain("To contains invalid email address: not-an-address.");
    expect(toInput.getAttribute("aria-invalid")).toBe("true");
    expect(fetchMock.mock.calls.some((call) => call[0] === "/v1/api/tools/mail.send")).toBe(false);
  });

  it("restores a local draft, minimizes without losing it, and marks unavailable tools", async () => {
    window.localStorage.setItem(
      MAIL_COMPOSE_RECOVERY_KEY,
      JSON.stringify({
        id: "11111111-1111-4111-8111-111111111111",
        expectedRevision: 3,
        to: [{ address: "mira@helix.test" }],
        cc: [],
        bcc: [],
        subject: "Recovered launch note",
        bodyText: "The restored body",
        attachments: [
          {
            objectId: "22222222-2222-4222-8222-222222222222",
            filename: "recovered-brief.pdf",
            contentType: "application/pdf",
          },
        ],
        updatedAt: new Date().toISOString(),
      }),
    );
    render();
    await flush();
    clickButtonText("Compose");
    await flush();

    expect(container.textContent).toContain("Recovered your unsent message from this device.");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="To"]')?.value).toBe(
      "mira@helix.test",
    );
    expect(
      container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message body"]')?.value,
    ).toBe("The restored body");
    expect(container.textContent).toContain("recovered-brief.pdf");
    expect(container.querySelector('button[aria-label="Schedule send unavailable"]')).toBeNull();
    expect(container.querySelector('button[aria-label="AI assist unavailable"]')).toBeNull();

    const minimize = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Minimize compose"]',
    );
    act(() => minimize?.click());
    expect(container.querySelector('textarea[aria-label="Message body"]')).toBeNull();
    expect(container.querySelector(".compose-minimized")).not.toBeNull();

    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Expand compose"]')?.click(),
    );
    expect(
      container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message body"]')?.value,
    ).toBe("The restored body");
  });

  it("confirms explicit draft discard and clears the recovered copy", async () => {
    render();
    await flush();
    clickButtonText("Compose");
    await flush();
    const subject = container.querySelector('input[aria-label="Subject"]');
    if (!(subject instanceof HTMLInputElement)) throw new Error("Subject input not found");
    setInputValue(subject, "Keep this");

    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Close compose"]')?.click(),
    );
    expect(container.textContent).toContain("Discard this draft?");
    expect(container.textContent).toContain("Keep editing");

    clickButtonText("Keep editing");
    expect(container.textContent).toContain("Keep this");
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Discard draft"]')?.click(),
    );
    clickButtonText("Discard draft");
    await flush();

    expect(container.textContent).not.toContain("Keep this");
    expect(window.localStorage.getItem(MAIL_COMPOSE_RECOVERY_KEY)).toBeNull();
  });

  it("restores a local crash draft through the real compose recovery path", async () => {
    writeMailComposeRecovery({
      to: [{ address: "recovered@helix.io" }],
      cc: [{ address: "ops@helix.io" }],
      bcc: [],
      attachments: [],
      subject: "Recovered subject",
      bodyText: "Recovered body from this device",
    });
    expect(window.localStorage.getItem(MAIL_COMPOSE_RECOVERY_KEY)).not.toBeNull();

    render();
    await flush();
    clickButtonText("Compose");
    await flush();

    expect(container.textContent).toContain("Recovered subject");
    expect(container.textContent).toContain("Recovered your unsent message from this device.");
    expect(container.querySelector('input[aria-label="To"]')).toHaveProperty(
      "value",
      "recovered@helix.io",
    );
    expect(container.querySelector('input[aria-label="Subject"]')).toHaveProperty(
      "value",
      "Recovered subject",
    );
    expect(container.querySelector('textarea[aria-label="Message body"]')).toHaveProperty(
      "value",
      "Recovered body from this device",
    );
    expect(fetchMock.mock.calls.some((call) => call[0] === "/v1/api/tools/mail.draft.list")).toBe(
      true,
    );

    clickAriaButton("Dismiss recovery notice");
    expect(container.textContent).not.toContain(
      "Recovered your unsent message from this device. Attachments were not recovered.",
    );
  });

  it("offers a server draft without overwriting a different device draft", async () => {
    const serverDraft = {
      id: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      actorId: "33333333-3333-4333-8333-333333333333",
      threadId: null,
      to: [{ address: "server@example.test" }],
      cc: [],
      bcc: [],
      subject: "Server version",
      bodyText: "Saved elsewhere",
      attachments: [],
      revision: 3,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
    };
    writeMailComposeRecovery({
      to: [{ address: "local@example.test" }],
      cc: [],
      bcc: [],
      subject: "Device version",
      bodyText: "Keep my text",
      attachments: [],
    });
    fetchMock.mockImplementation((input, init) =>
      urlOf(input).endsWith("/mail.draft.list")
        ? Promise.resolve(Response.json({ drafts: [serverDraft] }))
        : defaultFetch(input, init),
    );
    render();
    await flush();
    clickButtonText("Compose");
    await flush();
    expect(container.querySelector('input[aria-label="Subject"]')).toHaveProperty(
      "value",
      "Device version",
    );
    expect(container.textContent).toContain("A different server draft exists");
    clickButtonText("Use server draft");
    await flush();
    expect(container.querySelector('input[aria-label="Subject"]')).toHaveProperty(
      "value",
      "Server version",
    );
    expect(container.querySelector('textarea[aria-label="Message body"]')).toHaveProperty(
      "value",
      "Saved elsewhere",
    );
  });

  it("retries an ambiguous draft creation with the same request before saving newer text", async () => {
    const requests: Record<string, unknown>[] = [];
    fetchMock.mockImplementation((input, init) => {
      if (urlOf(input).endsWith("/mail.draft.save")) {
        requests.push(
          JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>,
        );
        if (requests.length === 1) return Promise.reject(new Error("Response lost"));
      }
      return defaultFetch(input, init);
    });
    render();
    await flush();
    clickButtonText("Compose");
    await flush();
    const body = container.querySelector('textarea[aria-label="Message body"]');
    if (!(body instanceof HTMLTextAreaElement)) throw new Error("Body missing");
    setInputValue(body, "First text");
    await flush();
    act(() => {
      body.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await flush();
    setInputValue(body, "Newer text");
    await flush();
    act(() => {
      body.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await flush();
    expect(requests).toHaveLength(3);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]).toMatchObject({
      bodyText: "Newer text",
      id: "11111111-1111-4111-8111-111111111111",
      expectedRevision: 1,
    });
  });

  it.each([
    { deleted: true, exists: false },
    { deleted: false, exists: true },
    { deleted: false, exists: false },
  ])(
    "discards safely after conflicts and lost responses (deleted=$deleted, exists=$exists)",
    async ({ deleted, exists }) => {
      let discarded: unknown;
      fetchMock.mockImplementation((input, init) => {
        if (urlOf(input).endsWith("/mail.draft.list") && discarded !== undefined)
          return Promise.resolve(
            Response.json({
              drafts: exists ? [{ id: "11111111-1111-4111-8111-111111111111" }] : [],
            }),
          );
        if (urlOf(input).endsWith("/mail.draft.discard")) {
          discarded = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
          return Promise.resolve(Response.json({ deleted }));
        }
        return defaultFetch(input, init);
      });
      render();
      await flush();
      clickButtonText("Compose");
      await flush();
      const body = container.querySelector('textarea[aria-label="Message body"]');
      if (!(body instanceof HTMLTextAreaElement)) throw new Error("Body missing");
      setInputValue(body, "Saved text");
      await flush();
      act(() => {
        body.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      });
      await flush();
      act(() => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Discard draft"]')?.click();
      });
      clickButtonText("Discard draft");
      await flush();
      expect(discarded).toEqual({
        id: "11111111-1111-4111-8111-111111111111",
        expectedRevision: 1,
      });
      if (deleted || !exists)
        expect(container.querySelector('textarea[aria-label="Message body"]')).toBeNull();
      else {
        expect(container.querySelector('textarea[aria-label="Message body"]')).toHaveProperty(
          "value",
          "Saved text",
        );
        expect(container.textContent).toContain("changed elsewhere");
        expect(window.localStorage.getItem(MAIL_COMPOSE_RECOVERY_KEY)).not.toBeNull();
      }
    },
  );

  it("resolves an ambiguous draft save before consuming that draft on send", async () => {
    const requests: unknown[] = [];
    let sent: unknown;
    fetchMock.mockImplementation((input, init) => {
      const payload: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      if (urlOf(input).endsWith("/mail.draft.save")) {
        requests.push(payload);
        if (requests.length === 1) return Promise.reject(new Error("Response lost"));
      }
      if (urlOf(input).endsWith("/mail.send")) sent = payload;
      return defaultFetch(input, init);
    });
    render();
    await flush();
    clickButtonText("Compose");
    await flush();
    const to = container.querySelector('input[aria-label="To"]');
    if (!(to instanceof HTMLInputElement)) throw new Error("Recipient missing");
    setInputValue(to, "draft@helix.io");
    await flush();
    const body = container.querySelector('textarea[aria-label="Message body"]');
    if (!(body instanceof HTMLTextAreaElement)) throw new Error("Body missing");
    setInputValue(body, "Draft body");
    await flush();
    act(() => {
      body.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await flush();
    clickButtonText("Send");
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(sent).toMatchObject({
      draft: { id: "11111111-1111-4111-8111-111111111111", revision: 1 },
    });
  });

  it("saves a server draft through mail.draft.save when compose fields blur", async () => {
    render();
    await flush();
    clickButtonText("Compose");
    await flush();

    // Wait for server reconcile so draft-save blur handlers run against stable state.
    expect(container.textContent).not.toContain("Checking server drafts for conflicts");

    const toInput = container.querySelector('input[aria-label="To"]');
    if (!(toInput instanceof HTMLInputElement)) {
      throw new Error("To input not found");
    }
    const subjectInput = container.querySelector('input[aria-label="Subject"]');
    if (!(subjectInput instanceof HTMLInputElement)) {
      throw new Error("Subject input not found");
    }
    const bodyInput = container.querySelector('textarea[aria-label="Message body"]');
    if (!(bodyInput instanceof HTMLTextAreaElement)) {
      throw new Error("Body textarea not found");
    }

    setInputValue(toInput, "draft@helix.io");
    setInputValue(subjectInput, "Draft subject");
    setInputValue(bodyInput, "Draft body");
    await flush();

    // React listens for focusout (delegated onBlur). Move focus into the body,
    // then out to To so the body onBlur={saveDraft} handler runs.
    act(() => {
      bodyInput.focus();
      bodyInput.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    act(() => {
      toInput.focus();
      bodyInput.dispatchEvent(
        new FocusEvent("focusout", { bubbles: true, relatedTarget: toInput }),
      );
      bodyInput.dispatchEvent(new FocusEvent("blur", { bubbles: true, relatedTarget: toInput }));
    });
    await flush();

    const draftSaveCall = fetchMock.mock.calls.find((call) => {
      const url = typeof call[0] === "string" ? call[0] : "";
      return url.endsWith("/mail.draft.save");
    });
    expect(draftSaveCall).toBeDefined();
    const rawBody = (draftSaveCall?.[1] as RequestInit).body;
    const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as {
      readonly to: ReadonlyArray<{ readonly address: string }>;
      readonly subject: string;
      readonly bodyText: string;
    };
    expect(body.to).toEqual([{ address: "draft@helix.io" }]);
    expect(body.subject).toBe("Draft subject");
    expect(body.bodyText).toBe("Draft body");
  });

  /* ----------------------------------------------------------------- compose: drag-and-drop */

  /**
   * Helper: build a minimal drag event that jsdom accepts.
   * jsdom does not expose `DragEvent` as a global, so we use
   * `document.createEvent("Event")` and annotate it manually.
   * We only stub the subset the Compose handler reads (`files`, `dropEffect`).
   */
  function makeDragEvent(type: string, files: File[], target: Element): Event {
    const dataTransfer = {
      files: Object.assign([...files], {
        item: (index: number) => files[index] ?? null,
        length: files.length,
      }),
      dropEffect: "none" as string,
      effectAllowed: "all" as string,
      items: { length: files.length },
      types: [] as string[],
      clearData: () => undefined,
      getData: () => "",
      setData: () => undefined,
      setDragImage: () => undefined,
    };

    const event = document.createEvent("Event");
    event.initEvent(type, /* bubbles */ true, /* cancelable */ true);
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer, writable: false });
    Object.defineProperty(event, "target", { value: target, writable: false });
    return event;
  }

  /** Resolves all pending microtasks / timers (including FileReader callbacks). */
  async function flushMicrotasks() {
    for (let i = 0; i < 20; i += 1) {
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    }
  }

  it("shows the drop overlay when files are dragged over the open Compose modal", async () => {
    render();
    await flush();
    clickButtonText("Compose");
    await flush();
    expect(container.textContent).toContain("New message");

    const compose = container.querySelector(".compose-drop-root");
    if (!(compose instanceof HTMLElement)) {
      throw new Error("Compose root not found");
    }

    // Overlay should not be visible before dragging.
    expect(container.querySelector(".compose-drop-overlay")).toBeNull();

    act(() => {
      compose.dispatchEvent(makeDragEvent("dragenter", [new File(["hi"], "hello.txt")], compose));
    });
    expect(container.querySelector(".compose-drop-overlay")).not.toBeNull();
    expect(container.textContent).toContain("Drop files to attach");

    act(() => {
      compose.dispatchEvent(makeDragEvent("dragleave", [], compose));
    });
    // Counter reaches 0 — overlay dismissed.
    expect(container.querySelector(".compose-drop-overlay")).toBeNull();
  });

  it("attaches dropped files through the same sendMail mechanism", async () => {
    const fileContent = "hello attachment";
    render();
    await flush();
    clickButtonText("Compose");
    await flush();

    const compose = container.querySelector(".compose-drop-root");
    if (!(compose instanceof HTMLElement)) {
      throw new Error("Compose root not found");
    }

    const droppedFile = new File([fileContent], "report.pdf", {
      type: "application/pdf",
    });

    // Simulate drop sequence: dragenter → dragover → drop
    act(() => {
      compose.dispatchEvent(makeDragEvent("dragenter", [droppedFile], compose));
    });
    act(() => {
      compose.dispatchEvent(makeDragEvent("dragover", [droppedFile], compose));
    });
    act(() => {
      compose.dispatchEvent(makeDragEvent("drop", [droppedFile], compose));
    });

    // Wait for the direct-to-storage upload → state update chain.
    await flushMicrotasks();
    expect(uploadDriveFileMock).toHaveBeenCalledWith({
      file: droppedFile,
      folderId: null,
      signal: expect.any(AbortSignal),
    });

    // Attachment chip should appear.
    expect(container.textContent).toContain("report.pdf");

    // Overlay should be gone after drop.
    expect(container.querySelector(".compose-drop-overlay")).toBeNull();

    // Now send the message; the attachment must be included in the API call.
    const toInput = container.querySelector('input[aria-label="To"]');
    if (!(toInput instanceof HTMLInputElement)) {
      throw new Error("To input not found");
    }
    setInputValue(toInput, "mira@helix.io");
    await flushMicrotasks();
    clickButtonText("Send");
    await flush();

    const sendCall = fetchMock.mock.calls.find((call) => call[0] === "/v1/api/tools/mail.send");
    expect(sendCall).toBeDefined();
    const rawBody = (sendCall?.[1] as RequestInit).body;
    const parsedBody = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as {
      readonly attachments?: ReadonlyArray<{
        readonly filename: string;
        readonly contentType: string;
        readonly objectId: string;
      }>;
    };
    expect(parsedBody.attachments).toBeDefined();
    expect(parsedBody.attachments).toHaveLength(1);
    expect(parsedBody.attachments?.[0]?.filename).toBe("report.pdf");
    expect(parsedBody.attachments?.[0]?.contentType).toBe("application/pdf");
    expect(parsedBody.attachments?.[0]?.objectId).toBe("33333333-3333-4333-8333-333333333333");
    expect(parsedBody.attachments?.[0]).not.toHaveProperty("byteSize");
  });

  it("rejects an oversized selection before upload and cancels an active upload", async () => {
    render();
    await flush();
    clickButtonText("Compose");
    await flush();
    const compose = container.querySelector(".compose-drop-root");
    if (!(compose instanceof HTMLElement)) throw new Error("Compose root not found");

    const oversized = new File(["x"], "huge.bin");
    Object.defineProperty(oversized, "size", { value: 25 * 1024 * 1024 + 1 });
    act(() => {
      compose.dispatchEvent(makeDragEvent("drop", [oversized], compose));
    });
    await flushMicrotasks();
    expect(uploadDriveFileMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("per-file limit");

    let uploadSignal: AbortSignal | undefined;
    uploadDriveFileMock.mockImplementationOnce(
      ({ signal }: { readonly signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          uploadSignal = signal;
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    act(() => {
      compose.dispatchEvent(makeDragEvent("drop", [new File(["ok"], "ok.txt")], compose));
    });
    await flushMicrotasks();
    clickButtonText("Cancel attachment upload");
    await flushMicrotasks();
    expect(uploadSignal?.aborted).toBe(true);
    expect(container.textContent).toContain("selecting the same file will resume it");
  });

  it("does not flicker the drop overlay when the cursor crosses child elements", async () => {
    render();
    await flush();
    clickButtonText("Compose");
    await flush();

    const compose = container.querySelector(".compose-drop-root");
    if (!(compose instanceof HTMLElement)) {
      throw new Error("Compose root not found");
    }

    const file = new File(["x"], "x.txt");

    // Simulate cursor entering the compose root, then entering a child (fires
    // another dragenter + dragleave on the parent per bubbling semantics).
    act(() => {
      compose.dispatchEvent(makeDragEvent("dragenter", [file], compose)); // depth → 1
    });
    expect(container.querySelector(".compose-drop-overlay")).not.toBeNull();

    act(() => {
      compose.dispatchEvent(makeDragEvent("dragenter", [file], compose)); // depth → 2
    });
    act(() => {
      compose.dispatchEvent(makeDragEvent("dragleave", [file], compose)); // depth → 1
    });
    // Depth is 1, so the overlay must still be visible.
    expect(container.querySelector(".compose-drop-overlay")).not.toBeNull();

    act(() => {
      compose.dispatchEvent(makeDragEvent("dragleave", [file], compose)); // depth → 0
    });
    expect(container.querySelector(".compose-drop-overlay")).toBeNull();
  });
});
