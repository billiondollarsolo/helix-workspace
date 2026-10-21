// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as authModule from "@/lib/auth";
import { renderWithClient, setReactInputValue, waitForText } from "@/test/meet";
import { axeViolations, settle } from "@/test/ui";
import { InviteGuestDialog } from "./meet-call-invite";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Records each request; the create tool answers with a pending confirmation. */
function mockServer() {
  return vi.spyOn(authModule, "authenticatedFetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "/api/tools/meet.guests.set-allowed") {
      return Promise.resolve(Response.json({ allowed: true }));
    }
    if (url === "/api/tools/meet.guest-invite.create") {
      return Promise.resolve(
        Response.json({ status: "pending_confirmation", pending: { id: "pending-1" } }),
      );
    }
    if (url === "/api/tools/pending/pending-1/approve") {
      return Promise.resolve(
        Response.json({
          status: "executed",
          output: { invite: { id: "invite-1" }, token: "signed.token" },
        }),
      );
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });
}

describe("InviteGuestDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  const field = () => document.querySelector<HTMLInputElement>('input[type="email"]');
  const button = (text: string) =>
    [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === text) ??
    null;

  it("allows guests, then creates the invitation and shows a fragment link", async () => {
    const spy = mockServer();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderWithClient(<InviteGuestDialog roomId="room-1" onClose={() => undefined} />, root);
    await settle();

    act(() => {
      setReactInputValue(field()!, "vera@example.com");
    });
    act(() => button("Create link")?.click());
    await waitForText(document.body, "Only vera@example.com can use this link.");

    const urls = spy.mock.calls.map(([input]) => input);
    expect(urls).toEqual([
      "/api/tools/meet.guests.set-allowed",
      "/api/tools/meet.guest-invite.create",
      "/api/tools/pending/pending-1/approve",
    ]);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ roomId: "room-1", allowed: true }),
    });
    expect(spy.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({
        roomId: "room-1",
        email: "vera@example.com",
        expiresInSeconds: 86400,
      }),
    });

    const link = `${window.location.origin}/meet/guest#signed.token`;
    expect(document.querySelector<HTMLInputElement>("input[readonly]")?.value).toBe(link);
    expect(document.body.textContent).toContain("It expires in 24 hours.");
    expect(await axeViolations()).toEqual([]);

    act(() => button("Copy")?.click());
    await settle();
    expect(writeText).toHaveBeenCalledWith(link);
  });

  it("asks for a valid email before calling the server", async () => {
    const spy = mockServer();
    renderWithClient(<InviteGuestDialog roomId="room-1" onClose={() => undefined} />, root);
    await settle();
    act(() => {
      setReactInputValue(field()!, "not-an-email");
    });
    act(() => button("Create link")?.click());
    await settle();
    expect(document.body.textContent).toContain("Enter an email address.");
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows the server's reason when the link can't be created", async () => {
    vi.spyOn(authModule, "authenticatedFetch").mockResolvedValue(
      Response.json({ error: "Only a host or co-host can change guest access." }, { status: 400 }),
    );
    renderWithClient(<InviteGuestDialog roomId="room-1" onClose={() => undefined} />, root);
    await settle();
    act(() => {
      setReactInputValue(field()!, "vera@example.com");
    });
    act(() => button("Create link")?.click());
    await waitForText(document.body, "Only a host or co-host can change guest access.");
  });
});
