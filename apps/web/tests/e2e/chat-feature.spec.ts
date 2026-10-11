/**
 * Chat feature E2E (P1-1) — drives the real /chat UI in a real browser.
 *
 * MOCKED (default): `/v1/api/**` is intercepted by a small in-memory chat
 * backend (rooms, messages, threads, reactions) so flows can round-trip.
 * LIVE (`HELIX_E2E_BACKEND=live`): drives the docker-compose backend's chat
 * tools with a real OAuth token. See `support/backend-mode.ts`.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const ORG = "00000000-0000-4000-8000-000000000100";
const SELF = "00000000-0000-4000-8000-000000000111";
const PRIYA = "00000000-0000-4000-8000-000000000222";
const SPACE = "00000000-0000-4000-8000-000000000501";
const MESSAGE = "00000000-0000-4000-8000-000000000601";
const NEW_ROOM = "00000000-0000-4000-8000-000000000777";

const people = {
  self: { actorId: SELF, role: "owner", displayName: "Test admin", email: "admin@example.test" },
  priya: { actorId: PRIYA, role: "member", displayName: "Priya Rao", email: "priya@example.test" },
};

test.describe("/chat feature flow", () => {
  test("lists conversations and opens a space at its newest message", async ({ page }) => {
    const accessToken = await seedBrowserSession(page, "e2e-chat-token");
    if (!isLiveBackend()) await mockChatBackend(page, accessToken);

    await page.goto("/chat");
    await expect(page.getByRole("main", { name: "Chat" })).toBeVisible();
    if (isLiveBackend()) {
      await expect(page.getByText("Couldn’t load your conversations")).toHaveCount(0);
      return;
    }

    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
    await page.getByRole("button", { name: "Backend launch room" }).first().click();
    const log = page.getByRole("log", { name: "Messages in Backend launch room" });
    await expect(log.getByText("Backend chat message")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message Backend launch room" })).toBeVisible();
    await expect(page.getByText("Conversation details")).toHaveCount(0);
  });

  test("starts a direct message by picking a person, not typing an id", async ({ page }) => {
    test.skip(isLiveBackend(), "Mocked people directory fixture");
    const backend = await mockChatBackend(page, await seedBrowserSession(page, "e2e-chat-dm"));

    await page.goto("/chat");
    await page.getByRole("button", { name: "New chat" }).first().click();
    await page.getByRole("menuitem", { name: "Start a chat" }).click();
    const dialog = page.getByRole("dialog", { name: "Start a chat" });
    await expect(dialog.getByPlaceholder(/actor|uuid/iu)).toHaveCount(0);

    const person = dialog.getByRole("combobox", { name: "People" });
    await person.fill("pri");
    await expect(page.getByRole("option", { name: /Priya Rao/u })).toBeVisible();
    await person.press("Enter");
    await dialog.getByRole("button", { name: "Start chat" }).click();

    await expect.poll(() => backend.created.length).toBe(1);
    expect(backend.created[0]).toMatchObject({ kind: "chat_dm", memberActorIds: [PRIYA] });
    await expect(page.getByRole("heading", { name: "Priya Rao", level: 2 })).toBeVisible();
  });

  test("creates a space with only the fields people choose", async ({ page }) => {
    test.skip(isLiveBackend(), "Mocked chat backend");
    const backend = await mockChatBackend(page, await seedBrowserSession(page, "e2e-chat-space"));

    await page.goto("/chat");
    await page.getByRole("button", { name: "New chat" }).first().click();
    await page.getByRole("menuitem", { name: "Create a space" }).click();
    const dialog = page.getByRole("dialog", { name: "Create a space" });
    await expect(dialog.getByText(/legal hold|retention|history/iu)).toHaveCount(0);
    await dialog.getByLabel("Space name").fill("Launch review");
    await dialog.getByLabel("Description (optional)").fill("Go/no-go calls");
    await dialog.getByRole("radio", { name: /Anyone in your organization/u }).check();
    await dialog.getByRole("button", { name: "Create" }).click();

    await expect.poll(() => backend.created.length).toBe(1);
    expect(backend.created[0]).toEqual({
      kind: "chat_room",
      subject: "Launch review",
      topic: "Go/no-go calls",
      privacy: "discoverable",
      memberActorIds: [],
    });
    await expect(page.getByRole("heading", { name: "Launch review", level: 2 })).toBeVisible();
  });

  test("sends a message that @mentions a member", async ({ page }) => {
    test.skip(isLiveBackend(), "Mocked chat backend");
    const backend = await mockChatBackend(page, await seedBrowserSession(page, "e2e-chat-mention"));

    await page.goto(`/chat?room=${SPACE}`);
    const composer = page.getByRole("textbox", { name: "Message Backend launch room" });
    await composer.click();
    await composer.pressSequentially("Thanks @pri");
    await expect(page.getByRole("option", { name: /Priya Rao/u })).toBeVisible();
    await composer.press("Enter");
    await expect(composer).toHaveValue("Thanks @priya ");
    await composer.press("Enter");

    await expect.poll(() => backend.sent.map((entry) => entry.body)).toContain("Thanks @priya");
    await expect(page.getByRole("log").getByText("Thanks @priya")).toBeVisible();
  });

  test("replies in a thread and reacts to a message", async ({ page }) => {
    test.skip(isLiveBackend(), "Mocked chat backend");
    const backend = await mockChatBackend(page, await seedBrowserSession(page, "e2e-chat-thread"));

    await page.goto(`/chat?room=${SPACE}`);
    const row = page.locator(`[data-message-id="${MESSAGE}"]`);
    await row.hover();
    await row.getByRole("button", { name: "Reply in thread" }).click();
    const thread = page.getByRole("complementary", { name: "Thread" });
    await thread.getByRole("textbox", { name: "Reply in thread" }).fill("On it");
    await thread.getByRole("textbox", { name: "Reply in thread" }).press("Enter");
    await expect(thread.getByText("On it")).toBeVisible();
    expect(backend.replies).toEqual([expect.objectContaining({ parentMessageId: MESSAGE })]);
    await expect(row.getByRole("button", { name: /1 reply/u })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(thread).toHaveCount(0);

    await row.hover();
    await row.getByRole("button", { name: "React", exact: true }).click();
    await page
      .getByRole("group", { name: "Quick reactions" })
      .getByRole("button", { name: "thumbs up" })
      .click();
    await expect(row.getByRole("button", { name: "👍 1 reactions" })).toBeVisible();
    expect(backend.reactions).toEqual([{ messageId: MESSAGE, emoji: "👍", op: "add" }]);
  });

  test("puts the conversation list first on phones", async ({ page }) => {
    test.skip(isLiveBackend(), "Mocked chat backend");
    await page.setViewportSize({ width: 390, height: 844 });
    await mockChatBackend(page, await seedBrowserSession(page, "e2e-chat-mobile"));

    await page.goto("/chat");
    await expect(page.getByRole("heading", { name: "Spaces" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: /^Message/u })).toHaveCount(0);

    await page.getByRole("button", { name: "Backend launch room" }).click();
    await expect(page.getByRole("textbox", { name: "Message Backend launch room" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Spaces" })).toBeHidden();
    await page.getByRole("button", { name: "Back to conversations" }).click();
    await expect(page.getByRole("heading", { name: "Spaces" })).toBeVisible();
  });

  test("shows a server error with Retry, not an offline room", async ({ page }) => {
    test.skip(isLiveBackend(), "Mocked failure");
    await mockChatBackend(page, await seedBrowserSession(page, "e2e-chat-error"), {
      failRooms: true,
    });

    await page.goto("/chat");
    const alert = page.getByRole("alert").filter({ hasText: "Couldn’t load your conversations" });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText(/offline/iu)).toHaveCount(0);
    await expect(page.getByText("0 members")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: /^Message/u })).toHaveCount(0);
  });
});

interface ChatMessageFixture {
  readonly id: string;
  readonly actorId: string;
  readonly body: string;
  readonly parentMessageId: string | null;
  readonly reactions: { messageId: string; actorId: string; emoji: string; createdAt: string }[];
  readonly sentAt: string;
}

async function mockChatBackend(
  page: Page,
  accessToken: string,
  options: { readonly failRooms?: boolean } = {},
) {
  const created: unknown[] = [];
  const sent: { body: string }[] = [];
  const replies: unknown[] = [];
  const reactions: unknown[] = [];
  const rooms: Record<string, unknown>[] = [
    room(SPACE, "chat_room", "Backend launch room", [people.self, people.priya]),
  ];
  const messages: ChatMessageFixture[] = [
    {
      id: MESSAGE,
      actorId: PRIYA,
      body: "Backend chat message",
      parentMessageId: null,
      reactions: [],
      sentAt: "2026-05-20T12:00:00.000Z",
    },
  ];
  let sequence = 0;
  const nextId = () => `00000000-0000-4000-8000-${String(900_000_000_000 + (sequence += 1))}`;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (await fulfillCoreAppsRoute(route)) return;

    if (!(request.headers().cookie ?? "").includes(`helix_session=${accessToken}`)) {
      await route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
      return;
    }
    const tool = pathname.startsWith("/v1/api/tools/") ? pathname.slice(14) : null;
    const input = (request.postDataJSON() ?? {}) as Record<string, unknown>;

    switch (tool) {
      case "chat.room.list":
        if (options.failRooms === true) {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: { message: "Simulated failure" } }),
          });
          return;
        }
        return fulfillJson(route, { rooms });
      case "chat.unread.list":
        return fulfillJson(route, { rooms: [], totalUnread: 0, totalMentions: 0 });
      case "chat.message.list":
        return fulfillJson(route, {
          messages: messages
            .filter((entry) => entry.parentMessageId === null)
            .map((entry) => messageRecord(entry, messages))
            .reverse(),
        });
      case "chat.thread.list":
        return fulfillJson(route, {
          messages: messages
            .filter((entry) => entry.parentMessageId === input.parentMessageId)
            .map((entry) => messageRecord(entry, messages))
            .reverse(),
        });
      case "chat.send":
      case "chat.reply_in_thread": {
        const entry: ChatMessageFixture = {
          id: nextId(),
          actorId: SELF,
          body: String(input.body),
          parentMessageId: typeof input.parentMessageId === "string" ? input.parentMessageId : null,
          reactions: [],
          sentAt: new Date().toISOString(),
        };
        messages.push(entry);
        if (tool === "chat.send") sent.push({ body: entry.body });
        else replies.push(input);
        return fulfillJson(route, messageRecord(entry, messages));
      }
      case "chat.react": {
        reactions.push(input);
        const target = messages.find((entry) => entry.id === input.messageId);
        target?.reactions.push({
          messageId: String(input.messageId),
          actorId: SELF,
          emoji: String(input.emoji),
          createdAt: new Date().toISOString(),
        });
        return fulfillJson(route, { reaction: null });
      }
      case "chat.create_room": {
        created.push(input);
        const kind = input.kind === "chat_dm" ? "chat_dm" : "chat_room";
        const created_room = room(
          NEW_ROOM,
          kind,
          kind === "chat_dm" ? null : String(input.subject),
          kind === "chat_dm" ? [people.self, people.priya] : [people.self],
        );
        rooms.unshift(created_room);
        return fulfillJson(route, created_room);
      }
      case "chat.mentions.list":
        return fulfillJson(route, { mentions: [], nextBefore: null });
      case "chat.room.discover":
        return fulfillJson(route, { rooms: [] });
      case "chat.pins.list":
        return fulfillJson(route, { pins: [] });
      case "chat.search":
        return fulfillJson(route, { hits: [] });
      default:
        break;
    }
    if (pathname === "/v1/api/people/autocomplete") {
      return fulfillJson(route, {
        people: [
          {
            id: PRIYA,
            kind: "directory",
            actorId: PRIYA,
            email: "priya@example.test",
            displayName: "Priya Rao",
            title: "Engineer",
            favorite: false,
            avatarDataUrl: null,
            relationship: {},
          },
        ],
      });
    }
    await fulfillJson(route, {});
  });

  return { created, sent, replies, reactions };
}

function room(
  id: string,
  kind: "chat_room" | "chat_dm",
  name: string | null,
  members: readonly (typeof people)[keyof typeof people][],
) {
  return {
    id,
    orgId: ORG,
    kind,
    subject: name,
    createdByActorId: SELF,
    metadata: {},
    members,
    settings:
      name === null
        ? null
        : {
            threadId: id,
            orgId: ORG,
            name,
            topic: "Launch coordination",
            privacy: "restricted",
            readReceiptsEnabled: true,
          },
    createdAt: "2026-05-20T11:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
  };
}

function messageRecord(entry: ChatMessageFixture, all: readonly ChatMessageFixture[]) {
  const replies = all.filter((candidate) => candidate.parentMessageId === entry.id);
  return {
    id: entry.id,
    orgId: ORG,
    roomId: SPACE,
    actorId: entry.actorId,
    body: entry.body,
    bodyFormat: "plain",
    metadata: {},
    attachmentObjectIds: [],
    reactions: entry.reactions,
    replyCount: replies.length,
    lastReplyAt: replies.at(-1)?.sentAt ?? null,
    pin: null,
    parentMessageId: entry.parentMessageId,
    sentAt: entry.sentAt,
    editedAt: null,
    deletedAt: null,
    createdAt: entry.sentAt,
    updatedAt: entry.sentAt,
  };
}

async function fulfillJson(route: Route, value: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}
