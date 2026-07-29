import { ApiError, BadRequestError, ForbiddenError, NotFoundError } from "../../api/api-error.js";

export class MailThreadNotFoundError extends NotFoundError {
  constructor(threadId: string) {
    super(`Unknown or inaccessible mail thread: ${threadId}`, {
      details: { mailCode: "mail.thread_not_found", threadId },
    });
    this.name = "MailThreadNotFoundError";
  }
}

export class MailFilterNotFoundError extends NotFoundError {
  constructor(filterId: string) {
    super(`Unknown mail filter: ${filterId}`, {
      details: { mailCode: "mail.filter_not_found", filterId },
    });
    this.name = "MailFilterNotFoundError";
  }
}

export class MailInboundActorForbiddenError extends ForbiddenError {
  constructor(actorType: string) {
    super(`mail.inbound.accept requires a service-account or system actor; got ${actorType}.`, {
      details: { mailCode: "mail.inbound_forbidden", actorType },
    });
    this.name = "MailInboundActorForbiddenError";
  }
}

export class MailOutboundPayloadError extends BadRequestError {
  constructor() {
    super("Invalid mail.send outbox payload.", {
      details: { mailCode: "mail.outbox_payload_invalid" },
    });
    this.name = "MailOutboundPayloadError";
  }
}

export class MailProviderError extends ApiError {
  constructor(message: string, cause: unknown) {
    super("internal_error", message, {
      details: { mailCode: "mail.provider_failed" },
      cause,
    });
    this.name = "MailProviderError";
  }
}

/** Stable, operator-visible non-retryable outbound routing failure. */
export class MailProviderConfigurationError extends Error {
  readonly retryable = false;

  constructor(
    readonly operatorCode:
      | "MAIL_PROVIDER_NOT_CONFIGURED"
      | "MAIL_PROVIDER_DISABLED"
      | "MAIL_PROVIDER_DECISION_CONFLICT"
      | "MAIL_RECIPIENT_SUPPRESSED",
    message: string,
  ) {
    super(`${operatorCode}: ${message}`);
    this.name = "MailProviderConfigurationError";
  }
}

export class MailDraftNotFoundError extends NotFoundError {
  constructor(draftId: string) {
    super(`Unknown or inaccessible mail draft: ${draftId}`, {
      details: { mailCode: "mail.draft_not_found", draftId },
    });
    this.name = "MailDraftNotFoundError";
  }
}

export class MailAliasNotFoundError extends NotFoundError {
  constructor(aliasId: string) {
    super(`Unknown or inaccessible mail alias: ${aliasId}`, {
      details: { mailCode: "mail.alias_not_found", aliasId },
    });
    this.name = "MailAliasNotFoundError";
  }
}

export class MailDraftVersionConflictError extends ApiError {
  constructor(
    readonly draftId: string,
    readonly currentVersion: number,
  ) {
    super("conflict", "The server draft is newer; reload or explicitly merge before saving.", {
      details: {
        mailCode: "mail.draft_version_conflict",
        draftId,
        currentVersion,
      },
    });
    this.name = "MailDraftVersionConflictError";
  }
}

export class MailSendIdempotencyRequiredError extends BadRequestError {
  constructor() {
    super("Agent and API mail sends require an idempotency key.", {
      details: { mailCode: "mail.send_idempotency_required" },
    });
    this.name = "MailSendIdempotencyRequiredError";
  }
}

export class MailAttachmentSizeError extends Error {
  readonly retryable = false;

  constructor(readonly maxBytes: number) {
    super(`Mail attachments exceed the ${String(maxBytes)} byte outbound limit.`);
    this.name = "MailAttachmentSizeError";
  }
}
