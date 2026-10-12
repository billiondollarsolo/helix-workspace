// @vitest-environment jsdom

/* Invite people: client-side address check, then one invitation per submit
 * with the chosen role, and a refreshed Users directory. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserInviteDialog } from "./user-invite-dialog";

const { inviteAdminUser, notify } = vi.hoisted(() => ({
  inviteAdminUser: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@/features/admin/admin-users", async (original) => ({
  ...(await original<object>()),
  inviteAdminUser,
}));
vi.mock("@/components/ui/toast", async (original) => ({
  ...(await original<object>()),
  notify,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let onClose: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  onClose = vi.fn<() => void>();
  inviteAdminUser.mockReset();
  notify.mockReset();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  client.clear();
  container.remove();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <UserInviteDialog onClose={onClose} />
      </QueryClientProvider>,
    );
    await Promise.resolve();
  });
}

function field<T extends HTMLInputElement | HTMLSelectElement>(label: string): T {
  const match = [...document.querySelectorAll("label")].find(
    (element) => element.querySelector("span")?.textContent === label,
  );
  const control = match?.querySelector<T>("input, select");
  if (control === null || control === undefined) throw new Error(`No field labelled ${label}`);
  return control;
}

async function setValue(control: HTMLInputElement | HTMLSelectElement, value: string) {
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

async function send(): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === "Send invitation",
  );
  if (button === undefined) throw new Error("No Send invitation button");
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("UserInviteDialog", () => {
  it("asks for a valid address before sending anything", async () => {
    await render();
    await setValue(field("Email"), "not an address");
    await send();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Enter the email address to send the invitation to.");
    const email = field("Email");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(email.getAttribute("aria-describedby")).toBe(alert?.id);
    expect(inviteAdminUser).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("invites with the chosen role, refreshes Users and closes", async () => {
    inviteAdminUser.mockResolvedValue({
      actorId: "actor-1",
      email: "ada@example.com",
      displayName: "Ada",
      expiresAt: "2026-10-19T00:00:00.000Z",
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await render();

    await setValue(field("Email"), "  ada@example.com ");
    await setValue(field("Name (optional)"), " Ada Lovelace ");
    await setValue(field("Role"), "admin");
    await send();

    expect(inviteAdminUser).toHaveBeenCalledTimes(1);
    expect(inviteAdminUser.mock.calls[0]?.[0]).toEqual({
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      role: "admin",
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "users"] });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Invitation sent to ada@example.com" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("omits an empty name and defaults to the member role", async () => {
    inviteAdminUser.mockResolvedValue({
      actorId: "actor-1",
      email: "ada@example.com",
      displayName: "ada",
      expiresAt: "2026-10-19T00:00:00.000Z",
    });
    await render();
    await setValue(field("Email"), "ada@example.com");
    await send();

    expect(inviteAdminUser.mock.calls[0]?.[0]).toEqual({
      email: "ada@example.com",
      role: "member",
    });
  });

  it("keeps the dialog open with the server's reason when the invitation fails", async () => {
    inviteAdminUser.mockRejectedValue(
      new Error("ada@example.com already has a pending invitation."),
    );
    await render();
    await setValue(field("Email"), "ada@example.com");
    await send();

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "ada@example.com already has a pending invitation.",
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
