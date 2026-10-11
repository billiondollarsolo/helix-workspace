import { z } from "zod";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { DriveStore } from "./store.js";
import { driveStorageUsageOutputSchema } from "./tool-output-schemas.js";

const storageUsageInputSchema = z.object({}).strict();

/** `drive.storage.usage`: the member's own Drive usage for the sidebar storage meter. */
export function createDriveStorageUsageTool(store: Pick<DriveStore, "getMemberStorageUsage">) {
  return defineTool<
    z.output<typeof storageUsageInputSchema>,
    z.output<typeof driveStorageUsageOutputSchema>
  >({
    id: "drive.storage.usage",
    description:
      "Read the current member's Drive storage usage and the organization storage limit, if an admin set one.",
    permission: "drive.read",
    sideEffects: "read",
    inputSchema: zodToolSchema(storageUsageInputSchema, {
      type: "object",
      additionalProperties: false,
    }),
    outputSchema: zodToolSchema(driveStorageUsageOutputSchema, {
      type: "object",
      additionalProperties: true,
    }),
    handler: async (_input, ctx) => {
      if (store.getMemberStorageUsage === undefined) {
        throw new Error("drive.storage.usage requires DriveStore.getMemberStorageUsage.");
      }
      return store.getMemberStorageUsage({ orgId: ctx.actor.orgId, actorId: ctx.actor.id });
    },
  });
}
