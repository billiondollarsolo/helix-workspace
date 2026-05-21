import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { createStoreBackedMcpResourceProvider } from "./mcp-resources.js";
import { handleMcpJsonRpcRequest } from "./mcp.js";
import { systemActor } from "./actor.js";
import { createToolRegistry } from "../platform/tool-registry.js";
import { AllowAllToolAccessPolicy } from "../platform/permissions/tool-access.js";
import type { CalendarEventRecord } from "../platform/calendar/types.js";
import type { ChatMessageRecord, ChatRoomRecord } from "../platform/chat/types.js";
import type { DriveEntryRecord, DriveSearchHit } from "../platform/drive/types.js";
import type { DriveFileReadInput, DriveFileReadResult } from "../platform/drive/store.js";
import type { DocsDocumentRecord, DocsExportDocument } from "../platform/docs/types.js";
import type {
  MailSearchHit,
  MailThreadDetail,
  MailThreadGetRequest,
  MailSearchRequest,
} from "../platform/mail/types.js";

describe("createStoreBackedMcpResourceProvider", () => {
  it("lists only resources allowed by actor scopes and store access", async () => {
    const mail = new FakeMailStore();
    const chat = new FakeChatStore();
    const calendar = new FakeCalendarStore();
    const drive = new FakeDriveStore();
    const docs = new FakeDocsStore();
    const resources = createStoreBackedMcpResourceProvider({
      chat,
      calendar,
      mail,
      drive,
      docs,
      limit: 10,
    });

    const listed = await resources.list({
      ...agentActor,
      scopes: ["mail.read", "docs.read"],
    });

    expect(listed).toMatchObject([
      {
        uri: "helix://mail/thread/thread-1",
        name: "Launch mail",
        mimeType: "text/markdown",
      },
      {
        uri: "helix://docs/document/doc-1",
        name: "Launch plan",
        mimeType: "text/markdown",
      },
    ]);
    expect(mail.searches[0]).toMatchObject({
      orgId: "org-mcp",
      actorId: "agent-mcp",
      query: "",
      limit: 10,
    });
    expect(docs.lists[0]).toMatchObject({
      orgId: "org-mcp",
      actorId: "agent-mcp",
      query: "",
      limit: 10,
    });
    expect(chat.lists).toHaveLength(0);
    expect(calendar.lists).toHaveLength(0);
    expect(drive.searches).toHaveLength(0);
  });

  it("reads actor-scoped chat, calendar, mail, docs, text drive files, and binary drive metadata", async () => {
    const chat = new FakeChatStore();
    const calendar = new FakeCalendarStore();
    const mail = new FakeMailStore();
    const drive = new FakeDriveStore();
    const docs = new FakeDocsStore();
    const resources = createStoreBackedMcpResourceProvider({ chat, calendar, mail, drive, docs });

    const chatContent = await resources.read(agentActor, "helix://chat/room/room-1");
    expect(chatContent).toMatchObject({
      uri: "helix://chat/room/room-1",
      mimeType: "text/markdown",
    });
    expect(chatContent?.text).toContain("Daily standup");
    expect(chatContent?.text).toContain("Ship the launch plan.");

    const calendarContent = await resources.read(agentActor, "helix://calendar/event/event-1");
    expect(calendarContent).toMatchObject({
      uri: "helix://calendar/event/event-1",
      mimeType: "text/markdown",
    });
    expect(calendarContent?.text).toContain("Launch review");
    expect(calendarContent?.text).toContain("Conference Room A");

    const mailContent = await resources.read(agentActor, "helix://mail/thread/thread-1");
    expect(mailContent).toMatchObject({
      uri: "helix://mail/thread/thread-1",
      mimeType: "text/markdown",
    });
    expect(mailContent?.text).toContain("Schedule moved to Friday.");

    const docsContent = await resources.read(agentActor, "helix://docs/document/doc-1");
    expect(docsContent).toMatchObject({
      uri: "helix://docs/document/doc-1",
      mimeType: "text/markdown",
    });
    expect(docsContent?.text).toContain("## Comments\n- Needs timeline.");

    await expect(resources.read(agentActor, "helix://drive/file/file-text")).resolves.toMatchObject(
      {
        uri: "helix://drive/file/file-text",
        mimeType: "text/plain",
        text: "Launch text file",
      },
    );
    const binaryContent = await resources.read(agentActor, "helix://drive/file/file-binary");
    expect(binaryContent).toMatchObject({
      uri: "helix://drive/file/file-binary",
      mimeType: "text/markdown",
    });
    expect(binaryContent?.text).toContain("Content is not available as MCP text");
    expect(mail.threadReads[0]).toMatchObject({
      orgId: "org-mcp",
      actorId: "agent-mcp",
      threadId: "thread-1",
    });
    expect(chat.roomReads[0]).toMatchObject({
      orgId: "org-mcp",
      actorId: "agent-mcp",
      roomId: "room-1",
    });
    expect(chat.messageLists[0]).toMatchObject({
      orgId: "org-mcp",
      actorId: "agent-mcp",
      roomId: "room-1",
      limit: 25,
    });
    expect(calendar.reads[0]).toMatchObject({
      orgId: "org-mcp",
      actorId: "agent-mcp",
      eventId: "event-1",
    });
    expect(drive.reads).toMatchObject([
      { orgId: "org-mcp", actorId: "agent-mcp", objectId: "file-text" },
      { orgId: "org-mcp", actorId: "agent-mcp", objectId: "file-binary" },
    ]);
    expect(docs.reads[0]).toMatchObject({
      orgId: "org-mcp",
      actorId: "agent-mcp",
      docId: "doc-1",
    });
  });

  it("uses the store-backed provider through MCP resources/read", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    const response = await handleMcpJsonRpcRequest({
      tools,
      actor: agentActor,
      resources: createStoreBackedMcpResourceProvider({
        mail: new FakeMailStore(),
      }),
      body: {
        jsonrpc: "2.0",
        id: "read-mail",
        method: "resources/read",
        params: { uri: "helix://mail/thread/thread-1" },
      },
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: "read-mail",
      result: {
        contents: [
          {
            uri: "helix://mail/thread/thread-1",
            mimeType: "text/markdown",
          },
        ],
      },
    });
    if (!("result" in response)) {
      throw new Error("Expected MCP result.");
    }
    const result = response.result as {
      readonly contents: readonly { readonly text: string }[];
    };
    expect(result.contents[0]?.text).toContain("Launch mail");
  });

  it("denies unreadable chat and calendar resources before calling stores", async () => {
    const chat = new FakeChatStore();
    const calendar = new FakeCalendarStore();
    const resources = createStoreBackedMcpResourceProvider({ chat, calendar });
    const mailOnlyActor: Actor = {
      ...agentActor,
      scopes: ["mail.read"],
    };

    await expect(resources.read(mailOnlyActor, "helix://chat/room/room-1")).resolves.toBeNull();
    await expect(
      resources.read(mailOnlyActor, "helix://calendar/event/event-1"),
    ).resolves.toBeNull();
    expect(chat.roomReads).toHaveLength(0);
    expect(chat.messageLists).toHaveLength(0);
    expect(calendar.reads).toHaveLength(0);
  });

  it("returns null for unknown actor-scoped chat and calendar resources", async () => {
    const resources = createStoreBackedMcpResourceProvider({
      chat: new FakeChatStore(),
      calendar: new FakeCalendarStore(),
    });

    await expect(resources.read(agentActor, "helix://chat/room/missing")).resolves.toBeNull();
    await expect(resources.read(agentActor, "helix://calendar/event/missing")).resolves.toBeNull();
  });

  it("lets system actors list all configured resource stores", async () => {
    const resources = createStoreBackedMcpResourceProvider({
      chat: new FakeChatStore(),
      calendar: new FakeCalendarStore(),
      mail: new FakeMailStore(),
      drive: new FakeDriveStore(),
      docs: new FakeDocsStore(),
    });

    await expect(resources.list(systemActor)).resolves.toHaveLength(5);
  });
});

const agentActor: Actor = {
  id: "agent-mcp",
  orgId: "org-mcp",
  type: "agent",
  scopes: ["chat.read", "calendar.read", "mail.read", "drive.read", "docs.read"],
};

class FakeChatStore {
  readonly lists: Parameters<
    NonNullable<Parameters<typeof createStoreBackedMcpResourceProvider>[0]["chat"]>["listRooms"]
  >[0][] = [];
  readonly roomReads: Parameters<
    NonNullable<
      Parameters<typeof createStoreBackedMcpResourceProvider>[0]["chat"]
    >["getRoomForActor"]
  >[0][] = [];
  readonly messageLists: Parameters<
    NonNullable<Parameters<typeof createStoreBackedMcpResourceProvider>[0]["chat"]>["listMessages"]
  >[0][] = [];

  async listRooms(input: (typeof this.lists)[number]): Promise<readonly ChatRoomRecord[]> {
    this.lists.push(input);
    return [chatRoomRecord()];
  }

  async getRoomForActor(input: (typeof this.roomReads)[number]): Promise<ChatRoomRecord | null> {
    this.roomReads.push(input);
    return input.roomId === "room-1" ? chatRoomRecord() : null;
  }

  async listMessages(
    input: (typeof this.messageLists)[number],
  ): Promise<readonly ChatMessageRecord[]> {
    this.messageLists.push(input);
    return [
      {
        id: "message-1",
        orgId: "org-mcp",
        roomId: "room-1",
        actorId: "agent-mcp",
        body: "Ship the launch plan.",
        bodyFormat: "plain",
        metadata: {},
        attachmentObjectIds: [],
        sentAt: new Date("2026-05-20T12:10:00.000Z"),
        editedAt: null,
        deletedAt: null,
        createdAt: new Date("2026-05-20T12:10:00.000Z"),
        updatedAt: new Date("2026-05-20T12:10:00.000Z"),
      },
    ];
  }
}

class FakeCalendarStore {
  readonly lists: Parameters<
    NonNullable<
      Parameters<typeof createStoreBackedMcpResourceProvider>[0]["calendar"]
    >["listCalendarEventsForActor"]
  >[0][] = [];
  readonly reads: Parameters<
    NonNullable<
      Parameters<typeof createStoreBackedMcpResourceProvider>[0]["calendar"]
    >["getEventForActor"]
  >[0][] = [];

  async listCalendarEventsForActor(
    input: (typeof this.lists)[number],
  ): Promise<readonly CalendarEventRecord[]> {
    this.lists.push(input);
    return [calendarEventRecord()];
  }

  async getEventForActor(input: (typeof this.reads)[number]): Promise<CalendarEventRecord | null> {
    this.reads.push(input);
    return input.eventId === "event-1" ? calendarEventRecord() : null;
  }
}

class FakeMailStore {
  readonly searches: MailSearchRequest[] = [];
  readonly threadReads: MailThreadGetRequest[] = [];

  async search(input: MailSearchRequest): Promise<readonly MailSearchHit[]> {
    this.searches.push(input);
    return [
      {
        threadId: "thread-1",
        messageId: "message-1",
        subject: "Launch mail",
        preview: "Schedule moved to Friday.",
        sentAt: new Date("2026-05-20T12:00:00.000Z"),
        labels: ["inbox"],
        unread: false,
        starred: true,
      },
    ];
  }

  async getThread(input: MailThreadGetRequest): Promise<MailThreadDetail | null> {
    this.threadReads.push(input);
    if (input.threadId !== "thread-1") {
      return null;
    }
    return {
      id: "thread-1",
      subject: "Launch mail",
      preview: "Schedule moved to Friday.",
      participants: [],
      messages: [
        {
          id: "message-1",
          from: { address: "sender@example.com", name: "Sender" },
          to: [{ address: "agent@example.com" }],
          cc: [],
          bcc: [],
          sentAt: new Date("2026-05-20T12:00:00.000Z"),
          body: "Schedule moved to Friday.",
          bodyFormat: "plain",
          hasAttachment: false,
          attachments: [],
        },
      ],
      labels: ["inbox"],
      archivedAt: null,
      deletedAt: null,
      snoozedUntil: null,
      lastActivity: new Date("2026-05-20T12:00:00.000Z"),
      unread: false,
      starred: true,
      direction: "inbound",
    };
  }
}

function chatRoomRecord(): ChatRoomRecord {
  return {
    id: "room-1",
    orgId: "org-mcp",
    kind: "chat_room",
    subject: "Daily standup",
    createdByActorId: "agent-mcp",
    metadata: {},
    members: [
      {
        actorId: "agent-mcp",
        role: "owner",
        displayName: "Agent MCP",
        email: "agent@example.com",
      },
    ],
    settings: {
      threadId: "room-1",
      orgId: "org-mcp",
      name: "Daily standup",
      topic: "Launch status",
      isPrivate: false,
      metadata: {},
      createdAt: new Date("2026-05-20T12:00:00.000Z"),
      updatedAt: new Date("2026-05-20T12:10:00.000Z"),
    },
    createdAt: new Date("2026-05-20T12:00:00.000Z"),
    updatedAt: new Date("2026-05-20T12:10:00.000Z"),
  };
}

function calendarEventRecord(): CalendarEventRecord {
  return {
    id: "event-1",
    orgId: "org-mcp",
    calendarId: "calendar-1",
    threadId: null,
    uid: "event-1@helix.local",
    title: "Launch review",
    description: "Review launch readiness.",
    location: "Conference Room A",
    startsAt: new Date("2026-05-21T14:00:00.000Z"),
    endsAt: new Date("2026-05-21T15:00:00.000Z"),
    timezone: "UTC",
    allDay: false,
    status: "confirmed",
    recurrenceRule: null,
    organizerActorId: "agent-mcp",
    organizerEmail: "agent@example.com",
    icsSequence: 1,
    metadata: {},
    deletedAt: null,
    createdAt: new Date("2026-05-20T12:00:00.000Z"),
    updatedAt: new Date("2026-05-20T12:30:00.000Z"),
    attendees: [
      {
        actorId: "agent-mcp",
        email: "agent@example.com",
        displayName: "Agent MCP",
        responseStatus: "accepted",
      },
    ],
  };
}

class FakeDriveStore {
  readonly searches: Parameters<
    NonNullable<Parameters<typeof createStoreBackedMcpResourceProvider>[0]["drive"]>["search"]
  >[0][] = [];
  readonly reads: DriveFileReadInput[] = [];

  async search(input: (typeof this.searches)[number]): Promise<readonly DriveSearchHit[]> {
    this.searches.push(input);
    return [
      {
        objectId: "file-text",
        name: "Launch notes.txt",
        mimeType: "text/plain",
        byteSize: 16,
        sha256: null,
        folderId: null,
        preview: "Launch text file",
        updatedAt: new Date("2026-05-20T12:30:00.000Z"),
      },
    ];
  }

  async readFile(input: DriveFileReadInput): Promise<DriveFileReadResult | null> {
    this.reads.push(input);
    if (input.objectId === "file-text") {
      return {
        entry: driveEntry("file-text", "Launch notes.txt", "text/plain"),
        content: new TextEncoder().encode("Launch text file"),
      };
    }
    if (input.objectId === "file-binary") {
      return {
        entry: driveEntry("file-binary", "Launch deck.pdf", "application/pdf"),
        content: new Uint8Array([37, 80, 68, 70]),
      };
    }
    return null;
  }
}

class FakeDocsStore {
  readonly lists: Parameters<
    NonNullable<
      Parameters<typeof createStoreBackedMcpResourceProvider>[0]["docs"]
    >["listDocumentsForActor"]
  >[0][] = [];
  readonly reads: Parameters<
    NonNullable<
      Parameters<typeof createStoreBackedMcpResourceProvider>[0]["docs"]
    >["getDocsExportDocument"]
  >[0][] = [];

  async listDocumentsForActor(
    input: (typeof this.lists)[number],
  ): Promise<readonly DocsDocumentRecord[]> {
    this.lists.push(input);
    return [docsRecord()];
  }

  async getDocsExportDocument(
    input: (typeof this.reads)[number],
  ): Promise<DocsExportDocument | null> {
    this.reads.push(input);
    return input.docId === "doc-1"
      ? {
          id: "doc-1",
          title: "Launch plan",
          markdown: "The launch plan.",
          comments: [{ id: "comment-1", body: "Needs timeline." }],
          updatedAt: new Date("2026-05-20T13:00:00.000Z"),
        }
      : null;
  }
}

function driveEntry(id: string, name: string, mimeType: string): DriveEntryRecord {
  return {
    id,
    type: "file",
    name,
    folderId: null,
    ownerActorId: "agent-mcp",
    mimeType,
    byteSize: 16,
    sha256: null,
    storageKey: id,
    versionNumber: 1,
    metadata: {},
    deletedAt: null,
    createdAt: new Date("2026-05-20T12:00:00.000Z"),
    updatedAt: new Date("2026-05-20T12:30:00.000Z"),
  };
}

function docsRecord(): DocsDocumentRecord {
  return {
    id: "doc-1",
    orgId: "org-mcp",
    title: "Launch plan",
    threadId: null,
    ownerActorId: "agent-mcp",
    createdByActorId: "agent-mcp",
    ydocState: null,
    ydocStateVector: null,
    updateSeq: 1,
    metadata: {},
    deletedAt: null,
    createdAt: new Date("2026-05-20T12:00:00.000Z"),
    updatedAt: new Date("2026-05-20T13:00:00.000Z"),
  };
}
