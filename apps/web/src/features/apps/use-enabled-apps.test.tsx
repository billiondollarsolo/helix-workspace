// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEnabledApps } from "./use-enabled-apps";

const state = vi.hoisted(() => ({
  isAdmin: false,
  assistantAvailable: false,
  apps: [] as { id: string; registered: boolean }[],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ isLoading: false, data: { apps: state.apps } }),
}));
vi.mock("@/features/admin/core-apps-api", () => ({
  coreAppsShellQueryOptions: () => ({ queryKey: ["core-apps"] }),
}));
vi.mock("@/features/admin/use-admin-access", () => ({
  useAdminAccess: () => ({ isLoading: false, isAdmin: state.isAdmin }),
}));
vi.mock("@/features/assistant/use-assistant-availability", () => ({
  useAssistantAvailability: () => ({
    isLoading: false,
    available: state.assistantAvailable,
    message: null,
  }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root;
let container: HTMLDivElement;

function Probe() {
  const enabled = useEnabledApps();
  return (
    <span>{["mail", "admin", "assistant"].filter((id) => enabled.isEnabled(id)).join(",")}</span>
  );
}

function enabledIds(): string {
  act(() => root.render(<Probe />));
  return container.textContent ?? "";
}

beforeEach(() => {
  state.isAdmin = false;
  state.assistantAvailable = false;
  state.apps = [
    { id: "mail", registered: true },
    { id: "assistant", registered: true },
  ];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("hides Admin from members and Helix AI while no provider answers", () => {
  expect(enabledIds()).toBe("mail");
});

it("shows Admin to admins and Helix AI once a provider answers", () => {
  state.isAdmin = true;
  state.assistantAvailable = true;
  expect(enabledIds()).toBe("mail,admin,assistant");
});

it("keeps Helix AI hidden when the API does not serve the assistant app", () => {
  state.assistantAvailable = true;
  state.apps = [
    { id: "mail", registered: true },
    { id: "assistant", registered: false },
  ];
  expect(enabledIds()).toBe("mail");
});
