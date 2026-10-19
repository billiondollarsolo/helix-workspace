// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, mount, settle, unmountAll } from "@/test/ui";
import { buttonNamed, control, typeInto } from "@/features/mail/settings/test-support";
import { LocalLoginPanel } from "./login-panel";
import { SecondFactorRequiredError } from "@/lib/auth";

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
  it("uses email codes after a password challenge, without offering an unconfigured authenticator", async () => {
    document.cookie = `helix_csrf=${"p".repeat(43)}; Path=/`;
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const path = input instanceof Request ? input.url : input.toString();
      calls.push(path);
      return Promise.resolve(
        Response.json(path.endsWith("verify-otp") ? { user } : { status: true }),
      );
    });
    const onSignedIn = vi.fn();
    mount(
      <LocalLoginPanel
        discover={() => Promise.resolve("password")}
        signIn={() => Promise.reject(new SecondFactorRequiredError(["otp"]))}
        onSignedIn={onSignedIn}
      />,
    );
    typeInto(control("Email"), "admin@helix.local");
    typeInto(control("Password"), "password");
    await submit();
    expect(control("Email code")).not.toBeNull();
    expect(control("Authenticator code")).toBeNull();
    buttonNamed("Send email code")?.click();
    await settle();
    typeInto(control("Email code"), "123456");
    await submit();
    expect(calls).toEqual([
      "/v1/api/auth/two-factor/send-otp",
      "/v1/api/auth/two-factor/verify-otp",
    ]);
    expect(onSignedIn).toHaveBeenCalledWith(expect.objectContaining({ id: user.id }));
  });
  it("shows email and password together and signs in with one submission", async () => {
    const signIn = vi.fn().mockResolvedValue(user);
    const discover = vi.fn().mockResolvedValue("password");
    const onSignedIn = vi.fn();
    mount(<LocalLoginPanel signIn={signIn} discover={discover} onSignedIn={onSignedIn} />);

    expect(document.querySelector("h1")?.textContent).toBe("Sign in");
    expect(control("Email")).not.toBeNull();
    expect(control("Password")).not.toBeNull();
    expect(document.body.textContent).not.toContain("Local email/password");
    typeInto(control("Email"), " admin@helix.local ");

    const password = control("Password");
    expect(password?.getAttribute("type")).toBe("password");
    expect(password?.getAttribute("autocomplete")).toBe("current-password");
    typeInto(password, "helix-admin-password");
    await submit();

    expect(discover).toHaveBeenCalledWith("admin@helix.local");
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

  it("requires a password for local sign-in and recovers from discovery errors", async () => {
    const signIn = vi.fn();
    const discover = vi
      .fn()
      .mockResolvedValueOnce("password")
      .mockRejectedValueOnce(new Error("Try again."));
    mount(<LocalLoginPanel signIn={signIn} discover={discover} />);
    typeInto(control("Email"), "owner@example.com");
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Enter your password.");
    expect(signIn).not.toHaveBeenCalled();
    typeInto(control("Password"), "test-password");
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Try again.");
    expect(buttonNamed("Sign in")?.disabled).toBe(false);
    expect(signIn).not.toHaveBeenCalled();
  });

  it("shows the password on request and focuses a described error after a failure", async () => {
    const signIn = vi.fn().mockRejectedValue(new Error("Wrong email or password."));
    mount(<LocalLoginPanel signIn={signIn} discover={() => Promise.resolve("password")} />);
    typeInto(control("Email"), "owner@example.com");
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

  it("returns from password reset to the combined sign-in form", async () => {
    mount(<LocalLoginPanel discover={() => Promise.resolve("password")} />);
    typeInto(control("Email"), "owner@example.com");
    buttonNamed("Forgot password?")?.click();
    await settle();
    expect(document.querySelector("h1")?.textContent).toBe("Reset your password");
    expect(control<HTMLInputElement>("Email")?.value).toBe("owner@example.com");
    buttonNamed("Back to sign in")?.click();
    await settle();
    expect(control("Email")).not.toBeNull();
    expect(control("Password")).not.toBeNull();
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
