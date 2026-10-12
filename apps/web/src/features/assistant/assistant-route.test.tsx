// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ASSISTANT_UNAVAILABLE_FALLBACK, AssistantRoute } from "./assistant-route";

const state = vi.hoisted(() => ({
  isLoading: false,
  available: false,
  message: null as string | null,
  isAdmin: false,
}));

vi.mock("./use-assistant-availability", () => ({
  useAssistantAvailability: () => ({
    isLoading: state.isLoading,
    available: state.available,
    message: state.message,
  }),
}));
vi.mock("@/features/admin/use-admin-access", () => ({
  useAdminAccess: () => ({ isLoading: false, isAdmin: state.isAdmin }),
}));
vi.mock("./assistant-surface", () => ({
  AssistantSurface: () => <p>Assistant composer</p>,
}));
vi.mock("@/components/shell", () => ({
  SurfaceFrame: ({ title, children }: { title: string; children: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params }: { children: ReactNode; params: { section: string } }) => (
    <a href={`/admin/${params.section}`}>{children}</a>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root;
let container: HTMLDivElement;

function render(): string {
  act(() => root.render(<AssistantRoute />));
  return container.textContent ?? "";
}

beforeEach(() => {
  Object.assign(state, { isLoading: false, available: false, message: null, isAdmin: false });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("shows the composer when a provider answers", () => {
  state.available = true;
  expect(render()).toContain("Assistant composer");
});

it("explains why Helix AI is unavailable instead of showing the composer", () => {
  state.message = "Ask your administrator to set up Helix AI.";
  const text = render();
  expect(text).not.toContain("Assistant composer");
  expect(text).toContain("Helix AI is unavailable");
  expect(text).toContain("Ask your administrator to set up Helix AI.");
  expect(container.querySelector('[role="status"]')).not.toBeNull();
  expect(container.querySelector("a")).toBeNull();
});

it("links admins to the Assistant settings", () => {
  state.isAdmin = true;
  expect(render()).toContain(ASSISTANT_UNAVAILABLE_FALLBACK);
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/admin/assistant");
});

it("does not flash the composer while availability is loading", () => {
  state.isLoading = true;
  const text = render();
  expect(text).not.toContain("Assistant composer");
  expect(text).not.toContain("Helix AI is unavailable");
});
