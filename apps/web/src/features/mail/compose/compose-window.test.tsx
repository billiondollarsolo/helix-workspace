// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyOptions } from "@/components/ui/toast";
import { axeViolations, key, unmountAll } from "@/test/ui";
import { ComposeHost } from "./compose-host";
import { openCompose, resetComposeWindows } from "./compose-store";
import {
  addRecipient,
  buttonByText,
  byLabel,
  click,
  openMenu,
  renderWithClient,
  settle,
  sleep,
  typeBody,
  typeInto,
  waitFor,
} from "@/test/mail-compose";

const api = vi.hoisted(() => ({
  sendMail: vi.fn(),
  saveMailDraft: vi.fn(),
  discardMailDraft: vi.fn(),
  getMailDraft: vi.fn(),
  cancelOutboundMail: vi.fn(),
  cancelScheduledMail: vi.fn(),
  replyToMail: vi.fn(),
  forwardMail: vi.fn(),
}));
const toasts = vi.hoisted(() => ({ notify: vi.fn<(options: NotifyOptions) => string>() }));
const router = vi.hoisted(() => {
  const search: Record<string, unknown> = {};
  return { navigate: vi.fn(), search };
});
const drive = vi.hoisted(() => ({ upload: vi.fn(), trash: vi.fn(), status: vi.fn() }));

vi.mock("../api", async (original) => ({ ...(await original<object>()), ...api }));
vi.mock("@/components/ui/toast", () => ({ notify: toasts.notify }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => router.navigate,
  useSearch: () => router.search,
}));
vi.mock("@/features/people/api", () => ({
  usePeopleSearch: () => ({ people: [], loading: false, error: false }),
}));
vi.mock("@/features/drive/api", () => ({
  trashDriveObject: drive.trash,
  getDriveUploadStatus: drive.status,
}));
vi.mock("@/features/drive/upload", () => ({ uploadDriveFile: drive.upload }));

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const OUTBOUND_ID = "22222222-2222-4222-8222-222222222222";

function lastToast(): NotifyOptions {
  const options = toasts.notify.mock.calls.at(-1)?.[0];
  if (options === undefined) throw new Error("No toast");
  return options;
}

function windows() {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-compose-window]"));
}

async function openNew(init: Parameters<typeof openCompose>[0] = {}) {
  renderWithClient(<ComposeHost />);
  act(() => {
    openCompose(init);
  });
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  router.search = {};
  api.saveMailDraft.mockImplementation(
    (input: { readonly id?: string; readonly expectedRevision?: number }) =>
      Promise.resolve({ id: input.id ?? DRAFT_ID, revision: (input.expectedRevision ?? 0) + 1 }),
  );
  api.discardMailDraft.mockResolvedValue(true);
  api.sendMail.mockResolvedValue({
    id: OUTBOUND_ID,
    threadId: "thread-9",
    undoUntil: new Date(Date.now() + 30_000).toISOString(),
  });
  api.cancelOutboundMail.mockResolvedValue({ id: OUTBOUND_ID, status: "cancelled" });
  drive.status.mockResolvedValue({ terminal: true, available: true, label: "Available" });
});

afterEach(() => {
  act(() => {
    resetComposeWindows();
  });
  unmountAll();
});

describe("compose window", () => {
  it("opens a blank New Message without loading any saved draft", async () => {
    await openNew();
    const [window] = windows();
    expect(window?.getAttribute("role")).toBe("dialog");
    expect(byLabel("Subject", window).getAttribute("value") ?? "").toBe("");
    expect(byLabel("Message body", window).innerHTML).toBe("");
    expect(window?.querySelector(".compose-title")?.textContent).toBe("New message");
    expect(window?.textContent).not.toMatch(/recovered|different server draft/iu);
    expect(api.getMailDraft).not.toHaveBeenCalled();
    // Focus starts in To for a new message.
    await waitFor(() => document.activeElement?.getAttribute("role") === "combobox", "To focused");
    expect(await axeViolations(window)).toEqual([]);
  });

  it("resumes a draft from Drafts by id and keeps saving to the same draft", async () => {
    api.getMailDraft.mockResolvedValue({
      id: DRAFT_ID,
      orgId: "o",
      actorId: "a",
      threadId: null,
      to: [{ address: "samara@example.com", name: "Samara" }],
      cc: [{ address: "lee@example.com" }],
      bcc: [],
      subject: "Budget",
      bodyText: "Numbers attached",
      bodyHtml: "<div>Numbers <b>attached</b><script>alert(1)</script></div>",
      attachments: [],
      revision: 4,
      expiresAt: "2026-12-01T00:00:00.000Z",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    await openNew({ draftId: DRAFT_ID });
    await waitFor(() => document.querySelector('[aria-label="Subject"]') !== null);
    expect(api.getMailDraft).toHaveBeenCalledWith(DRAFT_ID);
    expect(byLabel<HTMLInputElement>("Subject").value).toBe("Budget");
    expect(byLabel("Message body").innerHTML).toBe("<div>Numbers <b>attached</b></div>");
    expect(document.body.textContent).toContain("Samara");
    expect(byLabel("Cc recipients")).toBeTruthy();

    typeInto(byLabel<HTMLInputElement>("Subject"), "Budget v2");
    await sleep(1_600);
    await waitFor(() => api.saveMailDraft.mock.calls.length > 0, "autosave");
    expect(api.saveMailDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: DRAFT_ID, expectedRevision: 4, subject: "Budget v2" }),
    );
    await waitFor(() => document.body.textContent?.includes("Draft saved") === true);
  });

  it("shows recipients as chips and blocks sending to an invalid address with a clear fix", async () => {
    await openNew({ to: "Samara <samara@example.com>, not-an-address" });
    const chips = byLabel("To recipients");
    expect(chips.textContent).toContain("Samara");
    expect(chips.textContent).toContain("not-an-address");
    click(buttonByText("Send"));
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      `To: "not-an-address" isn't a valid email address. Edit or remove it.`,
    );
    expect(api.sendMail).not.toHaveBeenCalled();
  });

  it("asks for a recipient before sending", async () => {
    await openNew();
    click(buttonByText("Send"));
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Add at least one recipient.",
    );
  });

  it("reveals Cc and Bcc from the To row", async () => {
    await openNew();
    expect(document.querySelector('[aria-label="Cc recipients"]')).toBeNull();
    click(byLabel("Add Cc recipients"));
    click(byLabel("Add Bcc recipients"));
    await settle();
    addRecipient("Cc", "lee@example.com");
    addRecipient("Bcc", "audit@example.com");
    expect(byLabel("Cc recipients").textContent).toContain("lee@example.com");
    expect(byLabel("Bcc recipients").textContent).toContain("audit@example.com");
  });

  it("sends, closes, and offers Undo that reopens the message", async () => {
    await openNew({ to: "samara@example.com", subject: "Lunch" });
    typeBody("<div>Noon works</div>");
    click(buttonByText("Send"));
    await waitFor(() => api.sendMail.mock.calls.length === 1);
    expect(api.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: [{ address: "samara@example.com" }],
        subject: "Lunch",
        bodyText: "Noon works",
        bodyHtml: "<div>Noon works</div>",
      }),
    );
    await waitFor(() => windows().length === 0, "window closes");
    const toast = lastToast();
    expect(toast.message).toBe("Message sent");
    expect(toast.action?.label).toBe("Undo");
    expect(toast.secondaryAction?.label).toBe("View message");

    toast.secondaryAction?.onAction();
    expect(router.navigate).toHaveBeenCalledWith({ to: "/mail", search: { thread: "thread-9" } });

    act(() => {
      toast.action?.onAction();
    });
    await waitFor(() => windows().length === 1, "reopened");
    expect(api.cancelOutboundMail).toHaveBeenCalledWith(OUTBOUND_ID);
    expect(byLabel<HTMLInputElement>("Subject").value).toBe("Lunch");
    expect(lastToast().message).toBe("Sending undone");
  });

  it("explains when Undo comes too late", async () => {
    api.cancelOutboundMail.mockResolvedValue(null);
    await openNew({ to: "samara@example.com", subject: "Late" });
    click(buttonByText("Send"));
    await waitFor(() => toasts.notify.mock.calls.length === 1);
    act(() => {
      lastToast().action?.onAction();
    });
    await waitFor(() => toasts.notify.mock.calls.length === 2);
    expect(lastToast()).toMatchObject({
      tone: "error",
      message: "Too late to undo. The message was already sent.",
    });
    expect(windows()).toHaveLength(0);
  });

  it("schedules from the Send menu and links to Scheduled", async () => {
    await openNew({ to: "samara@example.com", subject: "Later" });
    await openMenu(byLabel("More send options"));
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain("Schedule send");
    expect(menu?.textContent).toContain("Tomorrow morning");
    expect(menu?.textContent).toContain("Tomorrow afternoon");
    expect(menu?.textContent).toContain("Pick date & time");
    const morning = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) =>
      item.textContent?.startsWith("Tomorrow morning"),
    );
    act(() => {
      (morning as HTMLElement).focus();
    });
    await key("Enter");
    await waitFor(() => api.sendMail.mock.calls.length === 1);
    const input = api.sendMail.mock.calls[0]?.[0] as { readonly sendAt: string };
    expect(new Date(input.sendAt).getUTCHours()).toBe(8);
    await waitFor(() => toasts.notify.mock.calls.length === 1);
    expect(lastToast().message).toMatch(/^Send scheduled for /u);
    lastToast().secondaryAction?.onAction();
    expect(router.navigate).toHaveBeenCalledWith({ to: "/mail", search: { folder: "scheduled" } });
  });

  it("minimizes to the title bar and expands to a full-size dialog", async () => {
    await openNew({ subject: "Notes" });
    const [window] = windows();
    click(byLabel("Minimize", window));
    expect(window?.getAttribute("data-minimized")).toBe("true");
    expect(window?.querySelector(".compose-content")?.hasAttribute("hidden")).toBe(true);
    click(byLabel("Restore", window));
    expect(window?.hasAttribute("data-minimized")).toBe(false);

    click(byLabel("Full screen", window));
    expect(window?.getAttribute("aria-modal")).toBe("true");
    expect(document.querySelector(".compose-backdrop")).not.toBeNull();
    // Escape leaves full screen first, then closes (keeping the draft).
    byLabel<HTMLInputElement>("Subject", window).focus();
    await key("Escape");
    expect(window?.getAttribute("aria-modal")).toBe("false");
    await key("Escape");
    await waitFor(() => windows().length === 0);
    expect(api.saveMailDraft).toHaveBeenCalledWith(expect.objectContaining({ subject: "Notes" }));
  });

  it("stacks several windows and only one is full size", async () => {
    renderWithClient(<ComposeHost />);
    act(() => {
      openCompose({ subject: "First" });
      openCompose({ subject: "Second" });
    });
    await settle();
    expect(windows()).toHaveLength(2);
    click(byLabel("Full screen", windows()[0]));
    click(byLabel("Full screen", windows()[1]));
    expect(windows().filter((window) => window.getAttribute("aria-modal") === "true")).toHaveLength(
      1,
    );
  });

  it("discards right away with Undo", async () => {
    await openNew({ to: "samara@example.com", subject: "Oops" });
    await sleep(1_600);
    await waitFor(() => api.saveMailDraft.mock.calls.length > 0, "autosave");
    click(byLabel("Discard draft"));
    await waitFor(() => api.discardMailDraft.mock.calls.length === 1);
    expect(api.discardMailDraft).toHaveBeenCalledWith({ id: DRAFT_ID, expectedRevision: 1 });
    expect(windows()).toHaveLength(0);
    expect(lastToast().message).toBe("Draft discarded");
    act(() => {
      lastToast().action?.onAction();
    });
    await settle();
    expect(byLabel<HTMLInputElement>("Subject").value).toBe("Oops");
  });

  it("opens from a /mail?compose=new&to= handoff link", async () => {
    router.search = { compose: "new", to: "samara@example.com" };
    renderWithClient(<ComposeHost />);
    await settle();
    expect(windows()).toHaveLength(1);
    expect(byLabel("To recipients").textContent).toContain("samara@example.com");
    expect(router.navigate).toHaveBeenCalledWith(expect.objectContaining({ replace: true }));
  });

  it("shows upload progress and the malware scan result on attachment chips", async () => {
    let finishUpload: (value: { readonly objectId: string }) => void = () => undefined;
    drive.upload.mockReturnValue(
      new Promise((resolve) => {
        finishUpload = resolve;
      }),
    );
    drive.status.mockResolvedValue({ terminal: true, available: false, label: "Quarantined" });
    await openNew({ to: "samara@example.com" });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(["x".repeat(4_000)], "report.pdf", { type: "application/pdf" });
    act(() => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(byLabel("Attachments").textContent).toContain("Uploading 0%");
    const progress = () => document.querySelector('[role="progressbar"]');
    expect(progress()?.getAttribute("aria-valuenow")).toBe("0");
    const { onProgress } = drive.upload.mock.calls.at(-1)?.[0] as {
      readonly onProgress: (loaded: number, total: number) => void;
    };
    act(() => {
      onProgress(1_000, 4_000);
    });
    expect(byLabel("Attachments").textContent).toContain("Uploading 25%");
    expect(progress()?.getAttribute("aria-valuenow")).toBe("25");
    act(() => {
      finishUpload({ objectId: "33333333-3333-4333-8333-333333333333" });
    });
    await waitFor(() => byLabel("Attachments").textContent?.includes("Quarantined") === true);
    click(buttonByText("Send"));
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Remove report.pdf to send: Quarantined.",
    );
    expect(api.sendMail).not.toHaveBeenCalled();
  });
});
