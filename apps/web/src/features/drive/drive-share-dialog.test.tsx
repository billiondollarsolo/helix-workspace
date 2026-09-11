// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriveShareDialog } from "./drive-share-dialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("DriveShareDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let toolCalls: Array<{ readonly url: string; readonly body: unknown }>;
  let clipboardWriteText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    toolCalls = [];
    clipboardWriteText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (url !== "/v1/api/auth/get-session" && url !== "/v1/api/auth/csrf-token") {
        toolCalls.push({ url, body });
      }
      if (url === "/v1/api/auth/csrf-token") {
        return Promise.resolve(Response.json({ csrfToken: "test-csrf" }));
      }
      if (url === "/v1/api/auth/get-session") {
        return Promise.resolve(
          Response.json({
            user: {
              id: "session-user",
              email: "owner@helix.local",
              name: "Owner One",
              actorId: "owner-1",
            },
          }),
        );
      }
      if (url === "/v1/api/tools/drive.access.list") {
        return Promise.resolve(
          Response.json({
            grants: [
              {
                actorId: "66666666-6666-4666-8666-666666666666",
                role: "reader",
                displayName: "Maya Chen",
                email: "maya@helix.local",
                grantedByActorId: "owner-1",
                expiresAt: null,
                createdAt: "2026-05-20T12:00:00.000Z",
                updatedAt: "2026-05-20T12:00:00.000Z",
              },
            ],
          }),
        );
      }
      if (url === "/v1/api/tools/drive.share") {
        return Promise.resolve(Response.json({ shared: true }));
      }
      if (url === "/v1/api/tools/drive.access.update") {
        return Promise.resolve(
          Response.json({
            objectId: "file-1",
            actorId: "66666666-6666-4666-8666-666666666666",
            grant: null,
          }),
        );
      }
      if (url === "/v1/api/tools/drive.access.remove") {
        return Promise.resolve(
          Response.json({
            objectId: "file-1",
            actorId: "66666666-6666-4666-8666-666666666666",
            removed: true,
          }),
        );
      }
      if (url === "/v1/api/tools/drive.link.create") {
        return Promise.resolve(
          Response.json({
            id: "55555555-5555-4555-8555-555555555555",
            orgId: "11111111-1111-4111-8111-111111111111",
            objectId: "file-1",
            token: "p".repeat(43),
            role: "reader",
            expiresAt: null,
            passwordProtected: true,
            oneTime: false,
            allowedDomains: ["example.test"],
            allowDownload: true,
            consumedAt: null,
            createdByActorId: "owner-1",
            createdAt: "2026-05-20T12:00:00.000Z",
            revokedAt: null,
          }),
        );
      }
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  it("shares by email/name refs and actor ids, then refreshes access", async () => {
    render();
    await settle();

    setInput(
      "Email, name, or actor ID",
      "maya@helix.local 66666666-6666-4666-8666-666666666666 Maya",
    );
    setSelect("Share role", "commenter");
    clickButton("Share");
    await settle();

    expect(toolCalls.find((call) => call.url === "/v1/api/tools/drive.share")?.body).toEqual({
      objectId: "file-1",
      actorIds: ["66666666-6666-4666-8666-666666666666"],
      actorRefs: ["maya@helix.local", "Maya"],
      role: "commenter",
      expiresAt: null,
      notify: true,
    });
    expect(container.textContent).toContain("People with access");
    expect(container.textContent).toContain("Maya Chen");
  });

  it("updates, removes, and copies links from the same dialog", async () => {
    render();
    await settle();

    setSelect("Access role for Maya Chen", "editor");
    clickButton("Remove access for Maya Chen");
    clickButton("Copy link");
    await settle();

    expect(
      toolCalls.find((call) => call.url === "/v1/api/tools/drive.access.update")?.body,
    ).toEqual({
      objectId: "file-1",
      actorId: "66666666-6666-4666-8666-666666666666",
      role: "editor",
      expiresAt: null,
    });
    expect(
      toolCalls.find((call) => call.url === "/v1/api/tools/drive.access.remove")?.body,
    ).toEqual({
      objectId: "file-1",
      actorId: "66666666-6666-4666-8666-666666666666",
    });
    expect(clipboardWriteText).toHaveBeenCalledWith("http://localhost/drive/file-1");
  });

  it("loads the access list when opened after mounting closed", async () => {
    render(false);
    await settle();

    expect(toolCalls.some((call) => call.url === "/v1/api/tools/drive.access.list")).toBe(false);

    render(true);
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/v1/api/tools/drive.access.list",
      body: { objectId: "file-1" },
    });
    expect(container.textContent).toContain("Maya Chen");
  });

  it("creates a reader-only governed public link", async () => {
    render();
    await settle();

    setInput("Optional password (12+ characters)", "correct horse battery staple");
    setInput("Optional domains, comma separated", "Example.Test");
    clickButton("Create public link");
    await settle();

    expect(toolCalls.find((call) => call.url === "/v1/api/tools/drive.link.create")?.body).toEqual({
      objectId: "file-1",
      password: "correct horse battery staple",
      expiresAt: null,
      oneTime: false,
      allowedDomains: ["example.test"],
      allowDownload: true,
    });
    expect(clipboardWriteText).toHaveBeenCalledWith(
      `http://localhost:3000/v1/api/drive/share/${"p".repeat(43)}`,
    );
  });

  it("opens the share dialog, grants access, then revokes the grant through real handlers", async () => {
    const mayaGrant = {
      actorId: "66666666-6666-4666-8666-666666666666",
      role: "reader",
      displayName: "Maya Chen",
      email: "maya@helix.local",
      grantedByActorId: "owner-1",
      expiresAt: null,
      createdAt: "2026-05-20T12:00:00.000Z",
      updatedAt: "2026-05-20T12:00:00.000Z",
    };
    const danielGrant = {
      actorId: "77777777-7777-4777-8777-777777777777",
      role: "commenter",
      displayName: "Daniel Cho",
      email: "daniel@helix.local",
      grantedByActorId: "owner-1",
      expiresAt: null,
      createdAt: "2026-05-20T12:02:00.000Z",
      updatedAt: "2026-05-20T12:02:00.000Z",
    };
    let grants: readonly (typeof mayaGrant)[] = [mayaGrant];

    fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (url !== "/v1/api/auth/get-session") {
        toolCalls.push({ url, body });
      }
      if (url === "/v1/api/auth/get-session") {
        return Promise.resolve(
          Response.json({
            user: {
              id: "session-user",
              email: "owner@helix.local",
              name: "Owner One",
              actorId: "owner-1",
            },
          }),
        );
      }
      if (url === "/v1/api/tools/drive.access.list") {
        return Promise.resolve(Response.json({ grants: [...grants] }));
      }
      if (url === "/v1/api/tools/drive.share") {
        grants = [mayaGrant, danielGrant];
        return Promise.resolve(Response.json({ shared: true }));
      }
      if (url === "/v1/api/tools/drive.access.remove") {
        const actorId = (body as { actorId?: string }).actorId;
        grants = grants.filter((grant) => grant.actorId !== actorId);
        return Promise.resolve(
          Response.json({
            objectId: "file-1",
            actorId,
            removed: true,
          }),
        );
      }
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal("fetch", fetchMock);

    // Mount closed first so open drives access.list (not a stale pre-open fetch).
    render(false);
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    render(true);
    await settle();

    const dialog = container.querySelector('[role="dialog"][aria-label="Share Launch plan"]');
    expect(dialog).not.toBeNull();
    expect(container.textContent ?? "").toContain("People with access");
    expect(container.textContent ?? "").toContain("Maya Chen");
    expect(toolCalls.some((call) => call.url === "/v1/api/tools/drive.access.list")).toBe(true);

    setInput("Email, name, or actor ID", "daniel@helix.local");
    setSelect("Share role", "commenter");
    clickButton("Share");
    await settle();

    expect(toolCalls.find((call) => call.url === "/v1/api/tools/drive.share")?.body).toEqual({
      objectId: "file-1",
      actorIds: [],
      actorRefs: ["daniel@helix.local"],
      role: "commenter",
      expiresAt: null,
      notify: true,
    });
    expect(container.textContent ?? "").toContain("Access granted.");
    expect(container.textContent ?? "").toContain("Daniel Cho");

    clickButton("Remove access for Maya Chen");
    await settle();

    expect(
      toolCalls.find((call) => call.url === "/v1/api/tools/drive.access.remove")?.body,
    ).toEqual({
      objectId: "file-1",
      actorId: "66666666-6666-4666-8666-666666666666",
    });
    expect(container.textContent ?? "").not.toContain("Maya Chen");
    expect(container.textContent ?? "").toContain("Daniel Cho");
  });

  it("can share without notifying people", async () => {
    render();
    await settle();
    const notify = container.querySelector<HTMLInputElement>('input[aria-label="Notify people"]');
    expect(notify).not.toBeNull();
    act(() => {
      notify?.click();
    });
    setInput("Email, name, or actor ID", "maya@helix.local");
    clickButton("Share");
    await settle();
    expect(toolCalls.find((call) => call.url === "/v1/api/tools/drive.share")?.body).toMatchObject({
      notify: false,
    });
  });

  it("includes an optional message when notifying people", async () => {
    render();
    await settle();
    setInput("Email, name, or actor ID", "maya@helix.local");
    const message = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Share message"]',
    );
    expect(message).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(message, "Please review page two.");
      message?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    clickButton("Share");
    await settle();
    expect(toolCalls.find((call) => call.url === "/v1/api/tools/drive.share")?.body).toMatchObject({
      notify: true,
      message: "Please review page two.",
    });
  });

  function render(open = true) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DriveShareDialog
            objectId="file-1"
            objectName="Launch plan"
            ownerActorId="owner-1"
            open={open}
            shareUrl="http://localhost/drive/file-1"
            onOpenChange={() => undefined}
          />
        </QueryClientProvider>,
      );
    });
  }

  async function settle() {
    for (let index = 0; index < 20; index += 1) {
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    }
  }

  function setInput(label: string, value: string) {
    const target = container.querySelector<HTMLInputElement>(`input[placeholder="${label}"]`);
    if (target === null) {
      throw new Error(`Missing input: ${label}`);
    }
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(target, value);
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  function setSelect(label: string, value: string) {
    const target = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
    if (target === null) {
      throw new Error(`Missing select: ${label}`);
    }
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(target, value);
      target.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  function clickButton(label: string) {
    const target =
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) =>
          button.textContent.includes(label) || button.getAttribute("aria-label") === label,
      ) ?? null;
    if (target === null) {
      throw new Error(`Missing button: ${label}`);
    }
    act(() => {
      target.click();
    });
  }
});
