import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend } from "./support/backend-mode";

/* Admin → Chat: rooms are chosen by name, private rooms and direct messages
   stay out of the pickers until the organization allows them, and agent-only
   rooms are listed on request. */

test.beforeEach(() =>
  test.skip(isLiveBackend(), "Uses a fixed set of rooms the live backend does not have."),
);

const ORG_ID = "22222222-2222-4222-8222-222222222222";

function room(index: number, fields: Record<string, unknown>) {
  return {
    id: `33333333-3333-4333-8333-33333333333${String(index)}`,
    kind: "chat_room",
    privacy: "discoverable",
    memberCount: 3,
    agentOnly: false,
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...fields,
  };
}

const LAUNCH = room(1, { name: "Launch" });
const REORG = room(2, { name: "Reorg planning", privacy: "private" });
const DIRECT = room(3, { name: "Avery Park, Blake Lee", kind: "chat_dm", privacy: "private" });
const HANDOFF = room(4, { name: "Agent handoff", privacy: "private", agentOnly: true });

interface Workspace {
  privateRoomsVisible: boolean;
  flagUpdates: unknown[];
  retentionReads: unknown[];
  exports: unknown[];
}

async function openChatAdmin(page: Page): Promise<Workspace> {
  const workspace: Workspace = {
    privateRoomsVisible: false,
    flagUpdates: [],
    retentionReads: [],
    exports: [],
  };
  const tenantConfig = () => {
    const features = { chat_admin_private_rooms: workspace.privateRoomsVisible };
    return {
      tenantConfig: {
        orgId: ORG_ID,
        orgName: "Example",
        byo: {},
        features,
        quotas: {},
        branding: {},
        effective: { byo: {}, features, quotas: {}, branding: {} },
      },
    };
  };
  await page.route("**/api/**", async (route) => {
    if (await fulfillCoreAppsRoute(route)) return;
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/v1/api/admin/tenant-config") {
      if (request.method() === "PATCH") {
        const update = request.postDataJSON() as {
          features: { chat_admin_private_rooms: boolean };
        };
        workspace.flagUpdates.push(update);
        workspace.privateRoomsVisible = update.features.chat_admin_private_rooms;
      }
      return route.fulfill({ json: tenantConfig() });
    }
    if (pathname === "/v1/api/tools/chat.room.list_organization") {
      const asked = request.postDataJSON() as { includeAgentOnly: boolean };
      const people = workspace.privateRoomsVisible ? [LAUNCH, REORG, DIRECT] : [LAUNCH];
      return route.fulfill({
        json: {
          rooms: asked.includeAgentOnly ? [...people, HANDOFF] : people,
          privateRoomsVisible: workspace.privateRoomsVisible,
          hiddenPrivateCount: workspace.privateRoomsVisible ? 0 : 2,
        },
      });
    }
    if (pathname === "/v1/api/tools/chat.retention.get") {
      const asked = request.postDataJSON() as { roomId?: string };
      workspace.retentionReads.push(asked);
      return route.fulfill({
        json: {
          orgId: ORG_ID,
          roomId: asked.roomId ?? null,
          retentionDays: asked.roomId === undefined ? 365 : 30,
          editWindowSeconds: 86_400,
          deleteWindowSeconds: 86_400,
          legalHold: false,
          updatedAt: "2026-08-01T00:00:00.000Z",
          configured: true,
        },
      });
    }
    if (pathname === "/v1/api/tools/chat.export.organization") {
      workspace.exports.push(request.postDataJSON());
      return route.fulfill({
        json: {
          exportId: "66666666-6666-4666-8666-666666666666",
          orgId: ORG_ID,
          generatedAt: "2026-08-02T00:00:00.000Z",
          truncated: false,
          messages: [],
        },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/admin/chat");
  return workspace;
}

async function audit(page: Page) {
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(
    async () =>
      (
        await (window as typeof window & { axe: typeof axe }).axe.run(document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
          },
        })
      ).violations,
  );
  expect(violations).toEqual([]);
}

test("keeps private rooms out of the pickers until the organization allows them", async ({
  page,
}) => {
  const workspace = await openChatAdmin(page);
  const scope = page.getByLabel("Retention applies to");
  const visibility = page.getByRole("region", { name: "Room visibility" });

  await expect(scope.getByRole("option")).toHaveText(["Whole organization", "Launch"]);
  await expect(page.getByText("2 private rooms and direct messages are not listed.")).toHaveCount(
    2,
  );
  await expect(page.getByLabel("Room ID override")).toHaveCount(0);

  // Agent-only rooms are listed on request, private or not.
  await visibility.getByRole("switch", { name: "Show agent-only rooms" }).click();
  await expect(scope.getByRole("option")).toHaveText([
    "Whole organization",
    "Launch",
    "Agent handoff (private, agents only)",
  ]);
  await audit(page);

  await visibility.getByRole("switch", { name: "Administrators can see private rooms" }).click();
  await expect(scope.getByRole("option")).toHaveText([
    "Whole organization",
    "Launch",
    "Reorg planning (private)",
    "Avery Park, Blake Lee (direct message)",
    "Agent handoff (private, agents only)",
  ]);
  await expect(page.getByText("not listed")).toHaveCount(0);
  expect(workspace.flagUpdates).toEqual([
    {
      features: { chat_admin_private_rooms: true },
      reason: "admin settings update: chat_admin_private_rooms",
    },
  ]);
});

test("reads a room's own policy and exports the rooms that were ticked", async ({ page }) => {
  const workspace = await openChatAdmin(page);
  const scope = page.getByLabel("Retention applies to");
  await expect(page.getByLabel("Retention days")).toHaveValue("365");

  await scope.selectOption({ label: "Launch" });
  await expect(page.getByLabel("Retention days")).toHaveValue("30");
  expect(workspace.retentionReads).toContainEqual({ roomId: LAUNCH.id });

  const rooms = page.getByRole("group", { name: /^Rooms/u });
  await expect(rooms).toContainText("Rooms (every room)");
  await rooms.getByLabel("Filter rooms").fill("laun");
  await rooms.getByRole("checkbox", { name: "Launch" }).check();
  await expect(rooms).toContainText("Rooms (1 chosen)");
  await audit(page);

  await page.getByRole("button", { name: "Run organization export" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Export organization Chat" });
  await expect(dialog).toContainText("Export up to 1000 messages from 1 chosen room.");
  await dialog.getByRole("button", { name: "Run export" }).click();
  await expect(dialog).toBeHidden();
  expect(workspace.exports).toEqual([{ roomIds: [LAUNCH.id], limit: 1000 }]);
});
