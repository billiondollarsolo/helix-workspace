// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, settle, unmountAll, axeViolations } from "@/test/ui";
import { buttonNamed, control, typeInto } from "@/features/mail/settings/test-support";
import { FamilyBackups } from "./family-backups";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});
describe("Federated backups", () => {
  it("keeps capabilities private, validates separate credentials and retains a failed enrollment draft", async () => {
    document.cookie = `helix_csrf=${"x".repeat(43)}; Path=/`;
    const writes: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      if (init?.method === "POST") {
        writes.push(typeof init.body === "string" ? init.body : "");
        return Promise.resolve(
          Response.json(
            { error: { message: "The worker does not match this installation." } },
            { status: 409 },
          ),
        );
      }
      return Promise.resolve(Response.json({ targets: [], jobs: [], applications: [] }));
    });
    const query = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const mounted = mount(
      <QueryClientProvider client={query}>
        <FamilyBackups />
      </QueryClientProvider>,
    );
    await settle();
    await settle();
    expect(mounted.container.querySelector("h1")?.textContent).toBe("Federated backups");
    act(() => buttonNamed("+ Add backup target")?.click());
    await settle();
    expect(await axeViolations(mounted.container)).toEqual([]);
    const form = mounted.container.querySelector('form[aria-label="Connect backup worker"]');
    if (!form) throw new Error("Missing enrollment form");
    await act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(writes).toHaveLength(0);
    expect(control("Backup management capability")?.type).toBe("password");
    typeInto(control("Backup management capability"), "a".repeat(64));
    typeInto(control("Independent restore capability (optional)"), "a".repeat(64));
    await act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(writes).toHaveLength(0);
    typeInto(control("Independent restore capability (optional)"), "b".repeat(64));
    await act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    await settle();
    expect(writes).toHaveLength(1);
    expect(document.body.textContent).toContain("does not match");
    expect(control("Backup management capability")?.value).toBe("a".repeat(64));
    expect(document.body.textContent).not.toContain("a".repeat(64));
    query.clear();
  });
});
