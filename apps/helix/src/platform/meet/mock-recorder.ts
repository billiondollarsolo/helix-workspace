/* Mock recorder — dev tool to simulate Jibri's finalize step.
 *
 * Jibri (production) records audio+video to disk, runs finalize.sh which
 * uploads to S3 and POSTs /webhook/jitsi. On macOS the kernel-module
 * dependency means Jibri can't actually run, so this tool stands in:
 * it puts a placeholder mp4 in the same bucket Jibri would write to and
 * calls the same `attachRecording` flow the webhook does.
 *
 * Result: notifications fire, the meeting row gains a Recording button,
 * the Drive Recordings folder lists the artifact, and the byte stream
 * is fetchable through the existing /api/drive/objects/:id/content path
 * — all without a working video pipeline. */

import { createHash } from "node:crypto";
import { z } from "zod";
import type { ToolDefinition } from "@helix/sdk-types";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { S3CompatibleStorageClient } from "../storage/s3-compatible.js";
import type { MeetStore } from "./store.js";

const mockRecordSchema = z.object({
  roomName: z.string().min(1).max(128),
});

const genericObjectJsonSchema = { type: "object", additionalProperties: true } as const;

export interface CreateMockRecorderToolsOptions {
  readonly meetStore: MeetStore;
  /** Same storage client that DriveStore uses. When undefined, the tool
   *  skips the upload step and just creates the row — useful in tests. */
  readonly storage?: S3CompatibleStorageClient;
  readonly bucket?: string;
}

export function createMockRecorderToolDefinitions(
  options: CreateMockRecorderToolsOptions,
): readonly ToolDefinition[] {
  return [
    defineTool<z.output<typeof mockRecordSchema>, unknown>({
      id: "meet.mock-record",
      description:
        "Dev-only: simulate a Jibri-produced recording for a meet room. " +
        "Uploads a placeholder mp4 + attaches it to the room exactly like " +
        "the production /webhook/jitsi flow.",
      permission: "meet.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(mockRecordSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const room = await options.meetStore.getRoomByName({
          orgId: ctx.actor.orgId,
          roomName: input.roomName,
        });
        if (room === null) {
          throw new Error(`Unknown Meet room: ${input.roomName}`);
        }
        const epoch = Date.now();
        const storageKey = `recordings/${room.roomName}/${String(epoch)}.mp4`;
        // Tiny marker payload — enough for the byte-stream endpoint to
        // return something playable in `<video>` (Chrome will fail to
        // decode but show the loading state). For real playback in dev,
        // run Jibri on a Linux host.
        const body = Buffer.from(
          `MOCK-RECORDER mp4 placeholder for ${room.roomName} @ ${String(epoch)}`,
        );
        const sha256 = createHash("sha256").update(body).digest("hex");
        if (options.storage !== undefined && options.bucket !== undefined) {
          await options.storage.put({
            key: storageKey,
            body,
            contentType: "video/mp4",
            metadata: { roomName: room.roomName, source: "mock-recorder" },
          });
        }
        const attachment = await options.meetStore.attachRecording({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          roomId: room.id,
          storageKey,
          mimeType: "video/mp4",
          byteSize: body.byteLength,
          sha256,
          startedAt: new Date(epoch - 60_000),
          endedAt: new Date(epoch),
          metadata: { source: "mock-recorder" },
        });
        if (attachment === null) {
          throw new Error(
            `attachRecording returned null for room: ${room.id}`,
          );
        }
        return {
          attachment,
          uploaded: options.storage !== undefined,
          byteSize: body.byteLength,
        };
      },
    }),
  ];
}

export function registerMockRecorderTools(
  registry: RuntimeToolRegistry,
  options: CreateMockRecorderToolsOptions,
): void {
  for (const tool of createMockRecorderToolDefinitions(options)) {
    registry.register(tool);
  }
}

function defineTool<Input, Output>(
  tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return tool;
}
