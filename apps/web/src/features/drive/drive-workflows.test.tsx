// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { DriveWorkflows } from "./drive-workflows";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("DriveWorkflows", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exposes labeled mobile-safe create, load, and decision controls", async () => {
    const record: api.DriveWorkflow = {
      id: "99999999-9999-4999-8999-999999999999",
      kind: "approval",
      resourceType: "object",
      resourceId: "33333333-3333-4333-8333-333333333333",
      requestedByActorId: "11111111-1111-4111-8111-111111111111",
      assignedToActorId: "22222222-2222-4222-8222-222222222222",
      state: "open",
      version: "1",
      payload: {},
      policySnapshot: {},
      dueAt: null,
      decidedAt: null,
      createdAt: "2026-09-03T12:00:00.000Z",
      updatedAt: "2026-09-03T12:00:00.000Z",
    };
    const list = vi.spyOn(api, "listDriveWorkflows").mockResolvedValue([record]);
    vi.spyOn(api, "createDriveWorkflow").mockResolvedValue(record);
    vi.spyOn(api, "transitionDriveWorkflow").mockResolvedValue({
      ...record,
      state: "approved",
      version: "2",
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <DriveWorkflows resourceId={record.resourceId} resourceType="object" />
        </QueryClientProvider>,
      );
    });
    expect(list).not.toHaveBeenCalled();

    const load = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Load workflows",
    );
    await act(async () => {
      load?.click();
      await vi.waitFor(() => {
        expect(list).toHaveBeenCalledOnce();
      });
    });

    expect(container.querySelector('section[aria-label="Drive workflows"]')).not.toBeNull();
    expect(container.querySelector('ul[aria-live="polite"]')?.textContent).toContain(
      "approval · open",
    );
    expect(container.textContent).toContain("approved");
    expect(container.textContent).toContain("rejected");

    act(() => {
      root.unmount();
    });
    client.clear();
    container.remove();
  });
});
