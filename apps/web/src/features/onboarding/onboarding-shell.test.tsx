// @vitest-environment jsdom

import { act } from "react";
import type { MouseEvent, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingShell } from "./onboarding-shell";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    onClick,
    ...props
  }: {
    readonly to: string;
    readonly children: ReactNode;
    readonly className?: string;
    readonly onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      href={to}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock("@/components/shell", () => ({
  SurfaceFrame: ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
    <main data-title={title}>{children}</main>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

describe("OnboardingShell", () => {
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

  it("walks through plan, invite, and sign-in steps before welcome", async () => {
    const fetchState = vi.fn().mockResolvedValue({
      status: "not_started",
      currentStep: "plan",
      planChoice: "pro-trial",
      inviteCount: 0,
      identityChoice: "local",
    });
    const sendEvent = vi.fn().mockResolvedValue(undefined);
    const sendInvites = vi.fn().mockResolvedValue(undefined);
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    await act(() => {
      root.render(
        <OnboardingShell
          fetchState={fetchState}
          sendEvent={sendEvent}
          sendInvites={sendInvites}
          saveProgress={saveProgress}
        />,
      );
      return Promise.resolve();
    });
    expect(sendEvent).toHaveBeenCalledWith({ event: "started" });

    expect(container.textContent).toContain("Choose a starting plan");
    clickButton("Continue");
    expect(container.textContent).toContain("Invite teammates");
    expect(saveProgress).toHaveBeenLastCalledWith({
      currentStep: "invite",
      planChoice: "pro-trial",
      inviteCount: 0,
      identityChoice: "local",
    });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (textarea === null) {
      throw new Error("Missing invite textarea.");
    }
    changeTextarea(textarea, "Ada@Example.com, grace@example.com, ada@example.com");
    expect(container.textContent).toContain("2 invitations queued.");

    clickButton("Continue");
    expect(sendInvites).toHaveBeenCalledWith({
      emails: ["ada@example.com", "grace@example.com"],
    });
    expect(saveProgress).toHaveBeenLastCalledWith({
      currentStep: "sso",
      planChoice: "pro-trial",
      inviteCount: 2,
      identityChoice: "local",
    });
    expect(container.textContent).toContain("Choose sign-in method");
    expect(container.textContent).toContain("Local email/password login");
    expect(container.textContent).toContain("Built-in login for owners, admins, and members");
    expect(container.textContent).toContain("Google SSO");
    expect(container.textContent).toContain("Microsoft SSO");
    expect(container.textContent).not.toContain("SAML");
    expect(textIndex("Local email/password login")).toBeLessThan(textIndex("Google SSO"));
    expect(linkNamed("Finish onboarding")?.getAttribute("href")).toBe("/welcome");

    clickLink("Finish onboarding");
    expect(sendEvent).toHaveBeenLastCalledWith({
      event: "completed",
      planChoice: "pro-trial",
      inviteCount: 2,
      identityChoice: "local",
      skipped: false,
    });
    expect(sendInvites).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sendEvent.mock.calls)).not.toContain("ada@example.com");
    expect(JSON.stringify(sendEvent.mock.calls)).not.toContain("grace@example.com");
    expect(JSON.stringify(saveProgress.mock.calls)).not.toContain("ada@example.com");
  });

  it("lets users skip to welcome", async () => {
    const fetchState = vi.fn().mockResolvedValue({
      status: "not_started",
      currentStep: "plan",
      planChoice: "pro-trial",
      inviteCount: 0,
      identityChoice: "local",
    });
    const sendEvent = vi.fn().mockResolvedValue(undefined);
    const sendInvites = vi.fn().mockResolvedValue(undefined);
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    await act(() => {
      root.render(
        <OnboardingShell
          fetchState={fetchState}
          sendEvent={sendEvent}
          sendInvites={sendInvites}
          saveProgress={saveProgress}
        />,
      );
      return Promise.resolve();
    });

    expect(linkNamed("Skip")?.getAttribute("href")).toBe("/welcome");

    clickButton("Continue");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (textarea === null) {
      throw new Error("Missing invite textarea.");
    }
    changeTextarea(textarea, "ada@example.com");

    clickLink("Skip");
    expect(sendEvent).toHaveBeenLastCalledWith({
      event: "completed",
      planChoice: "pro-trial",
      inviteCount: 1,
      identityChoice: "local",
      skipped: true,
    });
    expect(sendInvites).not.toHaveBeenCalled();
  });

  it("hydrates saved progress while leaving invite email contents empty", async () => {
    const fetchState = vi.fn().mockResolvedValue({
      status: "in_progress",
      currentStep: "invite",
      planChoice: "personal",
      inviteCount: 2,
      identityChoice: "google",
    });
    const sendEvent = vi.fn().mockResolvedValue(undefined);
    const sendInvites = vi.fn().mockResolvedValue(undefined);
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    await act(() => {
      root.render(
        <OnboardingShell
          fetchState={fetchState}
          sendEvent={sendEvent}
          sendInvites={sendInvites}
          saveProgress={saveProgress}
        />,
      );
      return Promise.resolve();
    });
    await act(() => Promise.resolve());

    expect(container.textContent).toContain("Invite teammates");
    expect(container.textContent).toContain("2 invitations sent.");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("");

    clickButton("Continue");
    expect(container.textContent).toContain("Choose sign-in method");
    expect(container.textContent).toContain("Local email/password login");
    expect(container.textContent).not.toContain("Google SSO");
    expect(container.textContent).toContain(
      "SSO setup is available after upgrading to a team plan.",
    );
    expect(saveProgress).toHaveBeenLastCalledWith({
      currentStep: "sso",
      planChoice: "personal",
      inviteCount: 2,
      identityChoice: "local",
    });
  });

  it("resets SSO selection when a plan does not include that provider", async () => {
    const fetchState = vi.fn().mockResolvedValue({
      status: "not_started",
      currentStep: "plan",
      planChoice: "pro-trial",
      inviteCount: 0,
      identityChoice: "local",
    });
    const sendEvent = vi.fn().mockResolvedValue(undefined);
    const sendInvites = vi.fn().mockResolvedValue(undefined);
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    await act(() => {
      root.render(
        <OnboardingShell
          fetchState={fetchState}
          sendEvent={sendEvent}
          sendInvites={sendInvites}
          saveProgress={saveProgress}
        />,
      );
      return Promise.resolve();
    });

    clickButton("Personal free tier");
    clickButton("Continue");
    clickButton("Continue");

    expect(container.textContent).toContain("Local email/password login");
    expect(container.textContent).not.toContain("Google SSO");
    clickLink("Finish onboarding");
    expect(sendEvent).toHaveBeenLastCalledWith({
      event: "completed",
      planChoice: "personal",
      inviteCount: 0,
      identityChoice: "local",
      skipped: false,
    });
  });

  it("keeps local login selectable after previewing an SSO option", async () => {
    const fetchState = vi.fn().mockResolvedValue({
      status: "not_started",
      currentStep: "plan",
      planChoice: "pro-trial",
      inviteCount: 0,
      identityChoice: "local",
    });
    const sendEvent = vi.fn().mockResolvedValue(undefined);
    const sendInvites = vi.fn().mockResolvedValue(undefined);
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    await act(() => {
      root.render(
        <OnboardingShell
          fetchState={fetchState}
          sendEvent={sendEvent}
          sendInvites={sendInvites}
          saveProgress={saveProgress}
        />,
      );
      return Promise.resolve();
    });

    clickButton("Continue");
    clickButton("Continue");
    clickButton("Google SSO");
    clickButton("Local email/password");

    expect(saveProgress).toHaveBeenLastCalledWith({
      currentStep: "sso",
      planChoice: "pro-trial",
      inviteCount: 0,
      identityChoice: "local",
    });
    clickLink("Finish onboarding");
    expect(sendEvent).toHaveBeenLastCalledWith({
      event: "completed",
      planChoice: "pro-trial",
      inviteCount: 0,
      identityChoice: "local",
      skipped: false,
    });
  });

  it("does not block onboarding when telemetry fails", async () => {
    const fetchState = vi.fn().mockRejectedValue(new Error("state unavailable"));
    const sendEvent = vi.fn().mockRejectedValue(new Error("telemetry unavailable"));
    const sendInvites = vi.fn().mockResolvedValue(undefined);
    const saveProgress = vi.fn().mockRejectedValue(new Error("progress unavailable"));
    await act(() => {
      root.render(
        <OnboardingShell
          fetchState={fetchState}
          sendEvent={sendEvent}
          sendInvites={sendInvites}
          saveProgress={saveProgress}
        />,
      );
      return Promise.resolve();
    });

    expect(container.textContent).toContain("Choose a starting plan");
  });
});

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

function linkNamed(name: string): HTMLAnchorElement | undefined {
  return [...container.querySelectorAll<HTMLAnchorElement>("a")].find((link) =>
    link.textContent?.includes(name),
  );
}

function clickLink(name: string): void {
  const link = linkNamed(name);
  if (link === undefined) {
    throw new Error(`Missing link: ${name}`);
  }
  act(() => {
    link.click();
  });
}

function textIndex(value: string): number {
  const index = container.textContent?.indexOf(value) ?? -1;
  if (index === -1) {
    throw new Error(`Missing text: ${value}`);
  }
  return index;
}

function changeTextarea(textarea: HTMLTextAreaElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  if (descriptor?.set === undefined) {
    throw new Error("Missing HTMLTextAreaElement value setter.");
  }
  descriptor.set.call(textarea, value);
  act(() => {
    textarea.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
  });
}
