import { describe, expect, it } from "vitest";
import type {
  AICallContext,
  AICapability,
  Actor,
  ChatRequest,
  ChatResponse,
  EventBus,
  EventEnvelope,
  JsonValue,
  SuggestionSlotProviderCapability,
  TraceContext,
  Unsubscribe,
} from "@helix/sdk-types";
import { SearchEventIndexer } from "../search/event-indexer.js";
import type { IndexDocument, SearchEngine, SearchRequest, SearchResponse } from "../search/types.js";
import { createDriveSuggestionSlotProviders, registerDriveIndexer } from "./index.js";
import type { DriveActor, DriveSearchProjectionStore, DriveSearchRecord, DriveShareRole } from "./types.js";

describe("drive AI/search flow", () => {
  it("covers upload finalize list share move trash restore delete search and AI with fakes", async () => {
    const ada: Actor = {
      id: "actor-ada",
      orgId: "org-1",
      type: "user",
      displayName: "Ada",
      email: "ada@example.com",
    };
    const bruno: Actor = {
      id: "actor-bruno",
      orgId: "org-1",
      type: "user",
      displayName: "Bruno",
      email: "bruno@example.com",
    };
    const events = new FakeEventBus();
    const engine = new FakeSearchEngine();
    const drive = new FakeDriveService(events);
    const ai = new FakeAI();

    const indexer = new SearchEventIndexer({ events, engine });
    registerDriveIndexer(indexer, drive);
    await indexer.start();

    const folder = await drive.createFolder({ actor: ada, name: "Launch" });
    const upload = await drive.upload({
      actor: ada,
      name: "roadmap.png",
      mimeType: "image/png",
      byteSize: 2048,
    });
    const file = await drive.finalize({
      actor: ada,
      uploadId: upload.uploadId,
      sha256: "sha256-roadmap",
      textContent: "Q3 launch roadmap image with risks, milestones, and owner notes.",
      tags: ["roadmap", "launch"],
    });
    const rootList = drive.list({ actor: ada });
    await drive.share({ actor: ada, fileId: file.id, target: bruno, role: "viewer" });
    const moved = await drive.move({ actor: ada, fileId: file.id, parentFolderId: folder.id });
    const folderList = drive.list({ actor: ada, parentFolderId: folder.id });

    const search = await engine.search({
      query: "q3 launch risks",
      types: ["drive"],
      filter: `attributes.parentFolderId = "${folder.id}"`,
    });

    await drive.trash({ actor: ada, fileId: file.id });
    const trashedSearch = await engine.search({ query: "q3 launch risks", types: ["drive"] });
    await drive.restore({ actor: ada, fileId: file.id });
    const restoredSearch = await engine.search({ query: "q3 launch risks", types: ["drive"] });

    const providers = createDriveSuggestionSlotProviders({ ai });
    const describeImage = requiredProvider(providers, "drive.describe-image");
    const summarizeFile = requiredProvider(providers, "drive.summarize-file");
    const description = await collectSuggestion(
      describeImage.generate({
        actor: ada,
        feature: "drive.describe-image",
        resource: { type: "drive.file", id: file.id, orgId: "org-1" },
        input: {
          name: moved.name,
          mimeType: moved.mimeType,
          path: moved.path ?? [],
          tags: moved.tags ?? [],
          ocrText: moved.textContent ?? "",
        },
      }),
    );
    const summary = await collectSuggestion(
      summarizeFile.generate({
        actor: ada,
        feature: "drive.summarize-file",
        resource: { type: "drive.file", id: file.id, orgId: "org-1" },
        input: {
          name: moved.name,
          mimeType: moved.mimeType,
          path: moved.path ?? [],
          text: moved.textContent ?? "",
        },
      }),
    );

    await drive.delete({ actor: ada, fileId: file.id });
    const deletedSearch = await engine.search({ query: "q3 launch risks", types: ["drive"] });
    await indexer.stop();

    expect(upload.uploadUrl).toContain("upload-1");
    expect(rootList.map((item) => item.id)).toEqual(expect.arrayContaining([folder.id, file.id]));
    expect(drive.shares(file.id)).toEqual([{ actorId: bruno.id, role: "viewer" }]);
    expect(moved.parentFolderId).toBe(folder.id);
    expect(folderList.map((item) => item.id)).toEqual([file.id]);
    expect(search.hits.map((hit) => hit.id)).toContain(`drive:${file.id}`);
    expect(search.hits.every((hit) => hit.type === "drive")).toBe(true);
    expect(trashedSearch.hits.map((hit) => hit.id)).not.toContain(`drive:${file.id}`);
    expect(restoredSearch.hits.map((hit) => hit.id)).toContain(`drive:${file.id}`);
    expect(description).toContain("Image:");
    expect(summary).toContain("Summary:");
    expect(ai.calls.map((call) => call.feature)).toEqual(
      expect.arrayContaining(["drive.describe-image", "drive.summarize-file"]),
    );
    expect(deletedSearch.hits.map((hit) => hit.id)).not.toContain(`drive:${file.id}`);
  });
});

interface UploadInput {
  readonly actor: Actor;
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly parentFolderId?: string | undefined;
}

interface FinalizeInput {
  readonly actor: Actor;
  readonly uploadId: string;
  readonly sha256?: string | undefined;
  readonly textContent?: string | undefined;
  readonly tags?: readonly string[] | undefined;
}

interface CreateFolderInput {
  readonly actor: Actor;
  readonly name: string;
  readonly parentFolderId?: string | undefined;
}

interface FileInput {
  readonly actor: Actor;
  readonly fileId: string;
}

interface ShareInput extends FileInput {
  readonly target: Actor;
  readonly role: DriveShareRole;
}

interface MoveInput extends FileInput {
  readonly parentFolderId?: string | undefined;
}

interface ListInput {
  readonly actor: Actor;
  readonly parentFolderId?: string | undefined;
  readonly includeTrashed?: boolean | undefined;
}

interface UploadSession extends UploadInput {
  readonly uploadId: string;
  readonly uploadUrl: string;
  readonly storageKey: string;
}

interface ShareRecord {
  readonly actorId: string;
  readonly role: DriveShareRole;
}

class FakeDriveService implements DriveSearchProjectionStore {
  readonly #uploads = new Map<string, UploadSession>();
  readonly #records = new Map<string, DriveSearchRecord>();
  readonly #shares = new Map<string, ShareRecord[]>();
  #nextUpload = 1;
  #nextFile = 1;
  #nextFolder = 1;

  constructor(private readonly events: EventBus) {}

  async upload(input: UploadInput): Promise<UploadSession> {
    const uploadId = `upload-${String(this.#nextUpload)}`;
    this.#nextUpload += 1;
    const session: UploadSession = {
      ...input,
      uploadId,
      uploadUrl: `https://storage.example.test/uploads/${uploadId}`,
      storageKey: `orgs/${input.actor.orgId}/uploads/${uploadId}/${input.name}`,
    };
    this.#uploads.set(uploadId, session);
    await this.events.publish("activity.drive.upload.created", { uploadId, actorId: input.actor.id });
    return session;
  }

  async finalize(input: FinalizeInput): Promise<DriveSearchRecord> {
    const upload = this.#uploads.get(input.uploadId);
    if (upload === undefined) {
      throw new Error(`unknown upload ${input.uploadId}`);
    }
    const id = `file-${String(this.#nextFile)}`;
    this.#nextFile += 1;
    const record = this.withPath({
      id,
      orgId: input.actor.orgId,
      kind: "file",
      name: upload.name,
      mimeType: upload.mimeType,
      byteSize: upload.byteSize,
      storageKey: upload.storageKey,
      owner: actorToDriveActor(input.actor),
      parentFolderId: upload.parentFolderId,
      createdAt: now(),
      updatedAt: now(),
      ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
      ...(input.textContent === undefined ? {} : { textContent: input.textContent }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
    });
    this.#records.set(id, record);
    this.#uploads.delete(input.uploadId);
    await this.events.publish("activity.drive.file.created", { fileId: id, uploadId: input.uploadId });
    return record;
  }

  async createFolder(input: CreateFolderInput): Promise<DriveSearchRecord> {
    const id = `folder-${String(this.#nextFolder)}`;
    this.#nextFolder += 1;
    const folder = this.withPath({
      id,
      orgId: input.actor.orgId,
      kind: "folder",
      name: input.name,
      mimeType: "application/vnd.helix.folder",
      byteSize: 0,
      owner: actorToDriveActor(input.actor),
      parentFolderId: input.parentFolderId,
      createdAt: now(),
      updatedAt: now(),
    });
    this.#records.set(id, folder);
    await this.events.publish("activity.drive.folder.created", { fileId: id });
    return folder;
  }

  list(input: ListInput): readonly DriveSearchRecord[] {
    return [...this.#records.values()]
      .filter((record) => record.orgId === input.actor.orgId)
      .filter((record) => record.deletedAt === undefined)
      .filter((record) => input.includeTrashed === true || record.trashedAt === undefined)
      .filter((record) => record.parentFolderId === input.parentFolderId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async share(input: ShareInput): Promise<void> {
    this.requireRecord(input.fileId);
    const existing = this.#shares.get(input.fileId) ?? [];
    this.#shares.set(input.fileId, [...existing.filter((share) => share.actorId !== input.target.id), {
      actorId: input.target.id,
      role: input.role,
    }]);
    await this.events.publish("activity.drive.file.shared", {
      fileId: input.fileId,
      actorId: input.actor.id,
      targetActorId: input.target.id,
      role: input.role,
    });
  }

  async move(input: MoveInput): Promise<DriveSearchRecord> {
    const existing = this.requireRecord(input.fileId);
    const moved = this.withPath({
      ...existing,
      parentFolderId: input.parentFolderId,
      updatedAt: now(),
    });
    this.#records.set(input.fileId, moved);
    await this.events.publish("activity.drive.file.moved", {
      fileId: input.fileId,
      actorId: input.actor.id,
      parentFolderId: input.parentFolderId ?? null,
    });
    return moved;
  }

  async trash(input: FileInput): Promise<DriveSearchRecord> {
    const existing = this.requireRecord(input.fileId);
    const trashed = { ...existing, trashedAt: now(), updatedAt: now() };
    this.#records.set(input.fileId, trashed);
    await this.events.publish("activity.drive.file.trashed", { fileId: input.fileId, actorId: input.actor.id });
    return trashed;
  }

  async restore(input: FileInput): Promise<DriveSearchRecord> {
    const existing = this.requireRecord(input.fileId);
    const { trashedAt: _trashedAt, ...restoredRecord } = existing;
    void _trashedAt;
    const restored = { ...restoredRecord, updatedAt: now() };
    this.#records.set(input.fileId, restored);
    await this.events.publish("activity.drive.file.restored", { fileId: input.fileId, actorId: input.actor.id });
    return restored;
  }

  async delete(input: FileInput): Promise<void> {
    const existing = this.requireRecord(input.fileId);
    this.#records.set(input.fileId, { ...existing, deletedAt: now(), updatedAt: now() });
    await this.events.publish("activity.drive.file.deleted", { fileId: input.fileId, actorId: input.actor.id });
  }

  shares(fileId: string): readonly ShareRecord[] {
    return this.#shares.get(fileId) ?? [];
  }

  async getDriveSearchRecord(fileId: string): Promise<DriveSearchRecord | null> {
    return this.#records.get(fileId) ?? null;
  }

  private requireRecord(fileId: string): DriveSearchRecord {
    const record = this.#records.get(fileId);
    if (record === undefined) {
      throw new Error(`unknown drive file ${fileId}`);
    }
    return record;
  }

  private withPath(record: Omit<DriveSearchRecord, "path">): DriveSearchRecord {
    const folderPath = record.parentFolderId === undefined ? [] : (this.#records.get(record.parentFolderId)?.path ?? []);
    return {
      ...record,
      path: [...folderPath, record.name],
    };
  }
}

function actorToDriveActor(actor: Actor): DriveActor {
  return {
    id: actor.id,
    ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
    ...(actor.email === undefined ? {} : { email: actor.email }),
  };
}

async function collectSuggestion(chunks: AsyncIterable<{ readonly text: string }>): Promise<string> {
  const text: string[] = [];
  for await (const chunk of chunks) {
    text.push(chunk.text);
  }
  return text.join("");
}

function requiredProvider(
  providers: readonly SuggestionSlotProviderCapability[],
  slotId: string,
): SuggestionSlotProviderCapability {
  const provider = providers.find((candidate) => candidate.slotId === slotId);
  if (provider === undefined) {
    throw new Error(`${slotId} provider missing`);
  }
  return provider;
}

class FakeSearchEngine implements SearchEngine {
  readonly id = "fake-search";
  readonly docs = new Map<string, IndexDocument>();

  async index(document: IndexDocument): Promise<void> {
    this.docs.set(document.id, document);
  }

  async upsert(documents: readonly IndexDocument[]): Promise<void> {
    for (const document of documents) {
      this.docs.set(document.id, document);
    }
  }

  async delete(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      this.docs.delete(id);
    }
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const terms = request.query.toLowerCase().split(/\s+/u).filter(Boolean);
    const hits = [...this.docs.values()].filter((document) => {
      const haystack = `${document.title ?? ""}\n${document.body ?? ""}`.toLowerCase();
      const matchesQuery = terms.every((term) => haystack.includes(term));
      const matchesType = request.types === undefined || request.types.includes(document.type);
      const matchesFilter = matchesDriveFilter(document, request.filter);
      return matchesQuery && matchesType && matchesFilter;
    });
    return { hits, query: request.query, estimatedTotalHits: hits.length };
  }
}

class FakeAI implements AICapability {
  readonly calls: ChatRequest[] = [];

  async chat(request: ChatRequest, _ctx?: Partial<AICallContext>): Promise<ChatResponse> {
    void _ctx;
    this.calls.push(request);
    if (request.feature === "drive.describe-image") {
      return {
        message: "Image: A roadmap board showing launch milestones, risks, and owner notes.",
        model: "fake-model",
        providerId: "fake-ai",
      };
    }
    return {
      message: "Summary: The file captures Q3 launch milestones, risks, and ownership notes.",
      model: "fake-model",
      providerId: "fake-ai",
    };
  }
}

class FakeEventBus implements EventBus {
  readonly subscriptions: string[] = [];
  readonly #subscribers: {
    readonly subject: string;
    readonly handler: (event: EventEnvelope) => Promise<void>;
  }[] = [];

  async publish(subject: string, payload: JsonValue, trace?: TraceContext): Promise<void> {
    const event: EventEnvelope = {
      subject,
      payload,
      occurredAt: now(),
      ...(trace === undefined ? {} : { trace }),
    };
    for (const subscriber of this.#subscribers) {
      if (subjectMatches(subscriber.subject, subject)) {
        await subscriber.handler(event);
      }
    }
  }

  async subscribe<Payload extends JsonValue>(
    subject: string,
    handler: (event: EventEnvelope<Payload>) => Promise<void>,
  ): Promise<Unsubscribe> {
    this.subscriptions.push(subject);
    const subscriber = {
      subject,
      handler: handler as (event: EventEnvelope) => Promise<void>,
    };
    this.#subscribers.push(subscriber);
    return () => {
      const index = this.#subscribers.indexOf(subscriber);
      if (index >= 0) {
        this.#subscribers.splice(index, 1);
      }
    };
  }
}

function matchesDriveFilter(document: IndexDocument, filter: SearchRequest["filter"]): boolean {
  const filters = typeof filter === "string" ? [filter] : (filter ?? []);
  const parentFolderId = document.attributes?.parentFolderId;
  return filters.every((candidate) => {
    const match = /attributes\.parentFolderId\s*=\s*"([^"]+)"/u.exec(candidate);
    return match === null ? true : parentFolderId === match[1];
  });
}

function subjectMatches(pattern: string, subject: string): boolean {
  const patternParts = pattern.split(".");
  const subjectParts = subject.split(".");

  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    if (patternPart === ">") {
      return index === patternParts.length - 1;
    }
    if (subjectParts[index] === undefined) {
      return false;
    }
    if (patternPart !== "*" && patternPart !== subjectParts[index]) {
      return false;
    }
  }

  return patternParts.length === subjectParts.length;
}

function now(): string {
  return "2026-05-20T00:00:00.000Z";
}
