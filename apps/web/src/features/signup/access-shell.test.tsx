// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
          workspaceUrl: "https://acme.helix.example/mail",
        },
      }),
    );

    await act(async () => {
      root.render(<VerifyEmailShell token="token-1" fetchImpl={fetchImpl} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Your email is verified");
    expect(container.textContent).toContain("Go to Helix");
    expect(container.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe(
      "https://acme.helix.example/mail",
    );
    expect(fetchImpl).toHaveBeenCalledWith("/v1/api/signup/verify-email", expect.any(Object));
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
          workspaceUrl: "https://acme.helix.example/mail",
        },
      }),
    );

    await act(async () => {
      root.render(<VerifyEmailShell token="token-1" fetchImpl={fetchImpl} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Sign in");
    expect(container.textContent).toContain("Sign in to start using it");
    expect(container.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe("/login");
  });

  it("offers token-based resend when verification token is invalid or expired", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = urlForRequest(input);
      if (url === "/v1/api/signup/verify-email") {
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
      if (url === "/v1/api/signup/resend-verification") {
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

    expect(container.textContent).toContain("We couldn’t verify your email");
    expect(container.textContent).toContain("Send a new link");
    clickButton("Send a new link");
    await act(async () => {
      await Promise.resolve();
    });

    const resendCall = fetchImpl.mock.calls.find(
      ([input]) => urlForRequest(input) === "/v1/api/signup/resend-verification",
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

  it("retries a transient verification failure without reloading the page", async () => {
    const successPayload = {
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
        workspaceUrl: "https://acme.helix.example/mail",
      },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ error: { message: "Verification service unavailable." } }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json(successPayload));

    await act(async () => {
      root.render(<VerifyEmailShell token="token-1" fetchImpl={fetchImpl} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Try again");

    clickButton("Try again");
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Your email is verified");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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

    expect(container.querySelector("h1")?.textContent).toBe("Sign in");
    expect(container.querySelector('input[type="email"]')).not.toBeNull();
  });

  it("accepts an invite after local login succeeds", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      if (urlForRequest(input) === "/v1/api/signup/onboarding-invite/accept") {
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
              workspaceUrl: "https://acme.helix.example/mail",
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

    const submitForm = async () => {
      const form = container.querySelector("form");
      if (form === null) {
        throw new Error("Local login form was not rendered.");
      }
      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const email = container.querySelector<HTMLInputElement>('input[type="email"]');
    if (email === null) throw new Error("Email field was not rendered.");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        email,
        "ada@example.com",
      );
      email.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await submitForm();
    await submitForm();

    expect(fetchImpl).toHaveBeenCalledWith(
      "/v1/api/signup/onboarding-invite/accept",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "invite-token" }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(container.textContent).toContain("You’re in");
    expect(container.textContent).toContain("Welcome to Acme.");
    expect(container.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe(
      "https://acme.helix.example/mail",
    );
  });

  it("retries invite acceptance after a transient backend failure", async () => {
    // Not an administrator's invitation, so the signed-in acceptance runs.
    const acceptResponses = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        Response.json({ error: { message: "Invite service unavailable." } }, { status: 503 }),
      )
      .mockResolvedValueOnce(
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
            workspaceUrl: "https://acme.helix.example/mail",
          },
        }),
      );
    const fetchImpl = vi.fn<typeof fetch>((input) =>
      urlForRequest(input) === "/v1/api/invites/inspect"
        ? Promise.resolve(inviteNotFound())
        : acceptResponses(),
    );

    await act(async () => {
      root.render(
        <SignupInviteShell
          token="invite-token"
          fetchImpl={fetchImpl}
          getSession={() =>
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
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Try again");

    clickButton("Try again");
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("You’re in");
    expect(acceptResponses).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("administrator invitation", () => {
  const preview = {
    email: "ada@example.com",
    displayName: "Ada",
    workspaceName: "Acme",
    expiresAt: "2026-10-19T00:00:00.000Z",
    passwordMinLength: 8,
  };
  const signedIn = {
    id: "user-1",
    email: "ada@example.com",
    name: "Ada",
    actorId: "actor-1",
  };

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

  function adminInviteFetch(
    accept: () => Response = () => Response.json({ status: "accepted", email: "ada@example.com" }),
  ) {
    return vi.fn<typeof fetch>((input) => {
      const url = urlForRequest(input);
      if (url === "/v1/api/invites/inspect") return Promise.resolve(Response.json(preview));
      if (url === "/v1/api/invites/accept") return Promise.resolve(accept());
      return Promise.resolve(
        Response.json({ error: { message: "Unhandled request" } }, { status: 500 }),
      );
    });
  }

  async function renderShell(props: Partial<Parameters<typeof SignupInviteShell>[0]>) {
    await act(async () => {
      root.render(<SignupInviteShell token="admin-token" {...props} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function input(name: string): HTMLInputElement {
    const element = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (element === null) throw new Error(`Missing input ${name}`);
    return element;
  }

  function type(name: string, value: string): void {
    const element = input(name);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        element,
        value,
      );
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function join(): Promise<void> {
    const form = container.querySelector("form");
    if (form === null) throw new Error("Password form was not rendered.");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("asks the invited person to choose a password instead of signing in", async () => {
    const fetchImpl = adminInviteFetch();
    const getSession = vi.fn(() => Promise.resolve(null));
    await renderShell({ fetchImpl, getSession });

    expect(container.querySelector("h1")?.textContent).toBe("Join Acme");
    expect(container.textContent).toContain("Choose a password for ada@example.com.");
    expect(container.textContent).toContain("Join workspace");
    expect(input("new-password").type).toBe("password");
    expect(input("confirm-password").type).toBe("password");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/v1/api/invites/inspect",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "admin-token" }),
      }),
    );
    // The token is the credential; no session is consulted.
    expect(getSession).not.toHaveBeenCalled();

    const show = [...container.querySelectorAll("label")].find(
      (label) => label.textContent === "Show password",
    );
    act(() => {
      show?.querySelector("input")?.click();
    });
    expect(input("new-password").type).toBe("text");
    expect(input("confirm-password").type).toBe("text");
  });

  it("checks the password length and confirmation before joining", async () => {
    const fetchImpl = adminInviteFetch();
    const signIn = vi.fn(() => Promise.resolve(signedIn));
    const onJoined = vi.fn();
    await renderShell({ fetchImpl, signIn, onJoined });

    type("new-password", "short");
    type("confirm-password", "short");
    await join();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Use at least 8 characters.",
    );
    expect(input("new-password").getAttribute("aria-invalid")).toBe("true");

    type("new-password", "long enough password");
    type("confirm-password", "long enough passw0rd");
    await join();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "The passwords don’t match.",
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(signIn).not.toHaveBeenCalled();
    expect(onJoined).not.toHaveBeenCalled();
  });

  it("accepts, signs in with the new password and lands the person in the workspace", async () => {
    const fetchImpl = adminInviteFetch();
    const signIn = vi.fn(() => Promise.resolve(signedIn));
    const onJoined = vi.fn();
    await renderShell({ fetchImpl, signIn, onJoined });

    type("new-password", "long enough password");
    type("confirm-password", "long enough password");
    await join();

    expect(fetchImpl).toHaveBeenCalledWith(
      "/v1/api/invites/accept",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "admin-token", password: "long enough password" }),
      }),
    );
    expect(signIn).toHaveBeenCalledWith(
      { email: "ada@example.com", password: "long enough password" },
      fetchImpl,
    );
    expect(onJoined).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("explains why joining failed and lets the person try again", async () => {
    const fetchImpl = adminInviteFetch(() =>
      Response.json(
        {
          code: "existing_sign_in",
          error:
            "ada@example.com already has a Helix sign-in. Sign in with your existing password to join.",
        },
        { status: 409 },
      ),
    );
    const signIn = vi.fn(() => Promise.resolve(signedIn));
    const onJoined = vi.fn();
    await renderShell({ fetchImpl, signIn, onJoined });

    type("new-password", "long enough password");
    type("confirm-password", "long enough password");
    await join();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "ada@example.com already has a Helix sign-in. Sign in with your existing password to join.",
    );
    expect(signIn).not.toHaveBeenCalled();
    expect(onJoined).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).not.toBe(
      true,
    );
  });

  it("falls back to the signed-in acceptance when the link is not an administrator's invitation", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(inviteNotFound()));
    const getSession = vi.fn(() => Promise.resolve(null));
    await renderShell({ fetchImpl, getSession });

    expect(getSession).toHaveBeenCalledTimes(1);
    expect(container.querySelector("h1")?.textContent).toBe("Sign in");
    expect(container.querySelector('input[type="email"]')).not.toBeNull();
    expect(container.querySelector('input[name="confirm-password"]')).toBeNull();
  });
});

function inviteNotFound(): Response {
  return Response.json(
    { code: "invite_invalid", error: "This invitation link is invalid." },
    { status: 404 },
  );
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

function urlForRequest(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}
