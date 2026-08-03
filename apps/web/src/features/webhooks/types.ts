export type WebhookDirection = "outbound" | "inbound";

export type WebhookDeliveryStatus =
  "pending" | "in_progress" | "delivered" | "failed" | "abandoned";

export interface OutboundWebhook {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly url: string;
  readonly eventSubjects: readonly string[];
  readonly secretRef: string | null;
  readonly headers: Record<string, string>;
  readonly enabled: boolean;
  readonly metadata: Record<string, unknown>;
  readonly createdByActorId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InboundWebhook {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly slug: string;
  readonly source: string;
  readonly secretRef: string | null;
  readonly enabled: boolean;
  readonly metadata: Record<string, unknown>;
  readonly createdByActorId: string | null;
  readonly lastReceivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WebhookDelivery {
  readonly id: string;
  readonly orgId: string;
  readonly direction: WebhookDirection;
  readonly outboundWebhookId: string | null;
  readonly inboundWebhookId: string | null;
  readonly eventSubject: string;
  readonly status: WebhookDeliveryStatus;
  readonly attempt: number;
  readonly payload: unknown;
  readonly payloadSha256: string | null;
  readonly signature: string | null;
  readonly requestHeaders: Record<string, string>;
  readonly responseStatus: number | null;
  readonly responseHeaders: Record<string, string>;
  readonly error: string | null;
  readonly nextAttemptAt: string | null;
  readonly deliveredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeliveryListInput {
  readonly direction?: WebhookDirection;
  readonly status?: WebhookDeliveryStatus;
  readonly limit?: number;
}
