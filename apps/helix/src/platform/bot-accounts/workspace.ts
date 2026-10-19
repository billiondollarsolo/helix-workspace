import type { Actor } from "@helix/sdk-types";
import { chatMessageCursorSchema } from "@helix/contracts";
import type { MailStore } from "../mail/index.js";
import type { DriveStore } from "../drive/index.js";
import type { ChatStore } from "../chat/index.js";
import { BadRequestError, NotFoundError } from "../../api/api-error.js";
import {
  withRequesterPostgresActor,
  withTenantPostgresContext,
} from "../tenancy/postgres-roles.js";
import type { BotAccountStore } from "./store.js";
export class BotWorkspaceReader {
  constructor(
    private readonly access: BotAccountStore,
    private readonly domains: { mail?: MailStore; drive?: DriveStore; chat?: ChatStore },
  ) {}
  async openFile(viewer: Actor, botId: string, objectId: string) {
    await this.access.assertVisible(viewer, botId);
    const result = await withTenantPostgresContext(
      this.access.sql,
      { orgId: viewer.orgId, actorId: viewer.id },
      () =>
        withRequesterPostgresActor(
          botId,
          () =>
            this.domains.drive?.openFile?.({ orgId: viewer.orgId, actorId: botId, objectId }) ??
            Promise.resolve(null),
        ),
    );
    await this.access.assertVisible(viewer, botId);
    if (!result) throw new NotFoundError("File is unavailable or has not passed scanning.");
    return result;
  }
  async read(
    viewer: Actor,
    input: {
      botActorId: string;
      surface: "mail" | "files" | "chat" | "activity";
      threadId?: string | undefined;
      roomId?: string | undefined;
      query?: string | undefined;
      offset: number;
      cursor?: string | undefined;
    },
  ): Promise<unknown> {
    await this.access.assertVisible(viewer, input.botActorId);
    // The grant authorizes these enumerated reads only. Never expose a delegated tool invocation or write callback.
    const result = await withTenantPostgresContext(
      this.access.sql,
      { orgId: viewer.orgId, actorId: viewer.id },
      () =>
        withRequesterPostgresActor(input.botActorId, async () => {
          const scope = { orgId: viewer.orgId, actorId: input.botActorId };
          switch (input.surface) {
            case "mail": {
              if (!this.domains.mail) throw new NotFoundError("Mail is disabled.");
              if (input.threadId) {
                const thread = await this.domains.mail.getThread({
                  ...scope,
                  threadId: input.threadId,
                  resourcePage: { limit: 50, ...(input.cursor ? { after: input.cursor } : {}) },
                });
                if (!thread) throw new NotFoundError("Conversation is not visible to this bot.");
                return { thread };
              }
              return this.domains.mail.listThreads({
                ...scope,
                folder: "all",
                query: input.query,
                limit: 50,
                offset: input.offset,
              });
            }
            case "files": {
              if (!this.domains.drive) throw new NotFoundError("Drive is disabled.");
              return this.domains.drive.list({
                ...scope,
                acrossFolders: true,
                view: "owned",
                limit: 50,
                ...(input.cursor ? { cursor: input.cursor } : {}),
              });
            }
            case "chat": {
              if (!this.domains.chat) throw new NotFoundError("Chat is disabled.");
              if (input.roomId) {
                let before;
                if (input.cursor) {
                  try {
                    const cursor = chatMessageCursorSchema.parse(
                      JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
                    );
                    before = { ...cursor, sentAt: new Date(cursor.sentAt) };
                  } catch {
                    throw new BadRequestError("Chat history cursor is invalid.");
                  }
                }
                const page = await this.domains.chat.listMessages({
                  ...scope,
                  roomId: input.roomId,
                  ...(before ? { before } : {}),
                  limit: 51,
                });
                const messages = page.slice(0, 50);
                const last = messages.at(-1);
                return {
                  messages,
                  nextCursor:
                    page.length > 50 && last
                      ? Buffer.from(
                          JSON.stringify({ sentAt: last.sentAt.toISOString(), id: last.id }),
                        ).toString("base64url")
                      : null,
                };
              }
              const rooms = await this.domains.chat.listRooms({
                ...scope,
                query: input.query,
                offset: input.offset,
                limit: 51,
              });
              return {
                rooms: rooms.slice(0, 50),
                hasMore: rooms.length > 50,
              };
            }
            case "activity": {
              // Expose provenance, never arbitrary audit payloads which can contain other people's context.
              const activity = await this.access
                .sql`select id,verb,object_type,object_id,created_at from activity
              where org_id=${viewer.orgId} and actor_id=${input.botActorId}
              order by created_at desc,id desc limit 50 offset ${input.offset}`;
              return { activity };
            }
          }
        }),
    );
    await this.access.assertVisible(viewer, input.botActorId);
    return result;
  }
}
