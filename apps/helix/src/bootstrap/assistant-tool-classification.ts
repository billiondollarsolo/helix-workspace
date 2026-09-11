import {
  chatMessageSchema,
  chatRoomSchema,
  chatSearchHitSchema,
  driveEntryPageSchema,
  driveSearchHitSchema,
  mailSearchHitSchema,
  mailThreadsListResultSchema,
} from "@helix/contracts";
import { isJsonObject } from "@helix/sdk-types";
import { z } from "zod";
import {
  deriveClassification,
  isDataClassification,
  maxClassification,
  type DataClassification,
  type ResourceClassificationService,
} from "../platform/ai/classification/index.js";
import type { AssistantToolResultClassifier } from "../platform/assistant/types.js";

import { webSearchResultSchema } from "../platform/search/web.js";
import { webFetchResultSchema } from "../platform/search/web-fetch.js";

interface ResourceRef {
  readonly resourceType: string;
  readonly resourceId: string;
}
interface Source {
  readonly data: unknown;
  readonly refs: readonly ResourceRef[];
  readonly path?: string;
}
const roomsSchema = z.object({ rooms: chatRoomSchema.array() });
const messagesSchema = z.object({ messages: chatMessageSchema.array() });
const chatSearchSchema = z.object({ hits: chatSearchHitSchema.array() });
const driveSearchSchema = z.object({ hits: driveSearchHitSchema.array() });
const mailSearchSchema = z.object({ hits: mailSearchHitSchema.array() });
const mailThreadSchema = z.object({
  thread: z
    .object({
      id: z.string().min(1),
      subject: z.string(),
      preview: z.string(),
      labels: z.string().array(),
      messages: z
        .object({
          id: z.string().min(1),
          body: z.string(),
          attachments: z.unknown().array().optional(),
        })
        .passthrough()
        .array(),
    })
    .passthrough()
    .nullable(),
});

/** Classify only schema-checked core reads; arbitrary tool JSON never receives a permissive default. */
export function createAssistantToolResultClassifier(
  classifications: Pick<ResourceClassificationService, "get">,
): AssistantToolResultClassifier {
  return async ({ actor, toolId, output }) => {
    const sources = sourcesFor(toolId, output);
    if (sources === null) return "restricted";
    const signals = sourceSignals(output, toolId);
    let classification = deriveClassification({
      content: signals.text.join("\n"),
      scanContent: true,
      labels: signals.labels,
      ...(signals.explicit === undefined ? {} : { explicit: signals.explicit }),
    }).classification;
    const refs = new Map<string, ResourceRef>();
    for (const source of sources) {
      if (
        isJsonObject(source.data) &&
        source.data.orgId !== undefined &&
        source.data.orgId !== actor.orgId
      )
        return "restricted";
      if (source.path !== undefined)
        classification = maxClassification(
          classification,
          deriveClassification({ path: source.path }).classification,
        );
      for (const ref of source.refs) refs.set(`${ref.resourceType}:${ref.resourceId}`, ref);
    }
    const stored = await Promise.all(
      [...refs.values()].map((ref) => classifications.get({ orgId: actor.orgId, ...ref })),
    );
    for (const record of stored) {
      if (record === null) continue;
      if (record.orgId !== actor.orgId || !isDataClassification(record.classification))
        return "restricted";
      classification = maxClassification(classification, record.classification);
    }
    return classification;
  };
}

function sourcesFor(toolId: string, output: unknown): Source[] | null {
  switch (toolId) {
    case "web.fetch": {
      const result = webFetchResultSchema.safeParse(output);
      return result.success ? [{ data: result.data, refs: [] }] : null;
    }
    case "context.view":
    case "context.grep":
    case "memory.search":
    case "memory.list":
    case "chats.search":
    case "chats.view":
    case "ask.user":
      return [];
    case "web.search": {
      const result = webSearchResultSchema.safeParse(output);
      return result.success ? result.data.results.map((data) => ({ data, refs: [] })) : null;
    }
    case "chat.room.list":
    case "chat.room.discover": {
      const result = roomsSchema.safeParse(output);
      return result.success
        ? result.data.rooms.map((room) => ({ data: room, refs: roomRefs(room.id) }))
        : null;
    }
    case "chat.message.list":
    case "chat.thread.list": {
      const result = messagesSchema.safeParse(output);
      return result.success
        ? result.data.messages.map((message) => ({
            data: message,
            refs: [
              { resourceType: "chat.message", resourceId: message.id },
              ...roomRefs(message.roomId),
              ...fileRefs([
                ...message.attachmentObjectIds,
                ...(message.attachments?.map((attachment) => attachment.objectId) ?? []),
              ]),
            ],
          }))
        : null;
    }
    case "chat.search": {
      const result = chatSearchSchema.safeParse(output);
      return result.success
        ? result.data.hits.map((hit) => ({
            data: hit,
            refs: [
              { resourceType: "chat.message", resourceId: hit.messageId },
              ...roomRefs(hit.roomId),
            ],
          }))
        : null;
    }
    case "drive.list": {
      const result = driveEntryPageSchema.safeParse(output);
      return result.success
        ? result.data.entries.map((entry) => ({
            data: entry,
            path: entry.name,
            refs: [
              {
                resourceType: entry.type === "folder" ? "folder" : "drive.file",
                resourceId: entry.id,
              },
              ...(entry.folderId === null
                ? []
                : [{ resourceType: "folder", resourceId: entry.folderId }]),
            ],
          }))
        : null;
    }
    case "drive.search": {
      const result = driveSearchSchema.safeParse(output);
      return result.success
        ? result.data.hits.map((hit) => ({
            data: hit,
            path: hit.name,
            refs: [
              { resourceType: "drive.file", resourceId: hit.objectId },
              ...(hit.folderId === null
                ? []
                : [{ resourceType: "folder", resourceId: hit.folderId }]),
            ],
          }))
        : null;
    }
    case "mail.threads.list": {
      const result = mailThreadsListResultSchema.safeParse(output);
      return result.success
        ? result.data.threads.map((thread) => ({
            data: thread,
            refs: mailRefs(thread.threadId, thread.messageId),
          }))
        : null;
    }
    case "mail.search": {
      const result = mailSearchSchema.safeParse(output);
      return result.success
        ? result.data.hits.map((hit) => ({
            data: hit,
            refs: mailRefs(hit.threadId, hit.messageId),
          }))
        : null;
    }
    case "mail.thread.get": {
      const result = mailThreadSchema.safeParse(output);
      if (!result.success) return null;
      const thread = result.data.thread;
      if (thread === null) return [];
      return [
        {
          data: thread,
          refs: [
            { resourceType: "thread", resourceId: thread.id },
            { resourceType: "mail.thread", resourceId: thread.id },
          ],
        },
        ...thread.messages.map((message) => ({
          data: message,
          refs: [
            ...mailRefs(thread.id, message.id),
            ...fileRefs(
              (message.attachments ?? []).flatMap((attachment) =>
                isJsonObject(attachment) && typeof attachment.objectId === "string"
                  ? [attachment.objectId]
                  : [],
              ),
            ),
          ],
        })),
      ];
    }
    default:
      return null;
  }
}

function roomRefs(id: string): ResourceRef[] {
  return [
    { resourceType: "chat.room", resourceId: id },
    { resourceType: "thread", resourceId: id },
  ];
}
function mailRefs(threadId: string, messageId: string): ResourceRef[] {
  return [
    { resourceType: "mail.thread", resourceId: threadId },
    { resourceType: "thread", resourceId: threadId },
    { resourceType: "mail.message", resourceId: messageId },
  ];
}
function fileRefs(ids: readonly string[]): ResourceRef[] {
  return ids.map((resourceId) => ({ resourceType: "drive.file", resourceId }));
}

/** Scan actual returned values and metadata, excluding structural UUIDs from payment-card heuristics. */
function sourceSignals(value: unknown, toolId: string) {
  const roomRead = toolId === "chat.room.list" || toolId === "chat.room.discover";
  const text: string[] = [];
  const labels: string[] = [];
  let explicit: DataClassification | undefined;
  const raise = (candidate: unknown) => {
    if (candidate === undefined) return;
    const next = isDataClassification(candidate) ? candidate : "restricted";
    explicit = explicit === undefined ? next : maxClassification(explicit, next);
  };
  const visit = (part: unknown, key = "", path = "") => {
    if (typeof part === "string") {
      // This validated access enum is not a content sensitivity label.
      if (roomRead && path === "rooms.*.settings.privacy") return;
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(part) && key !== "sha256")
        text.push(part);
    } else if (Array.isArray(part)) {
      if (key === "labels")
        labels.push(...part.filter((label): label is string => typeof label === "string"));
      for (const item of part) visit(item, key, `${path}.*`);
    } else if (isJsonObject(part)) {
      raise(part.classification);
      raise(part.effectiveClassification);
      if (part.sensitivityLabel !== undefined)
        raise(
          isJsonObject(part.sensitivityLabel) ? part.sensitivityLabel.key : part.sensitivityLabel,
        );
      for (const [name, item] of Object.entries(part))
        visit(item, name, path ? `${path}.${name}` : name);
    }
  };
  visit(value);
  return { text, labels, explicit };
}
