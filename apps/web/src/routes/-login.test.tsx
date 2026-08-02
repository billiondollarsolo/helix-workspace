// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalLoginPanel } from "./login";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
    input,
    value,
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("LocalLoginPanel", () => {
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
    vi.restoreAllMocks();
  });

  it("keeps local email/password login visible", () => {
    act(() => {
      root.render(<LocalLoginPanel />);
    });

    expect(container.textContent).toContain("Local email/password login");
    expect(container.textContent).toContain("Local email/password is always available");
    expect(container.textContent).toContain("Email + password");
    expect(container.querySelector('input[type="email"]')).not.toBeNull();
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(buttonNamed("Sign in", container)).not.toBeNull();
    const form = container.querySelector("form.auth-form");
    expect(form).not.toBeNull();
    expect(form?.querySelector('input[type="email"][autocomplete="username"]')).not.toBeNull();
    expect(form?.querySelector('input[name="email"][spellcheck="false"]')).not.toBeNull();
    expect(
      form?.querySelector(
        'input[name="password"][type="password"][autocomplete="current-password"]',
      ),
    ).not.toBeNull();
    expect(buttonNamed("Sign in", form ?? container)?.type).toBe("submit");
  });

  it("submits local credentials through the email/password sign-in path", async () => {
    const signIn = vi.fn().mockResolvedValue({
      id: "user-1",
      email: "admin@helix.local",
      name: "Admin",
      actorId: "actor-1",
    });
    const onSignedIn = vi.fn();

    await act(() => {
      root.render(<LocalLoginPanel signIn={signIn} onSignedIn={onSignedIn} />);
      return Promise.resolve();
    });

    const email = container.querySelector<HTMLInputElement>('input[type="email"]');
    const password = container.querySelector<HTMLInputElement>('input[type="password"]');
    if (email === null || password === null) {
      throw new Error("Local login inputs were not rendered.");
    }

    await act(() => {
      setInputValue(email, " admin@helix.local ");
      setInputValue(password, "helix-admin-password");
      return Promise.resolve();
    });

    const form = container.querySelector("form");
    if (form === null) {
      throw new Error("Local login form was not rendered.");
    }
    await act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      return Promise.resolve();
    });

    expect(signIn).toHaveBeenCalledWith({
      email: "admin@helix.local",
      password: "helix-admin-password",
    });
    expect(onSignedIn).toHaveBeenCalledWith(
      expect.objectContaining({ email: "admin@helix.local", actorId: "actor-1" }),
    );
  });

  it("focuses an actionable error after sign-in fails", async () => {
    const signIn = vi.fn().mockRejectedValue(new Error("Check your email and password."));
    act(() => {
      root.render(<LocalLoginPanel signIn={signIn} />);
    });
    const email = container.querySelector<HTMLInputElement>('input[name="email"]');
    const password = container.querySelector<HTMLInputElement>('input[name="password"]');
    const form = container.querySelector("form");
    if (email === null || password === null || form === null) {
      throw new Error("Missing login form controls.");
    }
    await act(async () => {
      setInputValue(email, "owner@example.com");
      setInputValue(password, "wrong-password");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toBe("Check your email and password.");
    expect(document.activeElement).toBe(alert);
    expect(email.getAttribute("aria-invalid")).toBe("true");
  });
});

function buttonNamed(label: string, rootElement: Element): HTMLButtonElement | null {
  return (
    [...rootElement.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === label,
    ) ?? null
  );
}
