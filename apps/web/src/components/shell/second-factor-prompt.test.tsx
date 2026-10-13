// @vitest-environment jsdom

/* The prompt appears only while a refused administrator request is waiting,
 * verifies with the factor the person has, and sends people without one to
 * their security settings. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionQueryKeys, type SessionUser } from "@/lib/auth";
import { requestSecondFactorStepUp, type StepUpReason } from "@/lib/second-factor-step-up";
import { SecondFactorPrompt } from "./second-factor-prompt";

const { listPasskeys, signInWithPasskey, verifyRecoveryCode, verifyTotp } = vi.hoisted(() => ({
  listPasskeys: vi.fn(),
  signInWithPasskey: vi.fn(),
  verifyRecoveryCode: vi.fn(),
  verifyTotp: vi.fn(),
}));
vi.mock("@/lib/auth", async (original) => ({
  ...(await original<object>()),
  listPasskeys,
  signInWithPasskey,
  verifyRecoveryCode,
  verifyTotp,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const admin: SessionUser = {
  id: "user-1",
  email: "admin@example.com",
  name: "Admin",
  actorId: "actor-1",
  twoFactorEnabled: true,
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let onOpenSecuritySettings: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  onOpenSecuritySettings = vi.fn<() => void>();
  for (const mock of [listPasskeys, signInWithPasskey, verifyRecoveryCode, verifyTotp]) {
    mock.mockReset();
  }
  listPasskeys.mockResolvedValue([]);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  client.clear();
  container.remove();
});

async function render(user: SessionUser): Promise<void> {
  client.setQueryData(sessionQueryKeys.current, user);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SecondFactorPrompt onOpenSecuritySettings={onOpenSecuritySettings} />
      </QueryClientProvider>,
    );
    await Promise.resolve();
  });
}

/** Wrapped in an object: returning the promise itself would wait for the prompt. */
async function refuseRequest(
  reason: StepUpReason = "verification",
): Promise<{ readonly waiting: Promise<boolean> }> {
  let waiting: Promise<boolean> = Promise.resolve(false);
  await act(async () => {
    waiting = requestSecondFactorStepUp(reason);
    // The prompt reads the person's passkeys before it decides what to show.
    await vi.waitFor(() => expect(listPasskeys).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { waiting };
}

async function click(label: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (button === undefined) throw new Error(`No ${label} button`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function typeCode(value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[name="code"]');
  if (input === null) throw new Error("No code field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("SecondFactorPrompt", () => {
  it("stays out of the way until a request is refused", async () => {
    await render(admin);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("verifies an authenticator code and lets the request continue", async () => {
    verifyTotp.mockResolvedValue(admin);
    await render(admin);
    const { waiting } = await refuseRequest();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Confirm it’s you");
    await typeCode(" 123456 ");
    await click("Verify");

    expect(verifyTotp).toHaveBeenCalledWith("123456");
    await expect(waiting).resolves.toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps the prompt open and explains a wrong code", async () => {
    verifyTotp.mockRejectedValue(new Error("Invalid code"));
    await render(admin);
    await refuseRequest();

    await click("Verify");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Enter the 6-digit code.");
    expect(verifyTotp).not.toHaveBeenCalled();

    await typeCode("000000");
    await click("Verify");
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Invalid code");
    const input = document.querySelector('input[name="code"]');
    expect(input?.getAttribute("aria-describedby")).toBe(alert?.id);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("accepts a recovery code instead", async () => {
    verifyRecoveryCode.mockResolvedValue(admin);
    await render(admin);
    const { waiting } = await refuseRequest();

    await click("Use a recovery code");
    await typeCode("abcd-efgh");
    await click("Verify");

    expect(verifyRecoveryCode).toHaveBeenCalledWith("abcd-efgh");
    await expect(waiting).resolves.toBe(true);
  });

  it("returns the refusal when the person cancels", async () => {
    await render(admin);
    const { waiting } = await refuseRequest();

    await click("Cancel");

    await expect(waiting).resolves.toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("offers a passkey to someone who has only that", async () => {
    listPasskeys.mockResolvedValue([{ id: "pk-1", name: "Laptop", createdAt: "2026-10-01" }]);
    signInWithPasskey.mockResolvedValue(admin);
    await render({ ...admin, twoFactorEnabled: false });
    const { waiting } = await refuseRequest();

    expect(document.querySelector('input[name="code"]')).toBeNull();
    await click("Use a passkey");

    expect(signInWithPasskey).toHaveBeenCalledTimes(1);
    await expect(waiting).resolves.toBe(true);
  });

  it("verifies a lapsed session in place and names the way back to sign-in", async () => {
    verifyTotp.mockResolvedValue(admin);
    await render(admin);
    const { waiting } = await refuseRequest("reauthentication");

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("It has been a while since you last verified.");
    expect(dialog?.textContent).toContain("Sign in instead");
    await typeCode("654321");
    await click("Verify");

    await expect(waiting).resolves.toBe(true);
  });

  it("hands a lapsed session without a second step back to sign-in", async () => {
    await render({ ...admin, twoFactorEnabled: false });
    const { waiting } = await refuseRequest("reauthentication");

    await expect(waiting).resolves.toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onOpenSecuritySettings).not.toHaveBeenCalled();
  });

  it("sends someone without a second step to their security settings", async () => {
    await render({ ...admin, twoFactorEnabled: false });
    const { waiting } = await refuseRequest();

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Set up 2-step verification",
    );
    await click("Open security settings");

    expect(onOpenSecuritySettings).toHaveBeenCalledTimes(1);
    await expect(waiting).resolves.toBe(false);
  });
});
