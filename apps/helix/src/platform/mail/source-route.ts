import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { NotFoundError } from "../../api/api-error.js";
import { requireActorScope } from "../../api/scopes.js";
import type { MailRawSourceStore } from "./store.js";

const sourceParamsSchema = z.object({ messageId: z.string().uuid() });
const sourceQuerySchema = z.object({ mailboxActorId: z.string().uuid().optional() });

export function registerMailSourceRoutes(
  app: FastifyInstance,
  options: {
    readonly store: MailRawSourceStore;
    readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  },
): void {
  app.get("/api/mail/messages/:messageId/source", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    requireActorScope(actor, "mail.read");
    const { messageId } = sourceParamsSchema.parse(request.params);
    const { mailboxActorId } = sourceQuerySchema.parse(request.query);
    const source = await options.store.readRawSource({
      orgId: actor.orgId,
      actorId: mailboxActorId ?? actor.id,
      messageId,
    });
    if (source === null) {
      throw new NotFoundError("Mail source not found.");
    }
    return reply
      .header("cache-control", "private, no-store")
      .header("content-disposition", `attachment; filename="${messageId}.eml"`)
      .header("content-length", String(source.byteSize))
      .header("etag", `"sha256-${Buffer.from(source.sha256, "hex").toString("base64url")}"`)
      .header("x-content-type-options", "nosniff")
      .type("message/rfc822")
      .send(source.bytes);
  });
}
