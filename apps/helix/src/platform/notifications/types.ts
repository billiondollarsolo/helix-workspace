import type { JsonObject } from "@helix/sdk-types";

export interface NotificationRecord {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly verb: string;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly summary: string;
  readonly body: string | null;
  readonly payload: JsonObject;
  readonly createdAt: Date;
  readonly readAt: Date | null;
}

export interface NotificationInsert {
  readonly orgId: string;
  readonly actorId: string;
  readonly verb: string;
  readonly objectType: string;
  readonly objectId?: string | null;
  readonly summary: string;
  readonly body?: string | null;
  readonly payload?: JsonObject;
}

export interface ListNotificationsInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly unreadOnly?: boolean;
  readonly limit?: number;
}
