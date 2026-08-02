import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";
import { callTool } from "@/lib/tool-call";

/**
 * Admin Console — Chat retention, legal hold, and organization export.
 *
 * Calls the real Chat admin tools under `/api/tools/`:
 *  - `chat.retention.get` / `chat.retention.set`
 *  - `chat.legal_hold.set`
 *  - `chat.export.organization`
 *
 * Every tool response is validated at the trust boundary with Zod so a
 * malformed payload never reaches the React tree. Write tools require
 * confirmation server-side; `callTool` auto-approves after the UI has already
 * collected explicit operator intent (Save / Enable hold / Run export).
 */

/** Platform defaults when no `chat_retention_policies` row exists for the org. */
export const CHAT_PLATFORM_DEFAULT_RETENTION_DAYS = 2555;
export const CHAT_PLATFORM_DEFAULT_EDIT_WINDOW_SECONDS = 86_400;
export const CHAT_PLATFORM_DEFAULT_DELETE_WINDOW_SECONDS = 86_400;

const uuidSchema = z.string().uuid();

export const chatRetentionPolicyViewSchema = z.object({
  orgId: uuidSchema,
  roomId: uuidSchema.nullable(),
  retentionDays: z.number().int().min(1).max(36_500),
  editWindowSeconds: z.number().int().min(0).max(31_536_000),
  deleteWindowSeconds: z.number().int().min(0).max(31_536_000),
  legalHold: z.boolean(),
  updatedAt: z.string().nullable(),
  configured: z.boolean(),
});

export type ChatRetentionPolicyView = z.infer<typeof chatRetentionPolicyViewSchema>;

export const chatRetentionPolicyResultSchema = z.object({
  orgId: uuidSchema,
  roomId: uuidSchema.nullable(),
  retentionDays: z.number().int(),
  editWindowSeconds: z.number().int(),
  deleteWindowSeconds: z.number().int(),
  legalHold: z.boolean(),
  updatedAt: z.string(),
});

export type ChatRetentionPolicyResult = z.infer<typeof chatRetentionPolicyResultSchema>;

export const chatExportMessageSchema = z.object({
  id: uuidSchema,
  roomId: uuidSchema,
  actorId: uuidSchema.nullable(),
  body: z.string().nullable(),
  bodyFormat: z.enum(["plain", "markdown"]),
  sentAt: z.string(),
  editedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});

export const chatExportResultSchema = z.object({
  exportId: uuidSchema,
  orgId: uuidSchema,
  generatedAt: z.string(),
  truncated: z.boolean(),
  messages: z.array(chatExportMessageSchema),
});

export type ChatExportResult = z.infer<typeof chatExportResultSchema>;

export interface ChatRetentionFormInput {
  readonly retentionDays: string;
  readonly editWindowSeconds: string;
  readonly deleteWindowSeconds: string;
  readonly roomId: string;
}

export interface ChatLegalHoldFormInput {
  readonly enabled: boolean;
  readonly roomId: string;
}

export interface ChatExportFormInput {
  readonly from: string;
  readonly to: string;
  readonly limit: string;
  readonly roomIds: string;
}

export type MappedRetentionInput =
  | {
      readonly retentionDays: number;
      readonly editWindowSeconds: number;
      readonly deleteWindowSeconds: number;
      readonly roomId?: string;
    }
  | string;

export type MappedLegalHoldInput =
  | {
      readonly enabled: boolean;
      readonly roomId?: string;
    }
  | string;

export type MappedExportInput =
  | {
      readonly roomIds: readonly string[];
      readonly from?: string;
      readonly to?: string;
      readonly limit: number;
    }
  | string;

/** Pure form → tool input mapper for retention (driven by unit tests). */
export function mapRetentionFormToToolInput(form: ChatRetentionFormInput): MappedRetentionInput {
  const retentionDays = parsePositiveInt(form.retentionDays, "Retention days", 1, 36_500);
  if (typeof retentionDays === "string") return retentionDays;
  const editWindowSeconds = parseNonNegativeInt(
    form.editWindowSeconds,
    "Edit window (seconds)",
    31_536_000,
  );
  if (typeof editWindowSeconds === "string") return editWindowSeconds;
  const deleteWindowSeconds = parseNonNegativeInt(
    form.deleteWindowSeconds,
    "Delete window (seconds)",
    31_536_000,
  );
  if (typeof deleteWindowSeconds === "string") return deleteWindowSeconds;

  const roomId = form.roomId.trim();
  if (roomId !== "" && !uuidSchema.safeParse(roomId).success) {
    return "Room ID must be a valid UUID when provided.";
  }

  return {
    retentionDays,
    editWindowSeconds,
    deleteWindowSeconds,
    ...(roomId === "" ? {} : { roomId }),
  };
}

/** Pure form → tool input mapper for legal hold. */
export function mapLegalHoldFormToToolInput(form: ChatLegalHoldFormInput): MappedLegalHoldInput {
  const roomId = form.roomId.trim();
  if (roomId !== "" && !uuidSchema.safeParse(roomId).success) {
    return "Room ID must be a valid UUID when provided.";
  }
  return {
    enabled: form.enabled,
    ...(roomId === "" ? {} : { roomId }),
  };
}

/** Pure form → tool input mapper for organization export. */
export function mapExportFormToToolInput(form: ChatExportFormInput): MappedExportInput {
  const limit = parsePositiveInt(form.limit, "Export limit", 1, 10_000);
  if (typeof limit === "string") return limit;

  const roomIdsRaw = form.roomIds
    .split(/[\s,]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (roomIdsRaw.length > 100) {
    return "Export accepts at most 100 room IDs.";
  }
  for (const roomId of roomIdsRaw) {
    if (!uuidSchema.safeParse(roomId).success) {
      return `Room ID "${roomId}" is not a valid UUID.`;
    }
  }

  const from = form.from.trim();
  const to = form.to.trim();
  if (from !== "" && Number.isNaN(Date.parse(from))) {
    return "Export start must be a valid ISO-8601 datetime.";
  }
  if (to !== "" && Number.isNaN(Date.parse(to))) {
    return "Export end must be a valid ISO-8601 datetime.";
  }
  if (from !== "" && to !== "" && Date.parse(from) > Date.parse(to)) {
    return "Export start must not be after export end.";
  }

  return {
    roomIds: roomIdsRaw,
    limit,
    ...(from === "" ? {} : { from: new Date(from).toISOString() }),
    ...(to === "" ? {} : { to: new Date(to).toISOString() }),
  };
}

export function retentionFormFromPolicy(policy: ChatRetentionPolicyView): ChatRetentionFormInput {
  return {
    retentionDays: String(policy.retentionDays),
    editWindowSeconds: String(policy.editWindowSeconds),
    deleteWindowSeconds: String(policy.deleteWindowSeconds),
    roomId: policy.roomId ?? "",
  };
}

export function formatRetentionSummary(policy: ChatRetentionPolicyView): string {
  const hold = policy.legalHold ? "legal hold on" : "legal hold off";
  const source = policy.configured
    ? `configured${policy.updatedAt === null ? "" : ` · updated ${policy.updatedAt}`}`
    : "platform default (no org policy row yet)";
  return `${String(policy.retentionDays)} day retention · edit ${String(policy.editWindowSeconds)}s · delete ${String(policy.deleteWindowSeconds)}s · ${hold} · ${source}`;
}

export function describeChatAdminUnavailable(error: Error): string {
  const message = error.message.toLowerCase();
  if (
    message.includes("403") ||
    message.includes("401") ||
    message.includes("forbidden") ||
    message.includes("permission") ||
    message.includes("denied")
  ) {
    return "Chat retention controls are unavailable: your account is missing the admin.chat scope.";
  }
  if (message.includes("404") || message.includes("not found") || message.includes("not support")) {
    return "Chat retention controls are unavailable: Chat is not enabled or retention tools are not registered in this deployment.";
  }
  return `Chat retention controls are unavailable: ${error.message}`;
}

export const chatAdminQueryKeys = {
  retention: (roomId?: string) =>
    ["admin", "chat", "retention", roomId ?? "org-default"] as const,
};

export function chatRetentionQueryOptions(
  roomId?: string,
  fetchImpl: AuthFetch = authenticatedFetch,
) {
  return queryOptions({
    queryKey: chatAdminQueryKeys.retention(roomId),
    queryFn: () => getChatRetentionPolicy(roomId === undefined ? {} : { roomId }, fetchImpl),
    retry: false,
    throwOnError: false,
    staleTime: 15_000,
  });
}

export async function getChatRetentionPolicy(
  input: { readonly roomId?: string } = {},
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<ChatRetentionPolicyView> {
  const raw = await callTool<unknown>(
    "chat.retention.get",
    input.roomId === undefined ? {} : { roomId: input.roomId },
    { fetchImpl, autoApprove: false },
  );
  return parseToolOutput(raw, chatRetentionPolicyViewSchema, "read Chat retention policy");
}

export async function setChatRetentionPolicy(
  input: Exclude<MappedRetentionInput, string>,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<ChatRetentionPolicyResult> {
  const raw = await callTool<unknown>("chat.retention.set", input, { fetchImpl });
  return parseToolOutput(raw, chatRetentionPolicyResultSchema, "set Chat retention policy");
}

export async function setChatLegalHold(
  input: Exclude<MappedLegalHoldInput, string>,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<ChatRetentionPolicyResult> {
  const raw = await callTool<unknown>("chat.legal_hold.set", input, { fetchImpl });
  return parseToolOutput(raw, chatRetentionPolicyResultSchema, "set Chat legal hold");
}

export async function exportChatOrganization(
  input: Exclude<MappedExportInput, string>,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<ChatExportResult> {
  const raw = await callTool<unknown>("chat.export.organization", input, { fetchImpl });
  return parseToolOutput(raw, chatExportResultSchema, "export Chat organization messages");
}

function parseToolOutput<T>(raw: unknown, schema: z.ZodType<T>, action: string): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  throw new Error(`Failed to ${action}: malformed response.`);
}

function parsePositiveInt(
  value: string,
  label: string,
  min: number,
  max: number,
): number | string {
  const trimmed = value.trim();
  if (trimmed === "") {
    return `${label} is required.`;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return `${label} must be an integer from ${String(min)} to ${String(max)}.`;
  }
  return parsed;
}

function parseNonNegativeInt(value: string, label: string, max: number): number | string {
  const trimmed = value.trim();
  if (trimmed === "") {
    return `${label} is required.`;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    return `${label} must be an integer from 0 to ${String(max)}.`;
  }
  return parsed;
}
