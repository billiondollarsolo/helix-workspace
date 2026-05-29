// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveOrgSlug, SignupShell } from "./signup-shell";
import { SignupInviteShell } from "./invite-shell";
import { VerifyEmailShell } from "./verify-email-shell";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  Link: ({
    to,
    children,
    ...props
  }: {
    readonly to: string;
    readonly children: ReactNode;
    readonly className?: string;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

describe("signup shell", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("derives clean workspace slugs from display names", () => {
    expect(deriveOrgSlug(" Acme Research, Inc. ")).toBe("acme-research-inc");
    expect(deriveOrgSlug("HELIX---LABS")).toBe("helix-labs");
    expect(deriveOrgSlug(" -Bad Prefix ")).toBe("bad-prefix");
  });

  it("creates a workspace and shows the email verification handoff", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = urlForRequest(input);
      if (url === "/api/signup/form-viewed") {
        return Promise.resolve(
          Response.json(
            { error: { message: "Telemetry unavailable during signup form view." } },
            { status: 503 },
          ),
        );
      }
      if (url === "/api/signup/org-slug/acme/availability") {
        return Promise.resolve(Response.json({ slug: "acme", valid: true, available: true }));
      }
      if (url === "/api/signup") {
        return Promise.resolve(
          Response.json(
            {
              status: "provisioning",
              org: {
                id: "11111111-1111-4111-8111-111111111111",
                slug: "acme",
                displayName: "Acme",
                status: "provisioning",
                region: "default",
              },
              verification: { required: true, status: "pending" },
            },
            { status: 202 },
          ),
        );
      }
      return Promise.resolve(
        Response.json({ error: { message: `Unhandled ${url}` } }, { status: 500 }),
      );
    });

    act(() => {
      root.render(
        <SignupShell
          fetchImpl={fetchImpl}
          recaptcha={{ execute: () => Promise.resolve("captcha-token") }}
        />,
      );
    });

    act(() => {
      const inputs = [...container.querySelectorAll<HTMLInputElement>("input")];
      change(inputs[0], "owner@example.com");
      change(inputs[1], "correct-horse-battery-staple");
      change(inputs[2], "Acme");
      change(inputs[4], "+14155550100");
      check(inputs[5], true);
      check(inputs[6], true);
      check(inputs[7], true);
      const country = container.querySelector<HTMLSelectElement>("select");
      changeSelect(country, "US");
    });
    await waitForText("acme.helix.app is available.");

    const form = container.querySelector<HTMLFormElement>("form");
    if (form === null) {
      throw new Error("Missing signup form.");
    }

    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Check your email");
    expect(container.textContent).toContain("Sign in with email/password");
    const formViewedCall = fetchImpl.mock.calls.find(
      ([input]) => urlForRequest(input) === "/api/signup/form-viewed",
    );
    expect(formViewedCall?.[1]?.body).toBe(JSON.stringify({ page: "signup" }));
    const signupCall = fetchImpl.mock.calls.find(
      ([input]) => urlForRequest(input) === "/api/signup",
    );
    expect(signupCall?.[1]?.body).toBe(
      JSON.stringify({
        email: "owner@example.com",
        password: "correct-horse-battery-staple",
        orgName: "Acme",
        orgSlug: "acme",
        country: "US",
        phone: "+14155550100",
        marketingOptIn: true,
        termsAccepted: true,
        privacyAccepted: true,
        recaptchaToken: "captcha-token",
      }),
    );
  });

  it("blocks submit until the password strength is accepted", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = urlForRequest(input);
      if (url === "/api/signup/org-slug/acme/availability") {
        return Promise.resolve(Response.json({ slug: "acme", valid: true, available: true }));
      }
      return Promise.resolve(
        Response.json({ error: { message: `Unexpected ${url}` } }, { status: 500 }),
      );
    });

    act(() => {
      root.render(<SignupShell fetchImpl={fetchImpl} />);
    });

    act(() => {
      const inputs = [...container.querySelectorAll<HTMLInputElement>("input")];
      change(inputs[0], "owner@example.com");
      change(inputs[1], "passwordpassword");
      change(inputs[2], "Acme");
      check(inputs[6], true);
      check(inputs[7], true);
      const country = container.querySelector<HTMLSelectElement>("select");
      changeSelect(country, "US");
    });
    await waitForText("Use at least 12 less predictable characters.");
    await waitForText("acme.helix.app is available.");

    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      true,
    );
    expect(fetchImpl.mock.calls.some(([input]) => urlForRequest(input) === "/api/signup")).toBe(
      false,
    );
  });
});

describe("verify email shell", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("submits the token and shows verified state", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "active",
        org: {
          id: "11111111-1111-4111-8111-111111111111",
          slug: "acme",
          displayName: "Acme",
          status: "active",
          region: "default",
        },
        verification: { status: "verified" },
        session: { created: true, status: "created" },
        workspace: {
          onboardingUrl: "https://acme.helix.example/onboarding",
          welcomeUrl: "https://acme.helix.example/welcome",
        },
      }),
    );

    await act(async () => {
      root.render(<VerifyEmailShell token="token-1" fetchImpl={fetchImpl} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Email verified");
    expect(container.textContent).toContain("Continue");
    expect(container.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe(
      "https://acme.helix.example/onboarding",
    );
    expect(fetchImpl).toHaveBeenCalledWith("/api/signup/verify-email", expect.any(Object));
  });

  it("falls back to login after verification when no session cookie is created", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "active",
        org: {
          id: "11111111-1111-4111-8111-111111111111",
          slug: "acme",
          displayName: "Acme",
          status: "active",
          region: "default",
        },
        verification: { status: "verified" },
        session: { created: false, status: "credential_ready" },
        workspace: {
          onboardingUrl: "https://acme.helix.example/onboarding",
          welcomeUrl: "https://acme.helix.example/welcome",
        },
      }),
    );

    await act(async () => {
      root.render(<VerifyEmailShell token="token-1" fetchImpl={fetchImpl} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Sign in with email/password");
    expect(container.textContent).toContain("ready for local email/password sign in");
    expect(container.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe("/login");
  });

  it("offers token-based resend when verification token is invalid or expired", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = urlForRequest(input);
      if (url === "/api/signup/verify-email") {
        return Promise.resolve(
          Response.json(
            {
              error: {
                code: "signup_verification_invalid",
                message: "Signup email verification token is invalid or expired.",
              },
            },
            { status: 400 },
          ),
        );
      }
      if (url === "/api/signup/resend-verification") {
        return Promise.resolve(Response.json({ status: "accepted" }, { status: 202 }));
      }
      return Promise.resolve(
        Response.json({ error: { message: `Unhandled ${url}` } }, { status: 500 }),
      );
    });

    await act(async () => {
      root.render(<VerifyEmailShell token="old-token" fetchImpl={fetchImpl} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Verification failed");
    expect(container.textContent).toContain("Send a new link");
    clickButton("Send a new link");
    await act(async () => {
      await Promise.resolve();
    });

    const resendCall = fetchImpl.mock.calls.find(
      ([input]) => urlForRequest(input) === "/api/signup/resend-verification",
    );
    expect(resendCall?.[1]?.body).toBe(JSON.stringify({ token: "old-token" }));
    expect(container.textContent).toContain(
      "If this link can be refreshed, we will send a new verification email.",
    );
    expect(container.textContent).not.toContain("owner@example.com");
  });

  it("does not offer resend when verification token is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await act(async () => {
      root.render(<VerifyEmailShell token="" fetchImpl={fetchImpl} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("This verification link is missing its token.");
    expect(container.textContent).not.toContain("Send a new link");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("signup invite shell", () => {
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

  it("shows local email/password login before accepting an invite without a session", async () => {
    await act(async () => {
      root.render(
        <SignupInviteShell
          token="invite-token"
          getSession={() => Promise.resolve(null)}
          signIn={() =>
            Promise.resolve({
              id: "user-1",
              email: "ada@example.com",
              name: "Ada",
              actorId: "actor-1",
            })
          }
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Local email/password login");
    expect(container.textContent).toContain("Email + password");
    expect(container.querySelector('input[type="email"]')).not.toBeNull();
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
  });

  it("accepts an invite after local login succeeds", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      if (urlForRequest(input) === "/api/signup/onboarding-invite/accept") {
        return Promise.resolve(
          Response.json({
            status: "accepted",
            org: {
              id: "11111111-1111-4111-8111-111111111111",
              slug: "acme",
              displayName: "Acme",
              status: "active",
              region: "default",
            },
            actorId: "actor-1",
            workspace: {
              onboardingUrl: "https://acme.helix.example/onboarding",
              welcomeUrl: "https://acme.helix.example/welcome",
            },
          }),
        );
      }
      return Promise.resolve(
        Response.json({ error: { message: "Unhandled request" } }, { status: 500 }),
      );
    });

    await act(async () => {
      root.render(
        <SignupInviteShell
          token="invite-token"
          fetchImpl={fetchImpl}
          getSession={() => Promise.resolve(null)}
          signIn={() =>
            Promise.resolve({
              id: "user-1",
              email: "ada@example.com",
              name: "Ada",
              actorId: "actor-1",
            })
          }
        />,
      );
      await Promise.resolve();
    });

    const form = container.querySelector("form");
    if (form === null) {
      throw new Error("Local login form was not rendered.");
    }
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(fetchImpl).toHaveBeenCalledWith("/api/signup/onboarding-invite/accept", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "invite-token" }),
    });
    expect(container.textContent).toContain("Invitation accepted");
    expect(container.textContent).toContain("Local email/password login remains available");
    expect(container.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe(
      "https://acme.helix.example/welcome",
    );
  });
});

function change(input: HTMLInputElement | undefined, value: string): void {
  if (input === undefined) {
    throw new Error("Missing input.");
  }
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (descriptor?.set === undefined) {
    throw new Error("Missing HTMLInputElement value setter.");
  }
  const setValue = descriptor.set.bind(input);
  setValue(value);
  input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
}

function check(input: HTMLInputElement | undefined, checked: boolean): void {
  if (input === undefined) {
    throw new Error("Missing checkbox.");
  }
  if (input.checked !== checked) {
    input.click();
  }
}

function clickButton(name: string): void {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.textContent?.includes(name),
  );
  if (button === undefined) {
    throw new Error(`Missing button: ${name}`);
  }
  act(() => {
    button.click();
  });
}

function changeSelect(select: HTMLSelectElement | null, value: string): void {
  if (select === null) {
    throw new Error("Missing select.");
  }
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  if (descriptor?.set === undefined) {
    throw new Error("Missing HTMLSelectElement value setter.");
  }
  const setValue = descriptor.set.bind(select);
  setValue(value);
  select.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
}

async function waitForText(text: string): Promise<void> {
  for (let attempts = 0; attempts < 30; attempts += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    if (container.textContent?.includes(text) === true) {
      return;
    }
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}

function urlForRequest(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}
