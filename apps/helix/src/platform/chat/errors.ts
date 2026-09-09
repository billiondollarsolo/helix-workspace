import { NotFoundError, RateLimitedError, type ApiErrorOptions } from "../../api/api-error.js";

/** Non-enumerable denial for an unknown room, tenant, actor, or membership. */
export class ChatRoomAccessError extends NotFoundError {
  readonly roomId: string | undefined;

  constructor(roomId?: string, o?: ApiErrorOptions) {
    super("Chat room was not found.", o);
    this.name = "ChatRoomAccessError";
    this.roomId = roomId;
  }
}

/** Thrown when a message id is unknown or not editable/deletable by the actor. */
export class ChatMessageNotFoundError extends NotFoundError {
  readonly messageId: string | undefined;

  constructor(messageId?: string, o?: ApiErrorOptions) {
    super("Chat message was not found.", o);
    this.name = "ChatMessageNotFoundError";
    this.messageId = messageId;
  }
}

/** Non-enumerable denial for cross-tenant or unauthorized member changes. */
export class ChatMemberAccessError extends NotFoundError {
  constructor(o?: ApiErrorOptions) {
    super("Chat member was not found.", o);
    this.name = "ChatMemberAccessError";
  }
}

/** Non-enumerable denial for inaccessible, inactive, or unknown attachments. */
export class ChatAttachmentAccessError extends NotFoundError {
  constructor(o?: ApiErrorOptions) {
    super("Chat attachment was not found.", o);
    this.name = "ChatAttachmentAccessError";
  }
}

/** Per-connection WebSocket frame rate limit exceeded. */
export class ChatRateLimitedError extends RateLimitedError {
  constructor(
    message = "Chat rate limit exceeded; slow down inbound frames.",
    o?: ApiErrorOptions,
  ) {
    super(message, o);
    this.name = "ChatRateLimitedError";
  }
}
