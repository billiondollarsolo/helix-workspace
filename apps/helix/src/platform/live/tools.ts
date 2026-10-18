import {
  liveEventQuerySchema,
  liveEventPageSchema,
  presenceHeartbeatSchema,
  presenceStatusInputSchema,
  presenceRecordSchema,
} from "@helix/contracts";
import { z } from "zod";
import { requireActorScope } from "../../api/scopes.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { LiveStore } from "./store.js";
const shape = { type: "object", additionalProperties: true } as const;
const schema = <T extends z.ZodTypeAny>(value: T) => zodToolSchema(value, shape);
export function registerLiveTools(tools: RuntimeToolRegistry, store: LiveStore) {
  tools.register(
    defineTool({
      id: "events.resolve",
      description:
        "Resolve one currently authorized inbox event to its authoritative sender and reply target. Content must be read separately through the permission-checked resource URI.",
      permission: "notifications.read",
      sideEffects: "read",
      inputSchema: schema(z.object({ id: z.string().min(1).max(160) }).strict()),
      outputSchema: schema(
        z.object({
          event: liveEventPageSchema.shape.events.element,
          source: z
            .object({
              messageId: z.string().uuid(),
              threadId: z.string().uuid(),
              parentMessageId: z.string().uuid().nullable(),
              senderActorId: z.string().uuid().nullable(),
              senderType: z.string(),
              replyTo: z.string().nullable(),
              uri: z.string(),
              audienceHash: z.string().regex(/^[a-f0-9]{64}$/u),
              attachments: z
                .array(
                  z.object({
                    objectId: z.string().uuid(),
                    source: z.enum(["drive", "mail", "chat"]),
                    name: z.string().max(255),
                    mimeType: z.string(),
                    byteSize: z.number().int().nonnegative(),
                    sha256: z
                      .string()
                      .regex(/^[a-f0-9]{64}$/u)
                      .nullable(),
                  }),
                )
                .max(32),
            })
            .nullable(),
        }),
      ),
      handler: (input, ctx) => store.resolve(ctx.actor, input.id),
    }),
  );
  tools.register(
    defineTool({
      id: "events.list",
      description:
        "Read private event references after a durable cursor. Does not mark messages read or approve actions. A reset requires resynchronization.",
      permission: "notifications.read",
      sideEffects: "read",
      inputSchema: schema(liveEventQuerySchema),
      outputSchema: schema(liveEventPageSchema),
      handler: (input, ctx) => store.list(ctx.actor, input.after, input.limit),
    }),
  );
  tools.register(
    defineTool({
      id: "presence.get",
      description:
        "Read your availability or permitted chat peers. Connected is not a read receipt.",
      permission: "notifications.read",
      sideEffects: "read",
      inputSchema: schema(
        z.object({ actorIds: z.array(z.string().uuid()).min(1).max(100).optional() }),
      ),
      outputSchema: schema(z.object({ items: z.array(presenceRecordSchema) })),
      handler: async (input, ctx) => {
        const ids = input.actorIds ?? [ctx.actor.id];
        if (ids.some((id) => id !== ctx.actor.id)) requireActorScope(ctx.actor, "chat.read");
        return { items: await store.status(ctx.actor, ids) };
      },
    }),
  );
  tools.register(
    defineTool({
      id: "presence.set",
      description:
        "Set only your own availability, status text, emoji and expiry (up to 30 days). Invisible hides your connection from others.",
      permission: "notifications.write",
      sideEffects: "write",
      inputSchema: schema(presenceStatusInputSchema),
      outputSchema: schema(z.object({ presence: presenceRecordSchema.optional() })),
      handler: async (input, ctx) => ({ presence: await store.setStatus(ctx.actor, input) }),
    }),
  );
  tools.register(
    defineTool({
      id: "presence.heartbeat",
      description:
        "Renew your own connection lease for 60 seconds. Reuse a UUID per runner; report working or waiting_approval explicitly. Disconnect removes only that lease.",
      permission: "notifications.write",
      sideEffects: "write",
      inputSchema: schema(presenceHeartbeatSchema),
      outputSchema: schema(z.object({ ok: z.literal(true) })),
      handler: async (input, ctx) => {
        await store.heartbeat(ctx.actor, input.connectionId, input.state, input.disconnect);
        return { ok: true as const };
      },
    }),
  );
}
