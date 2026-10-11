import { z } from "zod";
import { actorHasScope } from "../../api/scopes.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";

const objectJsonSchema = { type: "object", additionalProperties: true } as const;
const statusInputSchema = z.object({}).strict();
const adminConfigScope = "admin.config.read";

export const MEET_UNAVAILABLE_MEMBER_MESSAGE =
  "Video meetings aren't set up for this workspace yet. Ask your administrator to connect a meeting server.";

/** What an administrator does to turn Meet on, naming the secrets still missing. */
function meetUnavailableAdminMessage(missingSecrets: readonly string[]): string {
  return (
    `Meet needs a Jitsi meeting server. Set ${missingSecrets.join(" and ")} to the secrets ` +
    "your Jitsi deployment shares with Helix (with MEET_JITSI_DOMAIN and MEET_JITSI_PUBLIC_URL " +
    "for its address), then restart Helix. Admin → Meet shows the meeting server status."
  );
}

/**
 * `meet.status`: whether video meetings are available. It is registered with
 * the Meet app even when the other Meet tools are not, so the web app can say
 * why Meet is off instead of failing on a missing tool.
 */
export function registerMeetStatusTool(
  registry: RuntimeToolRegistry,
  options: { readonly missingSecrets: readonly string[] },
): void {
  registry.register(
    defineTool<z.output<typeof statusInputSchema>, unknown>({
      id: "meet.status",
      description:
        "Whether video meetings are available in this workspace and, when they are not, what an administrator must configure.",
      permission: "meet.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(statusInputSchema, objectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), objectJsonSchema),
      handler: async (_input, ctx) => {
        if (options.missingSecrets.length === 0) return { available: true };
        const admin = actorHasScope(ctx.actor, adminConfigScope);
        return {
          available: false,
          reason: "not_configured",
          message: admin
            ? meetUnavailableAdminMessage(options.missingSecrets)
            : MEET_UNAVAILABLE_MEMBER_MESSAGE,
        };
      },
    }),
  );
}
