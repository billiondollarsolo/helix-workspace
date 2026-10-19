// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, settle, unmountAll, axeViolations } from "@/test/ui";
import { buttonNamed, control, typeInto } from "@/features/mail/settings/test-support";
import { FederationApplications } from "./federation-applications";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

describe("Federated apps", () => {
  it("reviews installation proof with accessible fields and retains it on a failed registration", async () => {
    document.cookie = `helix_csrf=${"x".repeat(43)}; Path=/`;
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      calls.push(init?.method ?? "GET");
      return Promise.resolve(
        init?.method === "POST"
          ? Response.json(
              { error: { message: "The installation proof expired. Prepare it again in Bot." } },
              { status: 409 },
            )
          : Response.json({ applications: [] }),
      );
    });
    const queries = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const mounted = mount(
      <QueryClientProvider client={queries}>
        <FederationApplications />
      </QueryClientProvider>,
    );
    await settle();
    await settle();
    expect(mounted.container.querySelector("h1")?.textContent).toBe("Federated apps");
    act(() => buttonNamed("+ Add application")?.click());
    await settle();
    expect(await axeViolations(mounted.container)).toEqual([]);
    const form = mounted.container.querySelector("form");
    if (!form) throw new Error("Registration form missing");
    await act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(calls).not.toContain("POST");
    expect(document.activeElement?.getAttribute("role")).toBe("alert");
    typeInto(control("Bot address"), "https://bot.example");
    typeInto(control("Connection ID"), "11111111-1111-4111-8111-111111111111");
    typeInto(control("Installation proof"), "a".repeat(64));
    await act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    await settle();
    expect(document.body.textContent).toContain("The installation proof expired");
    expect(control("Installation proof")?.value).toBe("a".repeat(64));
    expect(document.querySelector("dialog")).toBeNull();
    queries.clear();
  });
});
