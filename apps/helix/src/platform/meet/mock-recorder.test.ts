import { describe, expect, it } from "vitest";
import type { StorageObject, ToolContext } from "@helix/sdk-types";
import {
  createMockRecorderToolDefinitions,
  type CreateMockRecorderToolsOptions,
} from "./mock-recorder.js";
import type { AttachMeetRecordingInput, MeetStore } from "./store.js";
import type {
  MeetMeetingRecord,
  MeetRecordingAttachmentRecord,
  MeetRoomRecord,
  MeetSummaryRef,
} from "./types.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const threadId = "44444444-4444-4444-8444-444444444444";
const objectId = "55555555-5555-4555-8555-555555555555";
const messageId = "66666666-6666-4666-8666-666666666666";

describe("mock recorder tools", () => {
  it("writes placeholder recordings through the tenant storage resolver", async () => {
    const store = new FakeMeetStore();
    const storage = new RecordingStorageClient();
    const resolvedOrgIds: string[] = [];

    const output = await runMockRecord({
      meetStore: store,
      storageResolver: async ({ orgId: resolvedOrgId }) => {
        resolvedOrgIds.push(resolvedOrgId);
        return {
          client: storage,
          managedBy: "helix-default",
          prefix: "tenants/org-1/",
        };
      },
    });

    const result = mockRecorderOutput(output);
    expect(result.uploaded).toBe(true);
    expect(result.byteSize).toBeGreaterThan(0);
    expect(result.attachment).toMatchObject({ roomId, threadId, objectId, messageId });
    expect(resolvedOrgIds).toEqual([orgId]);
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0]?.key).toMatch(/^recordings\/Launch Review\//u);
    expect(storage.puts[0]?.contentType).toBe("video/mp4");
    expect(storage.puts[0]?.metadata).toEqual({
      roomName: "Launch Review",
      source: "mock-recorder",
    });
    expect(store.attachments).toHaveLength(1);
    expect(store.attachments[0]).toMatchObject({
      orgId,
      actorId,
      roomId,
      storageKey: storage.puts[0]?.key,
      mimeType: "video/mp4",
      metadata: { source: "mock-recorder" },
    });
  });

  it("falls back to metadata-only attachment when storage is unavailable", async () => {
    const store = new FakeMeetStore();

    const output = await runMockRecord({ meetStore: store });

    const result = mockRecorderOutput(output);
    expect(result.uploaded).toBe(false);
    expect(result.attachment).toMatchObject({ roomId, threadId, objectId, messageId });
    expect(store.attachments).toHaveLength(1);
    expect(store.attachments[0]?.storageKey).toMatch(/^recordings\/Launch Review\//u);
  });
});

async function runMockRecord(options: CreateMockRecorderToolsOptions): Promise<unknown> {
  const tool = createMockRecorderToolDefinitions(options)[0];
  if (tool === undefined) {
    throw new Error("Mock recorder tool was not registered.");
  }
  return tool.handler({ roomName: "Launch Review" }, toolContext());
}

function toolContext(): ToolContext {
  return {
    actor: {
      id: actorId,
      orgId,
      type: "user",
    },
    async can() {
      return true;
    },
    async requirePermission() {},
    async audit() {},
  };
}

interface MockRecorderOutput {
  readonly uploaded: boolean;
  readonly byteSize: number;
  readonly attachment: MeetRecordingAttachmentRecord;
}

function mockRecorderOutput(value: unknown): MockRecorderOutput {
  if (
    typeof value !== "object" ||
    value === null ||
    !("uploaded" in value) ||
    typeof value.uploaded !== "boolean" ||
    !("byteSize" in value) ||
    typeof value.byteSize !== "number" ||
    !("attachment" in value) ||
    typeof value.attachment !== "object" ||
    value.attachment === null
  ) {
    throw new Error("Unexpected mock recorder output.");
  }
  return value as MockRecorderOutput;
}

class RecordingStorageClient {
  readonly puts: StorageObject[] = [];

  async put(object: StorageObject): Promise<void> {
    this.puts.push(object);
  }

  async get(): Promise<StorageObject | null> {
    throw new Error("Not implemented for mock recorder tests.");
  }

  async delete(): Promise<void> {
    throw new Error("Not implemented for mock recorder tests.");
  }
}

class FakeMeetStore implements MeetStore {
  readonly attachments: AttachMeetRecordingInput[] = [];

  async createRoom(): Promise<MeetRoomRecord> {
    throw new Error("Not implemented for mock recorder tests.");
  }

  async listRoomsForActor(): Promise<readonly MeetRoomRecord[]> {
    throw new Error("Not implemented for mock recorder tests.");
  }

  async listMeetingsForActor(): Promise<readonly MeetMeetingRecord[]> {
    throw new Error("Not implemented for mock recorder tests.");
  }

  async getRoomForActor(): Promise<MeetRoomRecord | null> {
    throw new Error("Not implemented for mock recorder tests.");
  }

  async getRoomById(): Promise<MeetRoomRecord | null> {
    throw new Error("Not implemented for mock recorder tests.");
  }

  async getRoomByName(): Promise<MeetRoomRecord | null> {
    return {
      id: roomId,
      orgId,
      threadId,
      roomName: "Launch Review",
      subject: "Launch Review",
      jitsiDomain: "meet.example.com",
      createdByActorId: actorId,
      startedAt: new Date("2026-05-20T14:00:00.000Z"),
      endedAt: null,
      scheduledStartAt: null,
      scheduledEndAt: null,
      status: "active",
      metadata: {},
      createdAt: new Date("2026-05-20T14:00:00.000Z"),
      updatedAt: new Date("2026-05-20T14:00:00.000Z"),
    };
  }

  async endRoom(): Promise<MeetRoomRecord | null> {
    throw new Error("Not implemented for mock recorder tests.");
  }

  async attachRecording(
    input: AttachMeetRecordingInput,
  ): Promise<MeetRecordingAttachmentRecord | null> {
    this.attachments.push(input);
    return {
      roomId,
      threadId,
      objectId,
      messageId,
      storageKey: input.storageKey,
    };
  }

  async attachSummary(): Promise<MeetSummaryRef | null> {
    throw new Error("Not implemented for mock recorder tests.");
  }
}
