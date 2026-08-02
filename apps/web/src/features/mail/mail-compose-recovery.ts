export const MAIL_COMPOSE_RECOVERY_KEY = "helix-mail-compose-recovery-v1";

const RECOVERY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export interface MailComposeRecovery {
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
  readonly subject: string;
  readonly body: string;
  readonly updatedAt: string;
}

export function hasMailComposeContent(
  draft: Pick<MailComposeRecovery, "to" | "cc" | "bcc" | "subject" | "body">,
): boolean {
  return [draft.to, draft.cc, draft.bcc, draft.subject, draft.body].some(
    (value) => value.trim().length > 0,
  );
}

export function recipientTokens(raw: string): readonly string[] {
  return raw
    .split(/[,;]/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function invalidRecipientTokens(raw: string): readonly string[] {
  return recipientTokens(raw).filter((address) => !EMAIL_ADDRESS_PATTERN.test(address));
}

export function readMailComposeRecovery(
  storage: Pick<Storage, "getItem" | "removeItem"> | null = browserStorage(),
  now = Date.now(),
): MailComposeRecovery | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(MAIL_COMPOSE_RECOVERY_KEY);
    if (raw === null) return null;
    const candidate: unknown = JSON.parse(raw);
    if (!isRecoveryRecord(candidate)) {
      storage.removeItem(MAIL_COMPOSE_RECOVERY_KEY);
      return null;
    }
    const updatedAtMs = Date.parse(candidate.updatedAt);
    if (!Number.isFinite(updatedAtMs) || now - updatedAtMs > RECOVERY_MAX_AGE_MS) {
      storage.removeItem(MAIL_COMPOSE_RECOVERY_KEY);
      return null;
    }
    return {
      to: candidate.to.slice(0, 4_000),
      cc: candidate.cc.slice(0, 4_000),
      bcc: candidate.bcc.slice(0, 4_000),
      subject: candidate.subject.slice(0, 998),
      body: candidate.body.slice(0, 250_000),
      updatedAt: candidate.updatedAt,
    };
  } catch {
    return null;
  }
}

export function writeMailComposeRecovery(
  draft: Omit<MailComposeRecovery, "updatedAt">,
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(
      MAIL_COMPOSE_RECOVERY_KEY,
      JSON.stringify({ ...draft, updatedAt: new Date().toISOString() }),
    );
  } catch {
    // Private browsing and exhausted quotas must not break the composer.
  }
}

export function clearMailComposeRecovery(
  storage: Pick<Storage, "removeItem"> | null = browserStorage(),
): void {
  if (storage === null) return;
  try {
    storage.removeItem(MAIL_COMPOSE_RECOVERY_KEY);
  } catch {
    // Storage access may be denied by the browser.
  }
}

/** Text fields comparable between local recovery and a server draft. */
export type MailComposeDraftFields = Pick<
  MailComposeRecovery,
  "to" | "cc" | "bcc" | "subject" | "body"
>;

export type MailComposeReconcileDecision =
  | { readonly action: "empty" }
  | { readonly action: "use-local"; readonly local: MailComposeRecovery }
  | { readonly action: "use-server"; readonly clearLocal: boolean }
  | {
      readonly action: "conflict";
      readonly local: MailComposeRecovery;
      readonly server: MailComposeDraftFields & { readonly updatedAt?: string };
    };

function draftFieldsEqual(a: MailComposeDraftFields, b: MailComposeDraftFields): boolean {
  return (
    a.to === b.to &&
    a.cc === b.cc &&
    a.bcc === b.bcc &&
    a.subject === b.subject &&
    a.body === b.body
  );
}

/**
 * Decide how local crash recovery should relate to a server draft.
 * Server drafts are authoritative when equal/newer; never silent-overwrite server.
 */
export function reconcileMailComposeDrafts(input: {
  readonly local: MailComposeRecovery | null;
  readonly server: (MailComposeDraftFields & { readonly updatedAt?: string }) | null;
}): MailComposeReconcileDecision {
  const { local, server } = input;
  if (local === null && server === null) {
    return { action: "empty" };
  }
  if (local === null && server !== null) {
    return { action: "use-server", clearLocal: false };
  }
  if (local !== null && server === null) {
    return { action: "use-local", local };
  }
  // Both present — local and server are non-null after the guards above.
  const localDraft = local!;
  const serverDraft = server!;
  if (draftFieldsEqual(localDraft, serverDraft)) {
    return { action: "use-server", clearLocal: true };
  }
  const localMs = Date.parse(localDraft.updatedAt);
  const serverMs =
    typeof serverDraft.updatedAt === "string" ? Date.parse(serverDraft.updatedAt) : Number.NaN;
  if (Number.isFinite(serverMs) && Number.isFinite(localMs) && serverMs >= localMs) {
    return { action: "use-server", clearLocal: true };
  }
  if (Number.isFinite(serverMs) && Number.isFinite(localMs) && localMs > serverMs) {
    return { action: "conflict", local: localDraft, server: serverDraft };
  }
  // Unknown server timestamp with differing content — require explicit choice.
  return { action: "conflict", local: localDraft, server: serverDraft };
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecoveryRecord(value: unknown): value is MailComposeRecovery {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<keyof MailComposeRecovery, unknown>>;
  return (
    typeof candidate.to === "string" &&
    typeof candidate.cc === "string" &&
    typeof candidate.bcc === "string" &&
    typeof candidate.subject === "string" &&
    typeof candidate.body === "string" &&
    typeof candidate.updatedAt === "string"
  );
}
