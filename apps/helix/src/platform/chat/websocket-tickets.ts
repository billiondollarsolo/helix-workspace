import type { Actor } from "@helix/sdk-types";
import type postgres from "postgres";
import { randomBytes, sha256Hex } from "../crypto/index.js";

export const CHAT_WEBSOCKET_AUDIENCE = "chat.websocket";
export const CHAT_WEBSOCKET_PATH = "/ws/chat";
export const CHAT_WEBSOCKET_PROTOCOL = "helix.chat.v1";
export const CHAT_WEBSOCKET_TICKET_PROTOCOL_PREFIX = "helix.ticket.";
export const CHAT_WEBSOCKET_TICKET_TTL_SECONDS = 30;

const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface ChatWebSocketTicketStore {
  issue(input: {
    readonly actor: Actor;
    readonly roomId: string;
    readonly audience: string;
    readonly path: string;
    readonly now?: Date;
  }): Promise<{ readonly ticket: string; readonly expiresAt: Date }>;
  consume(input: {
    readonly ticket: string;
    readonly audience: string;
    readonly path: string;
    readonly now?: Date;
  }): Promise<{ readonly actor: Actor; readonly roomId: string } | null>;
}

interface ConsumedTicketRow {
  readonly room_id: string;
  readonly id: string;
  readonly org_id: string;
  readonly type: Actor["type"];
  readonly email: string | null;
  readonly display_name: string;
  readonly scopes: readonly string[] | null;
}

export class PostgresChatWebSocketTicketStore implements ChatWebSocketTicketStore {
  constructor(private readonly sql: postgres.Sql) {}

  async issue(input: {
    readonly actor: Actor;
    readonly roomId: string;
    readonly audience: string;
    readonly path: string;
    readonly now?: Date;
  }): Promise<{ readonly ticket: string; readonly expiresAt: Date }> {
    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + CHAT_WEBSOCKET_TICKET_TTL_SECONDS * 1000);
    const ticket = randomBytes(32).toString("base64url");
    await this.sql`
      with pruned as (
        delete from chat_websocket_tickets
        where expires_at <= ${now}
        returning token_hash
      )
      insert into chat_websocket_tickets (
        token_hash, org_id, actor_id, room_id, audience, path, issued_at, expires_at
      )
      values (
        ${sha256Hex(ticket)}, ${input.actor.orgId}, ${input.actor.id}, ${input.roomId},
        ${input.audience}, ${input.path}, ${now}, ${expiresAt}
      )
    `;
    return { ticket, expiresAt };
  }

  async consume(input: {
    readonly ticket: string;
    readonly audience: string;
    readonly path: string;
    readonly now?: Date;
  }): Promise<{ readonly actor: Actor; readonly roomId: string } | null> {
    const now = input.now ?? new Date();
    const rows = await this.sql<ConsumedTicketRow[]>`
      with consumed as (
        update chat_websocket_tickets
        set consumed_at = ${now}
        where token_hash = ${sha256Hex(input.ticket)}
          and audience = ${input.audience}
          and path = ${input.path}
          and consumed_at is null
          and expires_at > ${now}
        returning org_id, actor_id, room_id
      )
      select
        consumed.room_id,
        actor.id,
        actor.org_id,
        actor.type,
        actor.email,
        actor.display_name,
        actor.scopes
      from consumed
      join actors actor
        on actor.org_id = consumed.org_id
       and actor.id = consumed.actor_id
       and actor.disabled_at is null
    `;
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      roomId: row.room_id,
      actor: {
        id: row.id,
        orgId: row.org_id,
        type: row.type,
        displayName: row.display_name,
        ...(row.email === null ? {} : { email: row.email }),
        scopes: row.scopes ?? [],
      },
    };
  }
}

/** Extracts one opaque ticket while rejecting bearer credentials and ambiguity. */
export function chatWebSocketTicketFromProtocols(
  header: string | readonly string[] | undefined,
): string | null {
  const protocols = (typeof header === "string" ? header : (header?.join(",") ?? ""))
    .split(",")
    .map((value) => value.trim());
  if (!protocols.includes(CHAT_WEBSOCKET_PROTOCOL)) {
    return null;
  }
  const tickets = protocols
    .filter((value) => value.startsWith(CHAT_WEBSOCKET_TICKET_PROTOCOL_PREFIX))
    .map((value) => value.slice(CHAT_WEBSOCKET_TICKET_PROTOCOL_PREFIX.length));
  return tickets.length === 1 && TICKET_PATTERN.test(tickets[0] ?? "")
    ? (tickets[0] ?? null)
    : null;
}
