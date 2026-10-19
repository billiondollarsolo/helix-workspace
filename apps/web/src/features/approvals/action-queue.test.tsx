// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { axeViolations, click, mount, settle, unmountAll } from "@/test/ui";
import { ActionQueue } from "./action-queue";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    params,
    children,
    to,
    ...props
  }: {
    params: { pendingId: string };
    to: string;
    children: ReactNode;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={to.replace("$pendingId", params.pendingId)}
      {...props}
      onClick={(event) => {
        event.preventDefault();
        props.onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it("shows a nonblocking accessible queue and opens review without approving or marking notifications read", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const request = vi.fn<(input: string) => Promise<Response>>().mockResolvedValue(
    new Response(
      JSON.stringify({
        total: 1,
        items: [
          {
            id,
            actorId: id,
            toolId: "drive.rename",
            status: "pending_confirmation",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            preview: { consequence: "Rename the selected file" },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", request);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const close = vi.fn();
  mount(
    <QueryClientProvider client={client}>
      <ActionQueue onClose={close} />
    </QueryClientProvider>,
  );
  for (
    let attempt = 0;
    attempt < 10 && !document.querySelector('a[href^="/approvals/"]');
    attempt++
  )
    await settle();
  const panel = document.querySelector('[role="dialog"]');
  expect(panel?.getAttribute("aria-modal")).not.toBe("true");
  expect(panel?.textContent).toContain("1 request needs your approval");
  expect(panel?.textContent).toContain("Rename the selected file");
  expect(await axeViolations()).toEqual([]);
  const link = document.querySelector('a[href^="/approvals/"]');
  expect(link?.getAttribute("href")).toBe(`/approvals/${id}`);
  click(link);
  expect(close).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]?.[0]).toContain("/actions?");
  client.clear();
});
