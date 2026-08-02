/**
 * Pure send-status state machine for Mail compose (Task M10).
 *
 * Maps real `mail.send` / `mail.outbound.get` / `mail.outbound.cancel` fields
 * into user-visible phases. Prefer backend `deliveryStatus` when present;
 * otherwise mirror server `mailOutboundDisplayStatus` using raw `status` +
 * `deliveryMetadata.latestEvent`.
 */

/** Backend delivery states documented in mail-security-and-reliability.md. */
export const MAIL_DELIVERY_STATUSES = [
  "queued",
  "sending",
  "sent",
  "delayed",
  "failed",
  "cancelled",
] as const;

export type MailDeliveryStatus = (typeof MAIL_DELIVERY_STATUSES)[number];

/** Full UI phase set, including client-only submit/idle. */
export type MailSendUiPhase = "idle" | "submitting" | MailDeliveryStatus;

/**
 * @deprecated Prefer MailSendUiPhase. Kept as alias for callers that treat
 * undo as a distinct enum value via undoAvailable instead.
 */
export type MailSendUiStatusName = MailDeliveryStatus | "undo_window";

export interface MailSendStatusSource {
  /** Client request lifecycle before/without a durable outbound record. */
  readonly clientPhase?: "idle" | "submitting" | "error";
  readonly status?: string | null;
  readonly deliveryStatus?: string | null;
  readonly undoUntil?: string | null;
  readonly id?: string | null;
  readonly outboundId?: string | null;
  readonly lastError?: string | null;
  readonly deliveryMetadata?: {
    readonly latestEvent?: string | null;
  } | null;
}

export interface MailSendUiStatus {
  readonly phase: MailSendUiPhase;
  /** True only while status is queued and undoUntil is still in the future. */
  readonly undoAvailable: boolean;
  readonly outboundId: string | null;
  readonly lastError: string | null;
  readonly label: string;
}

/** Input shape for the slim resolver (status string → enum). */
export interface MailSendStatusInput {
  readonly status?: string | null;
  readonly deliveryStatus?: string | null;
  readonly undoUntil?: string | null;
  readonly deliveryMetadata?: {
    readonly latestEvent?: string | null;
  } | null;
  readonly nowMs?: number;
}

const TERMINAL_PHASES: ReadonlySet<MailSendUiPhase> = new Set(["sent", "failed", "cancelled"]);

const ACTIVE_POLL_PHASES: ReadonlySet<MailSendUiPhase> = new Set(["queued", "sending", "delayed"]);

export function isMailDeliveryStatus(
  value: string | null | undefined,
): value is MailDeliveryStatus {
  return typeof value === "string" && (MAIL_DELIVERY_STATUSES as readonly string[]).includes(value);
}

/**
 * Prefer shipped `deliveryStatus` (user-visible, may be `delayed`), else derive
 * from raw `status` + deliveryMetadata (same rules as server reliability helper).
 */
export function resolveMailDeliveryStatus(
  source: Pick<MailSendStatusSource, "status" | "deliveryStatus" | "deliveryMetadata">,
): MailDeliveryStatus | null {
  if (isMailDeliveryStatus(source.deliveryStatus)) {
    return source.deliveryStatus;
  }

  const status = source.status ?? null;
  if (status === null || status.length === 0) {
    return null;
  }

  if (
    status === "sent" &&
    (source.deliveryMetadata?.latestEvent === "delayed" ||
      source.deliveryMetadata?.latestEvent === "soft_bounce")
  ) {
    return "delayed";
  }

  if (isMailDeliveryStatus(status)) {
    return status;
  }

  return null;
}

/**
 * Slim mapper: backend/outbound fields → delivery status or `undo_window`.
 * Returns null for empty/unknown status (negative path).
 */
export function resolveMailSendUiStatus(input: MailSendStatusInput): MailSendUiStatusName | null {
  const now = input.nowMs ?? Date.now();
  const delivery = resolveMailDeliveryStatus(input);
  if (delivery === null) {
    return null;
  }

  if (typeof input.undoUntil === "string" && input.undoUntil.length > 0) {
    const until = Date.parse(input.undoUntil);
    if (
      Number.isFinite(until) &&
      until > now &&
      (delivery === "queued" || delivery === "sending")
    ) {
      return "undo_window";
    }
  }

  return delivery;
}

export function parseMailUndoUntilMs(undoUntil: string | null | undefined): number | null {
  if (typeof undoUntil !== "string" || undoUntil.length === 0) {
    return null;
  }
  const ms = Date.parse(undoUntil);
  return Number.isFinite(ms) ? ms : null;
}

export function resolveMailOutboundId(
  source: Pick<MailSendStatusSource, "id" | "outboundId">,
): string | null {
  if (typeof source.outboundId === "string" && source.outboundId.length > 0) {
    return source.outboundId;
  }
  if (typeof source.id === "string" && source.id.length > 0) {
    return source.id;
  }
  return null;
}

export function isMailSendTerminalPhase(phase: MailSendUiPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/** Whether compose should poll `mail.outbound.get` for progression. */
export function shouldPollMailSendStatus(phase: MailSendUiPhase): boolean {
  return ACTIVE_POLL_PHASES.has(phase);
}

export function mailSendUiStatusLabel(status: MailSendUiStatusName): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "sending":
      return "Sending";
    case "sent":
      return "Sent";
    case "delayed":
      return "Delayed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "undo_window":
      return "Undo send available";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function mailSendStatusLabel(
  phase: MailSendUiPhase,
  options: {
    readonly undoAvailable?: boolean;
    readonly lastError?: string | null;
  } = {},
): string {
  switch (phase) {
    case "idle":
      return "";
    case "submitting":
      return "Sending…";
    case "queued":
      return options.undoAvailable === true
        ? "Message queued — you can undo send for a few seconds."
        : "Message queued for delivery…";
    case "sending":
      return "Sending to mail provider…";
    case "sent":
      return "Message sent.";
    case "delayed":
      return "Delivery delayed — provider has not confirmed final delivery yet.";
    case "failed": {
      const detail =
        typeof options.lastError === "string" && options.lastError.trim().length > 0
          ? options.lastError.trim()
          : null;
      return detail === null
        ? "Could not send message. Try again."
        : `Could not send message: ${detail}`;
    }
    case "cancelled":
      return "Send cancelled.";
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}

export function mailSendUiStatusIsRetryable(
  status: MailSendUiStatusName | MailSendUiPhase,
): boolean {
  return status === "failed" || status === "delayed";
}

/**
 * Map mail send / outbound API fields into the compose status machine.
 * Callers must pass real API payloads — tests should exercise this mapper
 * rather than hardcoding UI phases in isolation.
 */
export function mapMailSendUiStatus(
  source: MailSendStatusSource,
  nowMs: number = Date.now(),
): MailSendUiStatus {
  const outboundId = resolveMailOutboundId(source);
  const lastError =
    typeof source.lastError === "string" && source.lastError.length > 0 ? source.lastError : null;
  const delivery = resolveMailDeliveryStatus(source);
  const undoUntilMs = parseMailUndoUntilMs(source.undoUntil);
  const undoAvailable =
    (delivery === "queued" || delivery === "sending") &&
    outboundId !== null &&
    undoUntilMs !== null &&
    undoUntilMs > nowMs;

  if (delivery !== null) {
    const phase: MailSendUiPhase = delivery;
    return {
      phase,
      undoAvailable,
      outboundId,
      lastError,
      label: mailSendStatusLabel(phase, { undoAvailable, lastError }),
    };
  }

  if (source.clientPhase === "submitting") {
    return {
      phase: "submitting",
      undoAvailable: false,
      outboundId,
      lastError: null,
      label: mailSendStatusLabel("submitting"),
    };
  }

  if (source.clientPhase === "error") {
    return {
      phase: "failed",
      undoAvailable: false,
      outboundId,
      lastError,
      label: mailSendStatusLabel("failed", { lastError }),
    };
  }

  return {
    phase: "idle",
    undoAvailable: false,
    outboundId,
    lastError: null,
    label: "",
  };
}
