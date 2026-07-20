import {
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  type ApiErrorOptions,
} from "../../api/api-error.js";

/** Thrown when the actor cannot access a chat room (G4/G6). */
export class ChatRoomAccessError extends ForbiddenError {
  readonly roomId: string;

  constructor(roomId: string, o?: ApiErrorOptions) {
    super(`Unknown or inaccessible chat room: ${roomId}`, {
      ...o,
      details: {
        roomId,
        ...(typeof o?.details === "object" && o.details !== null
          ? (o.details as Record<string, unknown>)
          : {}),
      },
    });
    this.name = "ChatRoomAccessError";
    this.roomId = roomId;
  }
}

/** Thrown when a message id is unknown or not editable/deletable by the actor. */
export class ChatMessageNotFoundError extends NotFoundError {
  readonly messageId: string;

  constructor(messageId: string, o?: ApiErrorOptions) {
    super(`Unknown chat message: ${messageId}`, {
      ...o,
      details: {
        messageId,
        ...(typeof o?.details === "object" && o.details !== null
          ? (o.details as Record<string, unknown>)
          : {}),
      },
    });
    this.name = "ChatMessageNotFoundError";
    this.messageId = messageId;
  }
}

/** Per-connection WebSocket frame rate limit exceeded. */
export class ChatRateLimitedError extends RateLimitedError {
  constructor(message = "Chat rate limit exceeded; slow down inbound frames.", o?: ApiErrorOptions) {
    super(message, o);
    this.name = "ChatRateLimitedError";
  }
}
