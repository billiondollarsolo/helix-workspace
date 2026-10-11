// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, mount, settle, unmountAll } from "@/test/ui";
import { buttonNamed, control, typeInto } from "@/features/mail/settings/test-support";
import { LocalLoginPanel } from "./login-panel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const user = { id: "user-1", email: "admin@helix.local", name: "Admin", actorId: "actor-1" };

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

async function submit(): Promise<void> {
  const form = document.querySelector("form");
  if (form === null) throw new Error("No form");
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}

describe("LocalLoginPanel", () => {
  it("asks for the email first, then the password, and signs in", async () => {
    const signIn = vi.fn().mockResolvedValue(user);
    const discover = vi.fn().mockResolvedValue("password");
    const onSignedIn = vi.fn();
    mount(<LocalLoginPanel signIn={signIn} discover={discover} onSignedIn={onSignedIn} />);

    expect(document.querySelector("h1")?.textContent).toBe("Sign in");
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Local email/password");
    typeInto(control("Email"), " admin@helix.local ");
    await submit();

    expect(discover).toHaveBeenCalledWith("admin@helix.local");
    expect(document.body.textContent).toContain("admin@helix.local");
    const password = control("Password");
    expect(password?.getAttribute("type")).toBe("password");
    expect(password?.getAttribute("autocomplete")).toBe("current-password");
    typeInto(password, "helix-admin-password");
    await submit();

    expect(signIn).toHaveBeenCalledWith({
      email: "admin@helix.local",
      password: "helix-admin-password",
    });
    expect(onSignedIn).toHaveBeenCalledWith(user);
  });

  it("checks the email format before asking the server anything", async () => {
    const discover = vi.fn();
    mount(<LocalLoginPanel discover={discover} />);
    typeInto(control("Email"), "not-an-email");
    await submit();
    const alert = document.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toBe("Enter a valid email address.");
    expect(control("Email")?.getAttribute("aria-describedby")).toBe(alert?.id);
    expect(discover).not.toHaveBeenCalled();
  });

  it("shows the password on request and focuses a described error after a failure", async () => {
    const signIn = vi.fn().mockRejectedValue(new Error("Wrong email or password."));
    mount(<LocalLoginPanel signIn={signIn} discover={() => Promise.resolve("password")} />);
    typeInto(control("Email"), "owner@example.com");
    await submit();
    const showPassword = control("Show password");
    showPassword?.click();
    await settle();
    expect(control("Password")?.getAttribute("type")).toBe("text");
    typeInto(control("Password"), "wrong-password");
    await submit();

    const alert = document.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toBe("Wrong email or password.");
    expect(document.activeElement).toBe(alert);
    expect(control("Password")?.getAttribute("aria-invalid")).toBe("true");
    expect(control("Password")?.getAttribute("aria-describedby")).toBe(alert?.id);
    expect(await axeViolations()).toEqual([]);
  });

  it("goes back to change the account and offers a password reset", async () => {
    mount(<LocalLoginPanel discover={() => Promise.resolve("password")} />);
    typeInto(control("Email"), "owner@example.com");
    await submit();
    buttonNamed("Forgot password?")?.click();
    await settle();
    expect(document.querySelector("h1")?.textContent).toBe("Reset your password");
    expect(control<HTMLInputElement>("Email")?.value).toBe("owner@example.com");
    buttonNamed("Back to sign in")?.click();
    await settle();
    buttonNamed("Use another account instead of owner@example.com")?.click();
    await settle();
    expect(document.querySelector("h1")?.textContent).toBe("Sign in");
    expect(await axeViolations()).toEqual([]);
  });

  it("opens the new-password step only for a reset link, never for other ?token= pages", () => {
    window.history.replaceState(null, "", "/signup/invite?token=invite-token");
    mount(<LocalLoginPanel />);
    expect(document.querySelector("h1")?.textContent).toBe("Sign in");
    unmountAll();
    mount(<LocalLoginPanel resetToken="reset-token" />);
    expect(document.querySelector("h1")?.textContent).toBe("Choose a new password");
    expect(control("New password")?.getAttribute("autocomplete")).toBe("new-password");
    window.history.replaceState(null, "", "/");
  });

  it("explains a forced re-verification", () => {
    mount(<LocalLoginPanel reauthenticate />);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Your session must be verified again",
    );
  });
});
