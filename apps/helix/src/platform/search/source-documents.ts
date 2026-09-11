import {
  calendarRecordToIndexDocument,
  type CalendarSearchProjectionStore,
} from "../calendar/index.js";
import { chatRecordToIndexDocument, type ChatSearchProjectionStore } from "../chat/index.js";
import { driveRecordToIndexDocument, type DriveSearchProjectionStore } from "../drive/index.js";
import { mailRecordToIndexDocument, type MailSearchProjectionStore } from "../mail/index.js";
import type { IndexDocument, SearchHit, SearchRequest } from "./types.js";

/** Reload authorized sources so stale snippets and labels cannot enter an AI prompt. */
export async function resolveSearchSourceDocument(
  stores: {
    readonly mail: MailSearchProjectionStore;
    readonly drive: DriveSearchProjectionStore;
    readonly chat: ChatSearchProjectionStore;
    readonly calendar: CalendarSearchProjectionStore & {
      getEventForActor(input: {
        readonly orgId: string;
        readonly actorId: string;
        readonly eventId: string;
      }): Promise<object | null>;
    };
  },
  request: SearchRequest,
  hit: SearchHit,
): Promise<IndexDocument | null> {
  const attributes = hit.attributes ?? {};
  let document: IndexDocument | null;
  if (hit.type === "mail") {
    if (
      typeof attributes.messageId !== "string" ||
      typeof attributes.orgId !== "string" ||
      request.forActorId === undefined
    )
      return null;
    const record = await stores.mail.getMailSearchRecord({
      orgId: attributes.orgId,
      actorId: request.forActorId,
      messageId: attributes.messageId,
    });
    document = record === null ? null : mailRecordToIndexDocument(record);
  } else if (hit.type === "drive") {
    if (typeof attributes.fileId !== "string") return null;
    const record = await stores.drive.getDriveSearchRecord(attributes.fileId);
    document =
      record === null || record.trashedAt !== undefined || record.deletedAt !== undefined
        ? null
        : driveRecordToIndexDocument(record);
  } else if (hit.type === "chat") {
    if (typeof attributes.messageId !== "string") return null;
    const record = await stores.chat.getChatSearchRecord(attributes.messageId);
    document =
      record === null || record.deletedAt !== undefined ? null : chatRecordToIndexDocument(record);
  } else if (hit.type === "calendar") {
    if (
      typeof attributes.eventId !== "string" ||
      request.forOrgId === undefined ||
      request.forActorId === undefined
    )
      return null;
    const record = await stores.calendar.getCalendarSearchRecord(attributes.eventId);
    document =
      record === null || record.deletedAt !== undefined || record.status === "cancelled"
        ? null
        : calendarRecordToIndexDocument(record);
    if (
      (await stores.calendar.getEventForActor({
        orgId: request.forOrgId,
        actorId: request.forActorId,
        eventId: attributes.eventId,
      })) === null
    )
      return null;
  } else return hit;
  if (document === null || document.attributes?.orgId !== request.forOrgId) return null;
  if (
    document.attributes?.ragVisibility === "private" &&
    document.attributes.ragOwnerActorId !== request.forActorId
  )
    return null;
  if (
    (document.type === "chat" || document.type === "drive") &&
    (!Array.isArray(document.attributes?.allowedActorIds) ||
      request.forActorId === undefined ||
      !document.attributes.allowedActorIds.includes(request.forActorId))
  )
    return null;
  return document;
}
