import { z } from "zod";
import { authenticatedFetch } from "@/lib/auth";
import { parseResponse } from "./api-response";

const actorSchema = z.object({
  id: z.string(),
  type: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
});
const count = z.number().int().nonnegative();
const previewSchema = z.object({
  source: actorSchema,
  successor: actorSchema.nullable(),
  counts: z.object({
    driveFiles: count,
    driveFolders: count,
    mailMessages: count,
    mailDrafts: count,
    calendars: count,
    contacts: count,
    addressBooks: count,
    assistantConversations: count,
    assistantMemories: count,
  }),
  blockers: z.array(z.string()),
  receivingAddresses: z.array(z.string()),
  preserveReceivingAddresses: z.boolean(),
  confirmationToken: z.string(),
});
export type OffboardPreview = z.infer<typeof previewSchema>;
interface OffboardChoices {
  readonly successorActorId?: string;
  readonly preserveReceivingAddresses: boolean;
}
export async function previewOffboarding(
  actorId: string,
  input: OffboardChoices,
): Promise<OffboardPreview> {
  const response = await authenticatedFetch(
    `/api/admin/users/${encodeURIComponent(actorId)}/offboard/preview`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return parseResponse(response, "preview account handoff", previewSchema);
}
export async function offboardAccount(
  actorId: string,
  input: OffboardChoices & { readonly confirmationToken: string },
) {
  const response = await authenticatedFetch(
    `/api/admin/users/${encodeURIComponent(actorId)}/offboard`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return parseResponse(
    response,
    "offboard account",
    z.object({
      offboard: z.object({
        actorId: z.string(),
        orgId: z.string(),
        disabled: z.boolean(),
        sessionsRevoked: count,
        appPasswordsRevoked: count,
        agentCredentialsRevoked: count,
      }),
    }),
  );
}
