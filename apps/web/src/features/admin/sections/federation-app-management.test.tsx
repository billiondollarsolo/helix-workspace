// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, settle, unmountAll, axeViolations } from "@/test/ui";
import { buttonNamed } from "@/features/mail/settings/test-support";
import { FederationApplications } from "./federation-applications";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const app = {
  id: "11111111-1111-4111-8111-111111111111",
  origin: "https://bot.example",
  status: "active",
  installationId: "installation",
  tenantId: "team",
  lastSyncedAt: new Date().toISOString(),
  error: null,
  pending: false,
  rotationPending: false,
};
const people = [
  {
    actorId: "22222222-2222-4222-8222-222222222222",
    role: "viewer",
    displayName: "Ada",
    email: "ada@example.test",
  },
  {
    actorId: "33333333-3333-4333-8333-333333333333",
    role: "member",
    displayName: "Jo",
    email: "jo@example.test",
  },
];
const policy = {
  revision: 2,
  enabled: true,
  intervalMinutes: 60,
  retentionDays: 30,
  destinationRef: "offsite",
};
const target = {
  id: "worker",
  applicationId: app.id,
  origin: app.origin,
  status: "active",
  policy: { ...policy, revision: 3, retentionDays: 90 },
  pending: true,
  error: null,
  restoreEnabled: false,
  observedAt: new Date().toISOString(),
  observation: {
    protocol: "helix.federation.backup.v1",
    scheduler: "external",
    owner: "workspace",
    policy,
    capabilities: ["backup", "verify"],
    minimumRetentionDays: 30,
    destinations: ["offsite"],
    requiredCoverage: ["database", "files", "configuration"],
    applicationHealthy: true,
    alerts: ["restore_drill_missing"],
    jobs: [],
  },
};
const queries: QueryClient[] = [];
afterEach(() => {
  unmountAll();
  for (const query of queries.splice(0)) query.clear();
  vi.restoreAllMocks();
});
async function render() {
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queries.push(query);
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={query}>
        <FederationApplications />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const mounted = mount(<RouterProvider router={router} />);
  await settle();
  await settle();
  await settle();
  return { ...mounted, query };
}
function assignedControl(email: string) {
  const label = [...document.querySelectorAll("label")].find(
    (node) => node.querySelector(".admin-field-label")?.textContent === email,
  );
  const select = label?.querySelector("select");
  if (!select) throw new Error(`Assigned person missing: ${email}`);
  return select;
}
function route(input: RequestInfo | URL) {
  return String(input);
}

describe("Federated app management", () => {
  it("loads capability details only on request and separates acknowledged policy from pending delivery", async () => {
    const calls: string[] = [];
    let unavailable = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      calls.push(route(input));
      if (unavailable && route(input).endsWith("federation-backups"))
        return Response.json(
          { error: { message: "Worker inventory unavailable." } },
          { status: 503 },
        );
      return Response.json(
        route(input).endsWith("federation-backups")
          ? {
              targets: [
                target,
                {
                  ...target,
                  id: "other",
                  applicationId: "another-app",
                  observation: {
                    ...target.observation,
                    policy: { ...policy, destinationRef: "other-private-destination" },
                  },
                },
              ],
            }
          : { applications: [app] },
      );
    });
    const mounted = await render();
    expect(calls.some((path) => path.endsWith("federation-backups"))).toBe(false);
    act(() => buttonNamed("View app details")?.click());
    await settle();
    await settle();
    const text = mounted.container.textContent;
    expect(text).toContain(
      "Last acknowledged policy: revision 2; enabled; 60 minute interval; 30 day retention",
    );
    expect(text).toContain("Desired Workspace policy: revision 3. Delivery pending");
    expect(text).toContain("Application health: healthy");
    expect(text).toContain("external operator owns the schedule");
    expect(text).toContain("Isolated restore: not enrolled");
    expect(text).not.toContain("other-private-destination");
    expect(mounted.container.querySelector('a[href="/admin/federation-backups"]')).not.toBeNull();
    expect(await axeViolations(mounted.container)).toEqual([]);
    unavailable = true;
    act(() => buttonNamed("Refresh backup status")?.click());
    await settle();
    await settle();
    expect(mounted.container.textContent).toContain("Backup status unavailable");
    expect(mounted.container.textContent).not.toContain("Application health: healthy");
    expect(mounted.container.textContent).toContain("Last acknowledged policy: revision 2");
  });

  it("does not present an overdue or detached healthy observation as current health", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      Response.json(
        route(input).endsWith("federation-backups")
          ? {
              targets: [
                { ...target, observedAt: new Date(Date.now() - 120_000).toISOString() },
                { ...target, id: "detached", status: "detached" },
              ],
            }
          : { applications: [{ ...app, lastSyncedAt: null }] },
      ),
    );
    const mounted = await render();
    expect(mounted.container.textContent).toContain("Directory: verification overdue");
    act(() => buttonNamed("View app details")?.click());
    await settle();
    await settle();
    expect(mounted.container.textContent).not.toContain("Application health: healthy");
    expect(mounted.container.textContent).toContain("Observation overdue");
    expect(mounted.container.textContent).toContain("not current");
  });

  it("distinguishes permission failure, unenrolled recovery and a disabled capability and supports retry", async () => {
    let status = 403;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      route(input).endsWith("federation-backups")
        ? Response.json(
            status === 200
              ? { targets: [] }
              : { error: { message: "Recovery administration is required." } },
            { status },
          )
        : Response.json({ applications: [app] }),
    );
    const mounted = await render();
    act(() => buttonNamed("View app details")?.click());
    await settle();
    await settle();
    expect(mounted.container.textContent).toContain("Backup status unavailable");
    expect(mounted.container.textContent).not.toContain("No backup worker is enrolled");
    status = 200;
    act(() => buttonNamed("Refresh backup status")?.click());
    await settle();
    await settle();
    expect(mounted.container.textContent).toContain("No backup worker is enrolled");
    status = 404;
    act(() => buttonNamed("Refresh backup status")?.click());
    await settle();
    await settle();
    expect(mounted.container.textContent).toContain("backup management is not enabled");
  });

  it("shows assigned people outside search results and retains every draft role through refresh and failed save", async () => {
    document.cookie = `helix_csrf=${"x".repeat(43)}; Path=/`;
    const writes: unknown[] = [];
    let fail = true;
    let assignments = people;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = route(input);
      if (path.endsWith("/assignments")) {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body));
          writes.push(body);
          if (fail)
            return Response.json(
              { error: { message: "Try the assignment save again." } },
              { status: 409 },
            );
          assignments = body.assignments.map((entry: { actorId: string; role: string }) => ({
            ...people.find((person) => person.actorId === entry.actorId),
            ...entry,
          }));
          return Response.json({ updated: true });
        }
        return Response.json({ assignments });
      }
      if (path.includes("/admin/users?")) return Response.json({ users: [], nextCursor: null });
      return Response.json({ applications: [app] });
    });
    const mounted = await render();
    act(() => buttonNamed("Manage assigned people")?.click());
    await settle();
    await settle();
    const jo = assignedControl("jo@example.test");
    expect(jo.value).toBe("member");
    act(() => {
      jo.value = "admin";
      jo.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assignments = [{ ...people[0]!, role: "admin" }, people[1]!];
    act(() => buttonNamed("Refresh assigned people")?.click());
    await settle();
    await settle();
    expect(jo.value).toBe("admin");
    expect(assignedControl("ada@example.test").value).toBe("viewer");
    act(() => buttonNamed("Save assignments")?.click());
    await settle();
    await settle();
    expect(mounted.container.textContent).toContain("Try the assignment save again");
    expect(jo.value).toBe("admin");
    fail = false;
    act(() => buttonNamed("Save assignments")?.click());
    await settle();
    await settle();
    await settle();
    expect(writes).toEqual(
      [0, 1].map(() => ({
        assignments: [
          { actorId: people[0]!.actorId, role: "viewer" },
          { actorId: people[1]!.actorId, role: "admin" },
        ],
      })),
    );
    expect(mounted.container.textContent).toContain(
      "Assignments saved. Directory synchronization is pending",
    );
    expect(await axeViolations(mounted.container)).toEqual([]);
  });
});
