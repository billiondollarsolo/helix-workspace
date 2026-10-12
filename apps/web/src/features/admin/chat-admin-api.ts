import { formatDuration, formatRelativeTime } from "@/features/admin/console/format";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";
import { callTool } from "@/lib/tool-call";
import { ADMIN_QUERY_DEFAULTS } from "@/features/admin/console/request-budget";

/**
 * Admin Console — Chat retention, legal hold, and organization export.
 *
 * Calls the real Chat admin tools under `/api/tools/`:
 *  - `chat.retention.get` / `chat.retention.set`
 *  - `chat.legal_hold.set`
 *  - `chat.export.organization`
 *  - `chat.room.list_organization` (the room pickers)
 *
 * Every tool response is validated at the trust boundary with Zod so a
 * malformed payload never reaches the React tree. Write tools require
 * confirmation server-side; `callTool` auto-approves after the UI has already
 * collected explicit operator intent (Save / Enable hold / Run export).
 */

/** Platform defaults when no `chat_retention_policies` row exists for the org. */
export const CHAT_PLATFORM_DEFAULT_RETENTION_DAYS = 2555;

const uuidSchema = z.string().uuid();

const chatRetentionPolicyViewSchema = z.object({
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

const chatRetentionPolicyResultSchema = z.object({
  orgId: uuidSchema,
  roomId: uuidSchema.nullable(),
  retentionDays: z.number().int(),
  editWindowSeconds: z.number().int(),
  deleteWindowSeconds: z.number().int(),
  legalHold: z.boolean(),
  updatedAt: z.string(),
});

export type ChatRetentionPolicyResult = z.infer<typeof chatRetentionPolicyResultSchema>;

const chatExportMessageSchema = z.object({
  id: uuidSchema,
  roomId: uuidSchema,
  actorId: uuidSchema.nullable(),
  body: z.string().nullable(),
  bodyFormat: z.enum(["plain", "markdown"]),
  sentAt: z.string(),
  editedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});

const chatExportResultSchema = z.object({
  exportId: uuidSchema,
  orgId: uuidSchema,
  generatedAt: z.string(),
  truncated: z.boolean(),
  messages: z.array(chatExportMessageSchema),
});

export type ChatExportResult = z.infer<typeof chatExportResultSchema>;

const chatOrganizationRoomSchema = z.object({
  id: uuidSchema,
  kind: z.enum(["chat_room", "chat_dm"]),
  name: z.string(),
  privacy: z.enum(["discoverable", "restricted", "private"]),
  memberCount: z.number().int(),
  agentOnly: z.boolean(),
  updatedAt: z.string(),
});

export type ChatOrganizationRoom = z.infer<typeof chatOrganizationRoomSchema>;

const chatOrganizationRoomsSchema = z.object({
  rooms: z.array(chatOrganizationRoomSchema),
  privateRoomsVisible: z.boolean(),
  hiddenPrivateCount: z.number().int(),
});

export type ChatOrganizationRooms = z.infer<typeof chatOrganizationRoomsSchema>;

/** The most rooms one picker loads; the server returns the most recently active first. */
export const CHAT_ROOM_PICKER_LIMIT = 200;

/** The most rooms one export may name. */
export const CHAT_EXPORT_ROOM_LIMIT = 100;

export interface ChatRetentionFormInput {
  readonly retentionDays: string;
  readonly editWindowMinutes: string;
  readonly deleteWindowMinutes: string;
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
  /** Rooms to export; empty means every room. */
  readonly roomIds: readonly string[];
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
  const editWindowMinutes = parseNonNegativeInt(
    form.editWindowMinutes,
    "Edit window (minutes)",
    525_600,
  );
  if (typeof editWindowMinutes === "string") return editWindowMinutes;
  const deleteWindowMinutes = parseNonNegativeInt(
    form.deleteWindowMinutes,
    "Delete window (minutes)",
    525_600,
  );
  if (typeof deleteWindowMinutes === "string") return deleteWindowMinutes;
  const editWindowSeconds = editWindowMinutes * 60;
  const deleteWindowSeconds = deleteWindowMinutes * 60;

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

  if (form.roomIds.length > CHAT_EXPORT_ROOM_LIMIT) {
    return `Choose at most ${String(CHAT_EXPORT_ROOM_LIMIT)} rooms, or none to export every room.`;
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
    roomIds: form.roomIds,
    limit,
    ...(from === "" ? {} : { from: new Date(from).toISOString() }),
    ...(to === "" ? {} : { to: new Date(to).toISOString() }),
  };
}

export function retentionFormFromPolicy(policy: ChatRetentionPolicyView): ChatRetentionFormInput {
  return {
    retentionDays: String(policy.retentionDays),
    editWindowMinutes: String(Math.round(policy.editWindowSeconds / 60)),
    deleteWindowMinutes: String(Math.round(policy.deleteWindowSeconds / 60)),
    roomId: policy.roomId ?? "",
  };
}

export function formatRetentionSummary(policy: ChatRetentionPolicyView): string {
  const hold = policy.legalHold ? "Legal hold on" : "Legal hold off";
  const source = policy.configured
    ? policy.updatedAt === null
      ? "Set for your organization"
      : `Updated ${formatRelativeTime(policy.updatedAt)}`
    : "Default settings";
  return `Messages kept for ${formatDuration(policy.retentionDays * 86_400)} · editable for ${formatDuration(policy.editWindowSeconds)} · deletable for ${formatDuration(policy.deleteWindowSeconds)} · ${hold} · ${source}`;
}

/** How a room reads in a picker: its name, then what kind of room it is. */
export function describeChatRoom(room: ChatOrganizationRoom): string {
  const name =
    room.name.trim() === ""
      ? room.kind === "chat_dm"
        ? "Direct message"
        : "Untitled room"
      : room.name;
  const kind =
    room.kind === "chat_dm"
      ? "direct message"
      : room.privacy === "private"
        ? "private"
        : room.privacy === "restricted"
          ? "invitation only"
          : null;
  const tags = [...(kind === null ? [] : [kind]), ...(room.agentOnly ? ["agents only"] : [])];
  return tags.length === 0 ? name : `${name} (${tags.join(", ")})`;
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
  retention: (roomId?: string) => ["admin", "chat", "retention", roomId ?? "org-default"] as const,
  /** `privateRoomsVisible` is in the key so flipping the setting reloads the list. */
  rooms: (includeAgentOnly: boolean, privateRoomsVisible: boolean) =>
    ["admin", "chat", "rooms", { includeAgentOnly, privateRoomsVisible }] as const,
};

export function chatOrganizationRoomsQueryOptions(
  input: { readonly includeAgentOnly: boolean; readonly privateRoomsVisible: boolean },
  fetchImpl: AuthFetch = authenticatedFetch,
) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: chatAdminQueryKeys.rooms(input.includeAgentOnly, input.privateRoomsVisible),
    queryFn: () => listChatOrganizationRooms(input.includeAgentOnly, fetchImpl),
    staleTime: 15_000,
  });
}

export async function listChatOrganizationRooms(
  includeAgentOnly: boolean,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<ChatOrganizationRooms> {
  const raw = await callTool<unknown>(
    "chat.room.list_organization",
    { includeAgentOnly, limit: CHAT_ROOM_PICKER_LIMIT },
    { fetchImpl, autoApprove: false },
  );
  return parseToolOutput(raw, chatOrganizationRoomsSchema, "list Chat rooms");
}

export function chatRetentionQueryOptions(
  roomId?: string,
  fetchImpl: AuthFetch = authenticatedFetch,
) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: chatAdminQueryKeys.retention(roomId),
    queryFn: () => getChatRetentionPolicy(roomId === undefined ? {} : { roomId }, fetchImpl),
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

function parsePositiveInt(value: string, label: string, min: number, max: number): number | string {
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
