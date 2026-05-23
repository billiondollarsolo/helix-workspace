import { pathToFileURL } from "node:url";
import type postgres from "postgres";
import { createSqlClient } from "./client.js";
import { DEFAULT_LOCAL_OAUTH_ORG_ID } from "./seed-local-oauth.js";
import { createDemoTimeline, LOCAL_DEMO_IDS } from "./seed-local-demo.js";
import { calendarRecordToIndexDocument } from "../platform/calendar/search/indexer.js";
import { PostgresCalendarStore } from "../platform/calendar/store.js";
import { chatRecordToIndexDocument } from "../platform/chat/search/indexer.js";
import { PostgresChatStore } from "../platform/chat/store.js";
import { docsRecordToIndexDocument } from "../platform/docs/search/indexer.js";
import { PostgresDocsStore } from "../platform/docs/store.js";
import { driveRecordToIndexDocument } from "../platform/drive/search/indexer.js";
import { PostgresDriveStore } from "../platform/drive/store.js";
import { mailRecordToIndexDocument } from "../platform/mail/search/indexer.js";
import { PostgresMailStore } from "../platform/mail/store.js";
import {
  createMeilisearchSearchEngineFromEnv,
  type IndexDocument,
  type SearchEngine,
} from "../platform/search/index.js";

export interface IndexLocalDemoSearchOptions {
  readonly orgId?: string;
  readonly anchorDate?: string | Date | undefined;
  readonly searchEngine?: SearchEngine;
}

export interface IndexLocalDemoSearchResult {
  readonly searchConfigured: boolean;
  readonly indexedDocuments: number;
  readonly documentIds: readonly string[];
}

export type LocalDemoSearchDocumentType = "mail" | "drive" | "docs" | "calendar" | "chat";

export interface LocalDemoSearchDocumentDescriptor {
  readonly type: LocalDemoSearchDocumentType;
  readonly recordId: string;
  readonly expectedId: string;
  readonly query: string;
  readonly expectedTitle: string;
  readonly expectedUrl: string;
  readonly attributeIdKey: string;
  readonly expectedAttributes?: Record<string, unknown>;
  readonly expectedBodyIncludes?: readonly string[];
}

export function localDemoSearchDocumentsForAnchor(
  anchorDate: string | Date | undefined,
): readonly LocalDemoSearchDocumentDescriptor[] {
  const timeline = createDemoTimeline(anchorDate);
  return LOCAL_DEMO_SEARCH_DOCUMENTS.map((document) => {
    if (document.type !== "calendar") {
      return document;
    }
    const expectedAttributes: Record<string, unknown> = document.expectedAttributes;
    return {
      ...document,
      expectedAttributes: {
        ...expectedAttributes,
        startsAt: shiftIsoAttribute(expectedAttributes.startsAt, timeline),
        endsAt: shiftIsoAttribute(expectedAttributes.endsAt, timeline),
      },
    };
  });
}

export async function indexLocalDemoSearch(
  sql: postgres.Sql,
  options: IndexLocalDemoSearchOptions = {},
): Promise<IndexLocalDemoSearchResult> {
  const engine = options.searchEngine ?? (await createLocalDemoSearchEngineFromEnv());
  if (engine === undefined) {
    return { searchConfigured: false, indexedDocuments: 0, documentIds: [] };
  }

  const orgId = options.orgId ?? DEFAULT_LOCAL_OAUTH_ORG_ID;
  const documents = await demoIndexDocuments(sql, orgId);
  await engine.upsert(documents);
  return {
    searchConfigured: true,
    indexedDocuments: documents.length,
    documentIds: documents.map((document) => document.id),
  };
}

async function demoIndexDocuments(
  sql: postgres.Sql,
  orgId: string,
): Promise<readonly IndexDocument[]> {
  const mail = new PostgresMailStore(sql);
  const drive = new PostgresDriveStore(sql);
  const docs = new PostgresDocsStore(sql);
  const calendar = new PostgresCalendarStore(sql);
  const chat = new PostgresChatStore(sql);

  const documents: IndexDocument[] = [];
  for (const messageId of searchRecordIds("mail")) {
    const record = await mail.getMailSearchRecord(messageId);
    if (record !== null && record.orgId === orgId) {
      documents.push(mailRecordToIndexDocument(record));
    }
  }
  for (const fileId of searchRecordIds("drive")) {
    const record = await drive.getDriveSearchRecord(fileId);
    if (record !== null && record.orgId === orgId) {
      documents.push(driveRecordToIndexDocument(record));
    }
  }
  for (const docId of searchRecordIds("docs")) {
    const record = await docs.getDocsSearchRecord(docId);
    if (record !== null && record.orgId === orgId) {
      documents.push(docsRecordToIndexDocument(record));
    }
  }
  for (const eventId of searchRecordIds("calendar")) {
    const record = await calendar.getCalendarSearchRecord(eventId);
    if (record !== null && record.orgId === orgId) {
      documents.push(calendarRecordToIndexDocument(record));
    }
  }
  for (const messageId of searchRecordIds("chat")) {
    const record = await chat.getChatSearchRecord(messageId);
    if (record !== null && record.orgId === orgId) {
      documents.push(chatRecordToIndexDocument(record));
    }
  }
  return documents;
}

export const LOCAL_DEMO_SEARCH_DOCUMENTS = [
  {
    type: "mail",
    recordId: LOCAL_DEMO_IDS.mailAmazonMessage,
    expectedId: `mail:${LOCAL_DEMO_IDS.mailAmazonMessage}`,
    query: "Amazon arriving",
    expectedTitle: "3 items from Amazon arriving tomorrow",
    expectedUrl: `/mail/${LOCAL_DEMO_IDS.mailAmazonThread}?message=${LOCAL_DEMO_IDS.mailAmazonMessage}`,
    attributeIdKey: "messageId",
    expectedAttributes: {
      threadId: LOCAL_DEMO_IDS.mailAmazonThread,
      messageId: LOCAL_DEMO_IDS.mailAmazonMessage,
      from: "shipment-tracking@amazon.example",
      fromName: "Amazon",
      labels: ["inbox", "purchases"],
      direction: "inbound",
    },
    expectedBodyIncludes: ["Track package delivery"],
  },
  {
    type: "mail",
    recordId: LOCAL_DEMO_IDS.mailRenovateMessage,
    expectedId: `mail:${LOCAL_DEMO_IDS.mailRenovateMessage}`,
    query: "Renovate",
    expectedTitle: "[AlphaBravoCompany/remotedialer] Run failed: Renovate - main",
    expectedUrl: `/mail/${LOCAL_DEMO_IDS.mailRenovateThread}?message=${LOCAL_DEMO_IDS.mailRenovateMessage}`,
    attributeIdKey: "messageId",
    expectedAttributes: {
      threadId: LOCAL_DEMO_IDS.mailRenovateThread,
      messageId: LOCAL_DEMO_IDS.mailRenovateMessage,
      from: "mjtechguy@example.com",
      fromName: "mjtechguy",
      labels: ["inbox", "updates"],
      direction: "inbound",
    },
    expectedBodyIncludes: ["manual review"],
  },
  {
    type: "mail",
    recordId: LOCAL_DEMO_IDS.mailPlanningMessage,
    expectedId: `mail:${LOCAL_DEMO_IDS.mailPlanningMessage}`,
    query: "expanded responsibilities",
    expectedTitle: "Request to revisit compensation for expanded responsibilities",
    expectedUrl: `/mail/${LOCAL_DEMO_IDS.mailPlanningThread}?message=${LOCAL_DEMO_IDS.mailPlanningMessage}`,
    attributeIdKey: "messageId",
    expectedAttributes: {
      threadId: LOCAL_DEMO_IDS.mailPlanningThread,
      messageId: LOCAL_DEMO_IDS.mailPlanningMessage,
      from: "maya@helix.local",
      fromName: "Maya Sharma",
      labels: ["inbox", "important"],
      direction: "inbound",
    },
    expectedBodyIncludes: ["platform ownership"],
  },
  {
    type: "mail",
    recordId: LOCAL_DEMO_IDS.mailPianoMessage,
    expectedId: `mail:${LOCAL_DEMO_IDS.mailPianoMessage}`,
    query: "piano lesson",
    expectedTitle: "4:40 piano lesson reminder",
    expectedUrl: `/mail/${LOCAL_DEMO_IDS.mailPianoThread}?message=${LOCAL_DEMO_IDS.mailPianoMessage}`,
    attributeIdKey: "messageId",
    expectedAttributes: {
      threadId: LOCAL_DEMO_IDS.mailPianoThread,
      messageId: LOCAL_DEMO_IDS.mailPianoMessage,
      from: "erica@helix.local",
      fromName: "Erica Johnson",
      labels: ["inbox", "family"],
      direction: "inbound",
    },
    expectedBodyIncludes: ["recital note"],
  },
  {
    type: "drive",
    recordId: LOCAL_DEMO_IDS.driveFileAiServices,
    expectedId: `drive:${LOCAL_DEMO_IDS.driveFileAiServices}`,
    query: "AI Services",
    expectedTitle: "AI Services and Keys",
    expectedUrl: `/drive/${LOCAL_DEMO_IDS.driveFileAiServices}`,
    attributeIdKey: "fileId",
    expectedAttributes: {
      fileId: LOCAL_DEMO_IDS.driveFileAiServices,
      kind: "file",
      mimeType: "text/markdown",
      path: ["AI Services and Keys"],
    },
  },
  {
    type: "drive",
    recordId: LOCAL_DEMO_IDS.driveFileTraining,
    expectedId: `drive:${LOCAL_DEMO_IDS.driveFileTraining}`,
    query: "Training Course",
    expectedTitle: "Training Course Links",
    expectedUrl: `/drive/${LOCAL_DEMO_IDS.driveFileTraining}`,
    attributeIdKey: "fileId",
    expectedAttributes: {
      fileId: LOCAL_DEMO_IDS.driveFileTraining,
      kind: "file",
      mimeType: "text/plain",
      parentFolderId: LOCAL_DEMO_IDS.driveFolderProjects,
      path: ["Projects", "Training Course Links"],
    },
  },
  {
    type: "docs",
    recordId: LOCAL_DEMO_IDS.docsQuarterly,
    expectedId: `docs:${LOCAL_DEMO_IDS.docsQuarterly}`,
    query: "Quarterly Planning",
    expectedTitle: "Quarterly Planning Notes",
    expectedUrl: `/docs/${LOCAL_DEMO_IDS.docsQuarterly}`,
    attributeIdKey: "docId",
    expectedAttributes: {
      docId: LOCAL_DEMO_IDS.docsQuarterly,
      tags: ["planning", "product"],
    },
    expectedBodyIncludes: ["Tighten mail list density"],
  },
  {
    type: "docs",
    recordId: LOCAL_DEMO_IDS.docsRunbook,
    expectedId: `docs:${LOCAL_DEMO_IDS.docsRunbook}`,
    query: "Local Testing",
    expectedTitle: "Local Testing Runbook",
    expectedUrl: `/docs/${LOCAL_DEMO_IDS.docsRunbook}`,
    attributeIdKey: "docId",
    expectedAttributes: {
      docId: LOCAL_DEMO_IDS.docsRunbook,
      tags: ["runbook", "local"],
    },
    expectedBodyIncludes: ["seeded OAuth client"],
  },
  {
    type: "calendar",
    recordId: LOCAL_DEMO_IDS.eventOrderMatch,
    expectedId: `calendar:${LOCAL_DEMO_IDS.eventOrderMatch}`,
    query: "Order match",
    expectedTitle: "Order match ball",
    expectedUrl: `/calendar/events/${LOCAL_DEMO_IDS.eventOrderMatch}`,
    attributeIdKey: "eventId",
    expectedAttributes: {
      calendarId: LOCAL_DEMO_IDS.calendarPrimary,
      eventId: LOCAL_DEMO_IDS.eventOrderMatch,
      startsAt: "2026-05-20T14:00:00.000Z",
      endsAt: "2026-05-20T15:00:00.000Z",
      location: "Indoor Court 2",
      status: "confirmed",
      icsUid: "demo-order-match@helix.local",
    },
    expectedBodyIncludes: ["payment receipt"],
  },
  {
    type: "calendar",
    recordId: LOCAL_DEMO_IDS.eventPlanning,
    expectedId: `calendar:${LOCAL_DEMO_IDS.eventPlanning}`,
    query: "Product planning",
    expectedTitle: "Product planning review",
    expectedUrl: `/calendar/events/${LOCAL_DEMO_IDS.eventPlanning}`,
    attributeIdKey: "eventId",
    expectedAttributes: {
      calendarId: LOCAL_DEMO_IDS.calendarPrimary,
      eventId: LOCAL_DEMO_IDS.eventPlanning,
      startsAt: "2026-05-21T17:00:00.000Z",
      endsAt: "2026-05-21T17:45:00.000Z",
      location: "Helix Meet",
      status: "confirmed",
      icsUid: "demo-planning@helix.local",
    },
    expectedBodyIncludes: ["Drive, docs, and calendar flows"],
  },
  {
    type: "chat",
    recordId: LOCAL_DEMO_IDS.chatMessageLaunchPlan,
    expectedId: `chat:${LOCAL_DEMO_IDS.chatMessageLaunchPlan}`,
    query: "real seeded Mail",
    expectedTitle: "Helix launch room",
    expectedUrl: `/chat/${LOCAL_DEMO_IDS.chatRoomLaunch}?message=${LOCAL_DEMO_IDS.chatMessageLaunchPlan}`,
    attributeIdKey: "messageId",
    expectedAttributes: {
      roomId: LOCAL_DEMO_IDS.chatRoomLaunch,
      roomName: "Helix launch room",
      messageId: LOCAL_DEMO_IDS.chatMessageLaunchPlan,
    },
    expectedBodyIncludes: ["real seeded Mail"],
  },
  {
    type: "chat",
    recordId: LOCAL_DEMO_IDS.chatMessageMailDensity,
    expectedId: `chat:${LOCAL_DEMO_IDS.chatMessageMailDensity}`,
    query: "Mail density",
    expectedTitle: "Helix launch room",
    expectedUrl: `/chat/${LOCAL_DEMO_IDS.chatRoomLaunch}?message=${LOCAL_DEMO_IDS.chatMessageMailDensity}`,
    attributeIdKey: "messageId",
    expectedAttributes: {
      roomId: LOCAL_DEMO_IDS.chatRoomLaunch,
      roomName: "Helix launch room",
      messageId: LOCAL_DEMO_IDS.chatMessageMailDensity,
      reactions: ["ok"],
    },
    expectedBodyIncludes: ["Mail density"],
  },
  {
    type: "chat",
    recordId: LOCAL_DEMO_IDS.chatMessageCalendarPreview,
    expectedId: `chat:${LOCAL_DEMO_IDS.chatMessageCalendarPreview}`,
    query: "Calendar preview",
    expectedTitle: "Helix launch room",
    expectedUrl: `/chat/${LOCAL_DEMO_IDS.chatRoomLaunch}?message=${LOCAL_DEMO_IDS.chatMessageCalendarPreview}`,
    attributeIdKey: "messageId",
    expectedAttributes: {
      roomId: LOCAL_DEMO_IDS.chatRoomLaunch,
      roomName: "Helix launch room",
      messageId: LOCAL_DEMO_IDS.chatMessageCalendarPreview,
    },
    expectedBodyIncludes: ["Calendar preview"],
  },
] as const;

function searchRecordIds(type: LocalDemoSearchDocumentType): readonly string[] {
  return LOCAL_DEMO_SEARCH_DOCUMENTS.filter((document) => document.type === type).map(
    (document) => document.recordId,
  );
}

function shiftIsoAttribute(
  value: unknown,
  timeline: ReturnType<typeof createDemoTimeline>,
): unknown {
  return typeof value === "string" ? timeline.at(value).toISOString() : value;
}

export async function createLocalDemoSearchEngineFromEnv(): Promise<SearchEngine | undefined> {
  return createMeilisearchSearchEngineFromEnv();
}

async function main(): Promise<void> {
  const sql = createSqlClient();
  try {
    const result = await indexLocalDemoSearch(sql);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
