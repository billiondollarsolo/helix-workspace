// @vitest-environment jsdom

/* Account actions for a person who was invited but has not joined: resend
 * the link without confirming, or withdraw it after confirming. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryUser } from "@/features/admin/admin-console-data";
import { UserActionDialog, userActionsFor, type UserAction } from "./user-actions";

const { resendAdminUserInvite, revokeAdminUserInvite, notify } = vi.hoisted(() => ({
  resendAdminUserInvite: vi.fn<(actorId: string) => Promise<void>>(),
  revokeAdminUserInvite: vi.fn<(actorId: string) => Promise<void>>(),
  notify: vi.fn(),
}));
vi.mock("@/features/admin/admin-users", async (original) => ({
  ...(await original<object>()),
  resendAdminUserInvite,
  revokeAdminUserInvite,
}));
vi.mock("@/components/ui/toast", async (original) => ({
  ...(await original<object>()),
  notify,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function directoryUser(overrides: Partial<DirectoryUser> = {}): DirectoryUser {
  return {
    id: "u-1",
    name: "Pending",
    email: "pending@helix.local",
    role: "Member",
    adminScopes: [],
    actorType: "user",
    status: "invited",
    createdAt: "2026-01-01T00:00:00Z",
    disabledAt: null,
    lastSignInAt: null,
    ...overrides,
  };
}

describe("userActionsFor", () => {
  it("offers only the invitation actions until an invited person joins", () => {
    expect(userActionsFor(directoryUser())).toEqual(["profile", "resend-invite", "revoke-invite"]);
  });

  it("never offers invitation actions to people who joined or to agents", () => {
    for (const status of ["active", "suspended", "removed"] as const) {
      const actions = userActionsFor(directoryUser({ status }));
      expect(actions).not.toContain("resend-invite");
      expect(actions).not.toContain("revoke-invite");
    }
    expect(userActionsFor(directoryUser({ actorType: "agent", status: "active" }))).toEqual([
      "offboard",
    ]);
  });
});

describe("invitation actions", () => {
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
    resendAdminUserInvite.mockReset().mockResolvedValue(undefined);
    revokeAdminUserInvite.mockReset().mockResolvedValue(undefined);
    notify.mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    client.clear();
    container.remove();
  });

  async function openAction(action: UserAction): Promise<void> {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <UserActionDialog user={directoryUser()} action={action} onClose={onClose} />
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("resends straight away and says the old link stopped working", async () => {
    await openAction("resend-invite");

    expect(resendAdminUserInvite).toHaveBeenCalledTimes(1);
    expect(resendAdminUserInvite).toHaveBeenCalledWith("u-1");
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(notify).toHaveBeenCalledWith({
      message: "Invitation resent to pending@helix.local",
      description: "The previous link no longer works.",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reports a failed resend", async () => {
    resendAdminUserInvite.mockRejectedValue(new Error("That person has no pending invitation."));
    await openAction("resend-invite");

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Couldn't resend the invitation",
        description: "That person has no pending invitation.",
        tone: "error",
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("withdraws only after confirming, then refreshes Users", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await openAction("revoke-invite");

    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Withdraw the invitation for Pending?");
    expect(dialog?.textContent).toContain("pending@helix.local hasn't joined yet.");
    expect(revokeAdminUserInvite).not.toHaveBeenCalled();

    const withdraw = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Withdraw",
    );
    await act(async () => {
      withdraw?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(revokeAdminUserInvite).toHaveBeenCalledWith("u-1");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "users"] });
    expect(notify).toHaveBeenCalledWith({ message: "Invitation for Pending withdrawn" });
    expect(onClose).toHaveBeenCalled();
  });
});
