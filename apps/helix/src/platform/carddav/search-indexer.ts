import type { JsonValue } from "@helix/sdk-types";
import type { SearchEventIndexer, SearchIndexer, SearchIndexerEvent } from "../search/index.js";

export const cardDavSearchIndexerId = "contacts";

export function createCardDavSearchIndexer(): SearchIndexer {
  return {
    id: cardDavSearchIndexerId,
    subjects: ["activity.carddav.contact.>"],
    async route(event) {
      const contact = contactEvent(event);
      if (contact === undefined) return undefined;
      if (event.subject.endsWith(".deleted")) {
        return { orgId: contact.orgId, delete: [documentId(contact.contactId)] };
      }
      return {
        orgId: contact.orgId,
        upsert: [
          {
            id: documentId(contact.contactId),
            type: "contact",
            title: contact.displayName ?? contact.email ?? "Contact",
            body: [contact.displayName, contact.email].filter(Boolean).join("\n"),
            url: `/contacts/${contact.contactId}`,
            attributes: {
              orgId: contact.orgId,
              contactId: contact.contactId,
              addressBookId: contact.addressBookId,
              ownerActorId: contact.ownerActorId,
              ragVisibility: "private",
              ragOwnerActorId: contact.ownerActorId,
            },
          },
        ],
      };
    },
  };
}

export function registerCardDavIndexer(indexer: SearchEventIndexer): void {
  indexer.register(createCardDavSearchIndexer());
}

function contactEvent(event: SearchIndexerEvent):
  | {
      readonly orgId: string;
      readonly contactId: string;
      readonly addressBookId: string;
      readonly ownerActorId: string;
      readonly displayName: string | null;
      readonly email: string | null;
    }
  | undefined {
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    return undefined;
  }
  const value = event.payload as Record<string, JsonValue | undefined>;
  if (
    typeof value.orgId !== "string" ||
    typeof value.contactId !== "string" ||
    typeof value.addressBookId !== "string" ||
    typeof value.ownerActorId !== "string"
  ) {
    return undefined;
  }
  return {
    orgId: value.orgId,
    contactId: value.contactId,
    addressBookId: value.addressBookId,
    ownerActorId: value.ownerActorId,
    displayName: typeof value.displayName === "string" ? value.displayName : null,
    email: typeof value.email === "string" ? value.email : null,
  };
}

function documentId(contactId: string): string {
  return `contact:${contactId}`;
}
