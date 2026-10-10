// @vitest-environment jsdom

import { useQuery } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { enableTotp, listPasskeys } from "@/lib/auth";
import { SecuritySection } from "./settings-security";

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  listPasskeys: vi.fn(),
  enableTotp: vi.fn(),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Runs `action` inside act and lets pending fetch promises settle. */
async function settle(action: () => void): Promise<void> {
  await act(() => {
    action();
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(useQuery).mockReturnValue({
    data: { twoFactorEnabled: false },
    refetch: vi.fn(),
  } as never);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderSection(): Promise<void> {
  await settle(() => root.render(<SecuritySection />));
}

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(text: string): HTMLButtonElement {
  return Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === text,
  )!;
}

it("labels the password and code inputs and reports failures as alerts", async () => {
  vi.mocked(listPasskeys).mockResolvedValue([]);
  vi.mocked(enableTotp)
    .mockRejectedValueOnce(new Error("Password is incorrect."))
    .mockResolvedValueOnce({ totpURI: "otpauth://totp/helix", backupCodes: [] });
  await renderSection();

  const password = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(password.labels?.[0]?.textContent).toBe("Current password");
  setInput(password, "wrong");
  await settle(() => button("Set up TOTP").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Password is incorrect.");
  expect(container.querySelector('[role="status"]')).toBeNull();

  await settle(() => button("Set up TOTP").click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  const code = container.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]')!;
  expect(code.labels?.[0]?.textContent).toBe("6-digit code from your authenticator app");
});

it("shows a passkey list failure instead of an empty list, and retries", async () => {
  vi.mocked(listPasskeys)
    .mockRejectedValueOnce(new Error("Network unavailable."))
    .mockResolvedValueOnce([{ id: "pk-1", name: "Laptop" } as never]);
  await renderSection();

  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not load your passkeys. Network unavailable.",
  );
  await settle(() => button("Retry loading passkeys").click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("Laptop");
});
