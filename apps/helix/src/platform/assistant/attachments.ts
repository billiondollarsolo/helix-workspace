import { z } from "zod";
import type { AssistantMessage } from "./types.js";
import { assistantAttachmentLimits } from "./attachment-limits.js";
import { assistantToolGroupIds } from "./tool-selection.js";
import { projectAssistantWebSources } from "./tool-sources.js";

const activitySchema = z.array(
  z.object({
    toolCallId: z.string().min(1),
    toolId: z.string().min(1),
    status: z.enum(["running", "executed", "failed", "skipped", "pending_confirmation"]),
    error: z.string().optional(),
  }),
);
const sourceSchema = z.object({
  id: z.string(),
  type: z.enum(["web.search", "web.fetch"]),
  title: z.string().optional(),
  url: z.string(),
  classification: z.enum(["public", "standard"]),
  trust: z.literal("untrusted_retrieved"),
  provenance: z.object({ sourceId: z.string(), sourceType: z.string(), orgId: z.string() }),
});
const groupsSchema = z.array(z.enum(assistantToolGroupIds)).max(assistantToolGroupIds.length);

const attachmentsSchema = z
  .array(
    z.object({
      objectId: z.string().uuid(),
      name: z.string(),
      mimeType: z.string(),
      byteSize: z.number().int().nonnegative(),
    }),
  )
  .max(assistantAttachmentLimits.maxFiles);

/** Only the server's stored references become attachment chips or subsequent context. */
export function projectAssistantMessages(
  messages: readonly AssistantMessage[],
): readonly AssistantMessage[] {
  return messages.map((message) => {
    const parsed = attachmentsSchema.safeParse(message.metadata.attachments);
    const sources = Array.isArray(message.metadata.sources)
      ? message.metadata.sources.flatMap((source) => {
          const parsedSource = sourceSchema.safeParse(source);
          return parsedSource.success ? [parsedSource.data] : [];
        })
      : undefined;
    const activity = activitySchema.safeParse(message.metadata.toolActivity);
    const groups = groupsSchema.safeParse(message.metadata.toolGroups);
    return {
      ...message,
      ...(parsed.success && parsed.data.length ? { attachments: parsed.data } : {}),
      ...(message.role === "assistant" && sources !== undefined
        ? {
            sources: projectAssistantWebSources({
              orgId: message.orgId,
              existingSources: sources.map(({ title, ...source }) => ({
                ...source,
                ...(title === undefined ? {} : { title }),
              })),
              toolCalls: [],
            }),
          }
        : {}),
      ...(message.role === "assistant" && activity.success
        ? {
            toolActivity: activity.data.map(({ error, ...entry }) => ({
              ...entry,
              ...(error === undefined ? {} : { error }),
            })),
          }
        : {}),
      ...(message.role === "user" && groups.success ? { toolGroups: groups.data } : {}),
      ...(message.role === "user" && typeof message.metadata.webSearch === "boolean"
        ? { webSearch: message.metadata.webSearch }
        : {}),
    };
  });
}
