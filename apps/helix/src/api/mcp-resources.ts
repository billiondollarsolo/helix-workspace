import type { Actor } from "@helix/sdk-types";
import type { McpResource, McpResourceContent, McpResourceProvider } from "./mcp.js";
import type { CalendarEventRecord } from "../platform/calendar/types.js";
import type { ChatMessageRecord, ChatRoomRecord } from "../platform/chat/types.js";
import type { DriveEntryRecord, DriveSearchHit } from "../platform/drive/types.js";
import type {
  DriveFileReadInput,
  DriveFileReadResult,
  DriveFileStreamResult,
} from "../platform/drive/store.js";
import type { MailSearchHit, MailThreadDetail, MailThreadMessage } from "../platform/mail/types.js";
export interface StoreBackedMcpResourceProviderOptions {
  readonly chat?: {
    listRooms(input: {
      readonly orgId: string;
      readonly actorId: string;
      readonly query?: string;
      readonly limit?: number;
    }): Promise<readonly ChatRoomRecord[]>;
    listMessages(input: {
      readonly orgId: string;
      readonly actorId: string;
      readonly roomId: string;
      readonly limit?: number;
    }): Promise<readonly ChatMessageRecord[]>;
    getRoomForActor(input: {
      readonly orgId: string;
      readonly actorId: string;
      readonly roomId: string;
    }): Promise<ChatRoomRecord | null>;
  };
  readonly calendar?: {
    listCalendarEventsForActor(input: {
      readonly orgId: string;
      readonly actorId: string;
      readonly startsAt?: Date;
      readonly endsAt?: Date;
      readonly limit?: number;
    }): Promise<readonly CalendarEventRecord[]>;
    getEventForActor(input: {
      readonly orgId: string;
      readonly actorId: string;
      readonly eventId: string;
    }): Promise<CalendarEventRecord | null>;
  };
  readonly mail?: {
    search(input: {
      readonly orgId: string;
      readonly actorId: string;
      readonly query?: string;
      readonly limit?: number;
    }): Promise<readonly MailSearchHit[]>;
    getThread(input: {
      readonly orgId: string;
      readonly actorId: string;
      readonly threadId: string;
    }): Promise<MailThreadDetail | null>;
  };
  readonly drive?: {
    search(input: {
      readonly orgId: string;
      readonly actorId: string;
      readonly query?: string;
      readonly limit?: number;
    }): Promise<readonly DriveSearchHit[]>;
    readFile?(input: DriveFileReadInput): Promise<DriveFileReadResult | null>;
    openFile?(input: DriveFileReadInput): Promise<DriveFileStreamResult | null>;
  };
  readonly limit?: number;
}
export function createStoreBackedMcpResourceProvider(
  options: StoreBackedMcpResourceProviderOptions,
): McpResourceProvider {
  const limit = options.limit ?? 25;
  return {
    async list(actor) {
      const resources: McpResource[] = [];
      if (options.chat !== undefined && canRead(actor, "chat.read")) {
        const rooms = await options.chat.listRooms({
          orgId: actor.orgId,
          actorId: actor.id,
          query: "",
          limit,
        });
        resources.push(...rooms.map(chatRoomToResource));
      }
      if (options.calendar !== undefined && canRead(actor, "calendar.read")) {
        const events = await options.calendar.listCalendarEventsForActor({
          orgId: actor.orgId,
          actorId: actor.id,
          startsAt: new Date(0),
          limit,
        });
        resources.push(...events.map(calendarEventToResource));
      }
      if (options.mail !== undefined && canRead(actor, "mail.read")) {
        const hits = await options.mail.search({
          orgId: actor.orgId,
          actorId: actor.id,
          query: "",
          limit,
        });
        resources.push(...hits.map(mailHitToResource));
      }
      if (options.drive !== undefined && canRead(actor, "drive.read")) {
        const hits = await options.drive.search({
          orgId: actor.orgId,
          actorId: actor.id,
          query: "",
          limit,
        });
        resources.push(...hits.map(driveHitToResource));
      }
      return resources;
    },
    async read(actor, uri) {
      const parsed = parseStoreResourceUri(uri);
      if (parsed === null) {
        return null;
      }
      if (parsed.kind === "mail") {
        if (options.mail === undefined || !canRead(actor, "mail.read")) {
          return null;
        }
        const thread = await options.mail.getThread({
          orgId: actor.orgId,
          actorId: actor.id,
          threadId: parsed.id,
        });
        return thread === null
          ? null
          : {
              uri,
              mimeType: "text/markdown",
              text: mailThreadToMarkdown(thread),
            };
      }
      if (parsed.kind === "drive") {
        if (options.drive === undefined || !canRead(actor, "drive.read")) {
          return null;
        }
        const input = {
          orgId: actor.orgId,
          actorId: actor.id,
          objectId: parsed.id,
        };
        if (options.drive.openFile !== undefined) {
          const file = await options.drive.openFile(input);
          return file === null ? null : driveStreamToContent(uri, file);
        }
        if (options.drive.readFile === undefined) return null;
        const file = await options.drive.readFile(input);
        return file === null ? null : driveFileToContent(uri, file);
      }
      if (parsed.kind === "chat") {
        if (options.chat === undefined || !canRead(actor, "chat.read")) {
          return null;
        }
        const room = await options.chat.getRoomForActor({
          orgId: actor.orgId,
          actorId: actor.id,
          roomId: parsed.id,
        });
        if (room === null) {
          return null;
        }
        const messages = await options.chat.listMessages({
          orgId: actor.orgId,
          actorId: actor.id,
          roomId: parsed.id,
          limit: 25,
        });
        return {
          uri,
          mimeType: "text/markdown",
          text: chatRoomToMarkdown(room, messages),
        };
      }
      if (options.calendar === undefined || !canRead(actor, "calendar.read")) {
        return null;
      }
      const event = await options.calendar.getEventForActor({
        orgId: actor.orgId,
        actorId: actor.id,
        eventId: parsed.id,
      });
      return event === null
        ? null
        : {
            uri,
            mimeType: "text/markdown",
            text: calendarEventToMarkdown(event),
          };
    },
  };
}
type ParsedStoreResourceUri =
  | {
      readonly kind: "chat";
      readonly id: string;
    }
  | {
      readonly kind: "calendar";
      readonly id: string;
    }
  | {
      readonly kind: "mail";
      readonly id: string;
    }
  | {
      readonly kind: "drive";
      readonly id: string;
    };
function parseStoreResourceUri(uri: string): ParsedStoreResourceUri | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== "helix:") {
    return null;
  }
  const [resourceType, ...idParts] = parsed.pathname.split("/").filter(Boolean);
  if (resourceType === undefined || idParts.length === 0) {
    return null;
  }
  const id = decodeURIComponent(idParts.join("/"));
  if (parsed.hostname === "chat" && resourceType === "room") {
    return { kind: "chat", id };
  }
  if (parsed.hostname === "calendar" && resourceType === "event") {
    return { kind: "calendar", id };
  }
  if (parsed.hostname === "mail" && resourceType === "thread") {
    return { kind: "mail", id };
  }
  if (parsed.hostname === "drive" && resourceType === "file") {
    return { kind: "drive", id };
  }
  return null;
}
function canRead(
  actor: Actor,
  scope: "chat.read" | "calendar.read" | "mail.read" | "drive.read",
): boolean {
  return actor.type === "system" || (actor.scopes ?? []).includes(scope);
}
function chatRoomToResource(room: ChatRoomRecord): McpResource {
  return {
    uri: `helix://chat/room/${encodeURIComponent(room.id)}`,
    name: room.settings?.name ?? room.subject ?? "Chat room",
    description: `Chat room updated ${room.updatedAt.toISOString()}`,
    mimeType: "text/markdown",
  };
}
function calendarEventToResource(event: CalendarEventRecord): McpResource {
  return {
    uri: `helix://calendar/event/${encodeURIComponent(event.id)}`,
    name: event.title,
    description: `Calendar event starts ${event.startsAt.toISOString()}`,
    mimeType: "text/markdown",
  };
}
function mailHitToResource(hit: MailSearchHit): McpResource {
  return {
    uri: `helix://mail/thread/${encodeURIComponent(hit.threadId)}`,
    name: hit.subject,
    description: `Mail thread updated ${hit.sentAt.toISOString()}`,
    mimeType: "text/markdown",
  };
}
function driveHitToResource(hit: DriveSearchHit): McpResource {
  return {
    uri: `helix://drive/file/${encodeURIComponent(hit.objectId)}`,
    name: hit.name,
    description: `Drive file updated ${hit.updatedAt.toISOString()}`,
    mimeType: hit.mimeType,
  };
}
function chatRoomToMarkdown(room: ChatRoomRecord, messages: readonly ChatMessageRecord[]): string {
  const lines = [
    `# ${room.settings?.name ?? room.subject ?? "Chat room"}`,
    "",
    `Type: chat room`,
    `Room ID: ${room.id}`,
    `Kind: ${room.kind}`,
    `Updated: ${room.updatedAt.toISOString()}`,
    ...(room.settings?.topic === null || room.settings?.topic === undefined
      ? []
      : [`Topic: ${room.settings.topic}`]),
    "",
  ];
  for (const message of [...messages].reverse()) {
    lines.push(
      `## Message ${message.id} - ${message.sentAt.toISOString()}`,
      ...(message.actorId === null ? [] : [`Actor: ${message.actorId}`]),
      "",
      message.body,
      "",
    );
  }
  return lines.join("\n").trimEnd();
}
function calendarEventToMarkdown(event: CalendarEventRecord): string {
  return [
    `# ${event.title}`,
    "",
    `Type: calendar event`,
    `Event ID: ${event.id}`,
    `Calendar ID: ${event.calendarId}`,
    `Status: ${event.status}`,
    `Starts: ${event.startsAt.toISOString()}`,
    `Ends: ${event.endsAt.toISOString()}`,
    ...(event.location === null || event.location === undefined
      ? []
      : [`Location: ${event.location}`]),
    ...(event.description === null || event.description === undefined
      ? []
      : ["", event.description]),
    ...(event.attendees.length === 0
      ? []
      : [
          "",
          "## Attendees",
          ...event.attendees.map(
            (attendee) =>
              `- ${attendee.displayName ?? attendee.email} (${attendee.responseStatus})`,
          ),
        ]),
  ]
    .join("\n")
    .trimEnd();
}
function mailThreadToMarkdown(thread: MailThreadDetail): string {
  const lines = [
    `# ${thread.subject}`,
    "",
    `Type: mail thread`,
    `Thread ID: ${thread.id}`,
    `Last activity: ${thread.lastActivity.toISOString()}`,
    ...(thread.labels.length === 0 ? [] : [`Labels: ${thread.labels.join(", ")}`]),
    "",
  ];
  for (const message of thread.messages) {
    lines.push(...mailMessageToMarkdown(message), "");
  }
  return lines.join("\n").trimEnd();
}
function mailMessageToMarkdown(message: MailThreadMessage): readonly string[] {
  return [
    `## ${formatMailAddress(message.from) || "Message"} - ${message.sentAt.toISOString()}`,
    ...(message.to.length === 0 ? [] : [`To: ${message.to.map(formatMailAddress).join(", ")}`]),
    ...(message.cc.length === 0 ? [] : [`Cc: ${message.cc.map(formatMailAddress).join(", ")}`]),
    "",
    message.body,
  ];
}
function formatMailAddress(address: MailThreadMessage["from"]): string {
  if (address === undefined) {
    return "";
  }
  const email = address.email ?? address.address;
  return address.name === undefined ? email : `${address.name} <${email}>`;
}
function driveFileToContent(uri: string, file: DriveFileReadResult): McpResourceContent {
  if (file.content !== null && isTextLikeMimeType(file.entry.mimeType)) {
    return {
      uri,
      mimeType: file.entry.mimeType ?? "text/plain",
      text: new TextDecoder().decode(file.content),
    };
  }
  return {
    uri,
    mimeType: "text/markdown",
    text: driveFileToMarkdown(file.entry),
  };
}
const MAX_MCP_DRIVE_TEXT_BYTES = 1024 * 1024;
async function driveStreamToContent(
  uri: string,
  file: DriveFileStreamResult,
): Promise<McpResourceContent> {
  if (!isTextLikeMimeType(file.entry.mimeType)) {
    return { uri, mimeType: "text/markdown", text: driveFileToMarkdown(file.entry) };
  }
  const length = Math.min(file.byteSize, MAX_MCP_DRIVE_TEXT_BYTES);
  const body = await file.open(
    length === 0 ? undefined : { start: 0, end: Math.max(0, length - 1) },
  );
  if (body === null)
    return { uri, mimeType: "text/markdown", text: driveFileToMarkdown(file.entry) };
  const bytes = await collectDriveText(body, MAX_MCP_DRIVE_TEXT_BYTES);
  const text = new TextDecoder().decode(bytes);
  return {
    uri,
    mimeType: file.entry.mimeType ?? "text/plain",
    text:
      file.byteSize > bytes.byteLength
        ? `${text}\n\n[Truncated after ${String(bytes.byteLength)} bytes]`
        : text,
  };
}
async function collectDriveText(
  body: Uint8Array | AsyncIterable<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body.subarray(0, limit);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    const remaining = limit - size;
    if (remaining <= 0) break;
    const bounded = chunk.subarray(0, remaining);
    chunks.push(bounded);
    size += bounded.byteLength;
    if (bounded.byteLength < chunk.byteLength || size === limit) break;
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
function isTextLikeMimeType(mimeType: string | undefined): boolean {
  if (mimeType === undefined) {
    return false;
  }
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType.endsWith("+json") ||
    mimeType === "application/xml" ||
    mimeType.endsWith("+xml") ||
    mimeType === "application/javascript"
  );
}
function driveFileToMarkdown(entry: DriveEntryRecord): string {
  return [
    `# ${entry.name}`,
    "",
    `Type: drive file`,
    `Object ID: ${entry.id}`,
    ...(entry.mimeType === undefined ? [] : [`MIME type: ${entry.mimeType}`]),
    ...(entry.byteSize === undefined ? [] : [`Size: ${String(entry.byteSize)} bytes`]),
    `Updated: ${entry.updatedAt.toISOString()}`,
    "",
    "Content is not available as MCP text for this file.",
  ].join("\n");
}
