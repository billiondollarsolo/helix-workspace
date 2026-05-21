import type { ToolDefinition } from "@helix/sdk-types";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import {
  deliverOutboundWebhook,
  replayOutboundWebhook,
  type WebhookHttpClient,
  type WebhookReplayStore,
} from "./delivery.js";
import type {
  InboundWebhookRecord,
  OutboundWebhookRecord,
  PostgresWebhookStore,
  WebhookDeliveryRecord,
  WebhookSecretResolver,
} from "./store.js";
import { jsonRecordSchema, stringRecordSchema, zodToolSchema } from "./tool-schemas.js";
import { webhookDeliveryStatuses, webhookDirections } from "./types.js";
import { z } from "zod";

const uuidSchema = z.string().uuid();
const slugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9-]*$/u);

const outboundCreateSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  eventSubjects: z.array(z.string().min(1)).default([]),
  secretRef: z.string().min(1).optional(),
  headers: stringRecordSchema.default({}),
  enabled: z.boolean().default(true),
  metadata: jsonRecordSchema.default({}),
});

const outboundUpdateSchema = outboundCreateSchema.partial().extend({
  id: uuidSchema,
});

const inboundCreateSchema = z.object({
  name: z.string().min(1),
  slug: slugSchema,
  source: z.string().min(1).default("generic"),
  secretRef: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  metadata: jsonRecordSchema.default({}),
});

const inboundUpdateSchema = inboundCreateSchema.partial().extend({
  id: uuidSchema,
});

const idSchema = z.object({ id: uuidSchema });
const outboundTestSchema = z.object({
  id: uuidSchema,
  subject: z.string().min(1).default("webhook.test"),
  payload: z.unknown().default({ ok: true }),
});

const outboundReplaySchema = z
  .union([z.object({ deliveryId: uuidSchema }), z.object({ id: uuidSchema })])
  .transform((input) => ("deliveryId" in input ? input : { deliveryId: input.id }));

const deliveryListSchema = z.object({
  direction: z.enum(webhookDirections).optional(),
  status: z.enum(webhookDeliveryStatuses).optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

const emptyObjectSchema = z.object({});

const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export interface WebhookToolStore extends WebhookReplayStore {
  createOutbound: PostgresWebhookStore["createOutbound"];
  updateOutbound: PostgresWebhookStore["updateOutbound"];
  deleteOutbound: PostgresWebhookStore["deleteOutbound"];
  listOutbound: PostgresWebhookStore["listOutbound"];
  createInbound: PostgresWebhookStore["createInbound"];
  updateInbound: PostgresWebhookStore["updateInbound"];
  deleteInbound: PostgresWebhookStore["deleteInbound"];
  rotateInboundSecret: PostgresWebhookStore["rotateInboundSecret"];
  listInbound: PostgresWebhookStore["listInbound"];
  listDeliveries: PostgresWebhookStore["listDeliveries"];
}

export interface RegisterWebhookToolsOptions {
  readonly store: WebhookToolStore;
  readonly secretResolver?: WebhookSecretResolver;
  readonly httpClient?: WebhookHttpClient;
}

export function registerWebhookTools(
  registry: RuntimeToolRegistry,
  options: RegisterWebhookToolsOptions,
): void {
  registerTool(registry, {
    id: "webhook.outbound.create",
    description: "Create an outbound webhook endpoint.",
    permission: "admin.webhooks",
    sideEffects: "write",
    inputSchema: zodToolSchema(outboundCreateSchema, genericObjectJsonSchema),
    outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
    handler: async (input, ctx) =>
      serializeOutbound(
        await options.store.createOutbound({
          orgId: ctx.actor.orgId,
          ...input,
          createdByActorId: uuidOrNull(ctx.actor.id),
        }),
      ),
  });

  registerTool(registry, {
    id: "webhook.outbound.update",
    description: "Update an outbound webhook endpoint.",
    permission: "admin.webhooks",
    sideEffects: "write",
    inputSchema: zodToolSchema(outboundUpdateSchema, genericObjectJsonSchema),
    outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
    handler: async ({ id, ...patch }, ctx) => {
      const webhook = await options.store.updateOutbound({ orgId: ctx.actor.orgId, id, patch });
      if (webhook === null) {
        throw new Error(`Unknown outbound webhook: ${id}`);
      }
      return serializeOutbound(webhook);
    },
  });

  registerTool(registry, {
    id: "webhook.outbound.delete",
    description: "Delete an outbound webhook endpoint.",
    permission: "admin.webhooks",
    sideEffects: "destructive",
    inputSchema: zodToolSchema(idSchema, genericObjectJsonSchema),
    outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
    handler: async (input, ctx) => ({
      deleted: await options.store.deleteOutbound(ctx.actor.orgId, input.id),
    }),
  });

  registerTool(registry, {
    id: "webhook.outbound.list",
    description: "List outbound webhook endpoints.",
    permission: "admin.webhooks",
    sideEffects: "read",
    inputSchema: zodToolSchema(emptyObjectSchema, genericObjectJsonSchema),
    outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
    handler: async (_input, ctx) => ({
      webhooks: (await options.store.listOutbound(ctx.actor.orgId)).map(serializeOutbound),
    }),
  });

  registerTool(registry, {
    id: "webhook.outbound.test",
    description: "Fire a synthetic event through an outbound webhook.",
    permission: "admin.webhooks",
    sideEffects: "external_communication",
    inputSchema: zodToolSchema(outboundTestSchema, genericObjectJsonSchema),
    outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
    handler: async (input, ctx) => {
      const webhook = await options.store.getOutbound(ctx.actor.orgId, input.id);
      if (webhook === null) {
        throw new Error(`Unknown outbound webhook: ${input.id}`);
      }
      const delivery = await deliverOutboundWebhook({
        store: options.store,
        webhook,
        event: { subject: input.subject, payload: input.payload },
        ...(options.secretResolver === undefined ? {} : { secretResolver: options.secretResolver }),
        ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
      });
      return { delivery: delivery === null ? null : serializeDelivery(delivery) };
    },
  });

  registerTool(registry, {
    id: "webhook.outbound.replay",
    description: "Replay a failed outbound webhook delivery.",
    permission: "admin.webhooks",
    sideEffects: "external_communication",
    inputSchema: zodToolSchema(outboundReplaySchema, genericObjectJsonSchema),
    outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
    handler: async (input, ctx) => {
      const delivery = await replayOutboundWebhook({
        store: options.store,
        orgId: ctx.actor.orgId,
        deliveryId: input.deliveryId,
        ...(options.secretResolver === undefined ? {} : { secretResolver: options.secretResolver }),
        ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
      });
      return { delivery: delivery === null ? null : serializeDelivery(delivery) };
    },
  });

  registerTool(registry, {
    id: "webhook.inbound.create",
    description: "Create an inbound webhook receiver.",
    permission: "admin.webhooks",
    sideEffects: "write",
    inputSchema: zodToolSchema(inboundCreateSchema, genericObjectJsonSchema),
    outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
    handler: async (input, ctx) =>
      serializeInbound(
        await options.store.createInbound({
          orgId: ctx.actor.orgId,
          ...input,
          createdByActorId: uuidOrNull(ctx.actor.id),
        }),
      ),
  });

  registerTool(registry, {
    id: "webhook.inbound.update",
    description: "Update an inbound webhook receiver.",
    permission: "admin.webhooks",
    sideEffects: "write",
    inputSchema: zodToolSchema(inboundUpdateSchema, genericObjectJsonSchema),
    outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
    handler: async ({ id, ...patch }, ctx) => {
      const webhook = await options.store.updateInbound({ orgId: ctx.actor.orgId, id, patch });
      if (webhook === null) {
        throw new Error(`Unknown inbound webhook: ${id}`);
      }
      return serializeInbound(webhook);
    },
  });

  registerTool(registry, {
    id: "webhook.inbound.delete",
    description: "Delete an inbound webhook receiver.",
    permission: "admin.webhooks",
    sideEffects: "destructive",
    inputSchema: zodToolSchema(idSchema, genericObjectJsonSchema),
    outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
    handler: async (input, ctx) => ({
      deleted: await options.store.deleteInbound(ctx.actor.orgId, input.id),
    }),
  });

  registerTool(registry, {
    id: "webhook.inbound.rotate-secret",
    description: "Rotate an inbound webhook secret.",
    permission: "admin.webhooks",
    sideEffects: "write",
    inputSchema: zodToolSchema(idSchema, genericObjectJsonSchema),
    outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
    handler: async (input, ctx) => {
      const result = await options.store.rotateInboundSecret(ctx.actor.orgId, input.id);
      if (result === null) {
        throw new Error(`Unknown inbound webhook: ${input.id}`);
      }
      return { webhook: serializeInbound(result.webhook), secretRef: result.secretRef };
    },
  });

  registerTool(registry, {
    id: "webhook.inbound.list",
    description: "List inbound webhook receivers.",
    permission: "admin.webhooks",
    sideEffects: "read",
    inputSchema: zodToolSchema(emptyObjectSchema, genericObjectJsonSchema),
    outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
    handler: async (_input, ctx) => ({
      webhooks: (await options.store.listInbound(ctx.actor.orgId)).map(serializeInbound),
    }),
  });

  registerTool(registry, {
    id: "webhook.delivery.get",
    description: "Get a webhook delivery record.",
    permission: "admin.webhooks",
    sideEffects: "read",
    inputSchema: zodToolSchema(idSchema, genericObjectJsonSchema),
    outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
    handler: async (input, ctx) => {
      const delivery = await options.store.getDelivery(ctx.actor.orgId, input.id);
      if (delivery === null) {
        throw new Error(`Unknown webhook delivery: ${input.id}`);
      }
      return serializeDelivery(delivery);
    },
  });

  registerTool(registry, {
    id: "webhook.delivery.list",
    description: "List webhook delivery records.",
    permission: "admin.webhooks",
    sideEffects: "read",
    inputSchema: zodToolSchema(deliveryListSchema, genericObjectJsonSchema),
    outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
    handler: async (input, ctx) => ({
      deliveries: (await options.store.listDeliveries({ orgId: ctx.actor.orgId, ...input })).map(
        serializeDelivery,
      ),
    }),
  });
}

function registerTool<Input, Output>(
  registry: RuntimeToolRegistry,
  tool: ToolDefinition<Input, Output>,
): void {
  registry.register(tool);
}

function uuidOrNull(value: string): string | null {
  return uuidSchema.safeParse(value).success ? value : null;
}

function serializeOutbound(webhook: OutboundWebhookRecord) {
  return {
    ...webhook,
    createdAt: webhook.createdAt.toISOString(),
    updatedAt: webhook.updatedAt.toISOString(),
  };
}

function serializeInbound(webhook: InboundWebhookRecord) {
  return {
    ...webhook,
    lastReceivedAt: webhook.lastReceivedAt?.toISOString() ?? null,
    createdAt: webhook.createdAt.toISOString(),
    updatedAt: webhook.updatedAt.toISOString(),
  };
}

function serializeDelivery(delivery: WebhookDeliveryRecord) {
  return {
    ...delivery,
    nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
    deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
    createdAt: delivery.createdAt.toISOString(),
    updatedAt: delivery.updatedAt.toISOString(),
  };
}
