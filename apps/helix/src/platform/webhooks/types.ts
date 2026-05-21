export const webhookDeliveryStatuses = [
  "pending",
  "in_progress",
  "delivered",
  "failed",
  "abandoned",
] as const;

export type WebhookDeliveryStatus = (typeof webhookDeliveryStatuses)[number];

export const webhookDirections = ["outbound", "inbound"] as const;

export type WebhookDirection = (typeof webhookDirections)[number];
