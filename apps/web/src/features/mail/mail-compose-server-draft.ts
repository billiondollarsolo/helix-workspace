import type { MailDraft } from "@helix/contracts";
import type { MailComposeDraftFields, MailComposeRecovery } from "./mail-compose-recovery";

/** Join address lists for compose text fields (comma-separated). */
export function mailAddressesToField(
  addresses: readonly { readonly address: string }[] | undefined,
): string {
  if (addresses === undefined || addresses.length === 0) {
    return "";
  }
  return addresses.map((entry) => entry.address).join(", ");
}

/** Map a server MailDraft into compose recovery/compare fields. */
export function serverDraftToComposeFields(
  draft: Pick<MailDraft, "to" | "cc" | "bcc" | "subject" | "bodyText" | "updatedAt">,
): MailComposeDraftFields & { readonly updatedAt: string } {
  return {
    to: mailAddressesToField(draft.to),
    cc: mailAddressesToField(draft.cc),
    bcc: mailAddressesToField(draft.bcc),
    subject: draft.subject,
    body: draft.bodyText,
    updatedAt: draft.updatedAt,
  };
}

/** Prefer the most recently updated draft when opening compose without an id. */
export function pickLatestMailDraft(drafts: readonly MailDraft[]): MailDraft | null {
  if (drafts.length === 0) {
    return null;
  }
  let best = drafts[0]!;
  let bestMs = Date.parse(best.updatedAt);
  for (const candidate of drafts.slice(1)) {
    const ms = Date.parse(candidate.updatedAt);
    if (Number.isFinite(ms) && (!Number.isFinite(bestMs) || ms > bestMs)) {
      best = candidate;
      bestMs = ms;
    }
  }
  return best;
}

export function isMailDraftRecord(value: unknown): value is MailDraft {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<MailDraft>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.subject === "string" &&
    typeof candidate.bodyText === "string" &&
    typeof candidate.updatedAt === "string" &&
    Array.isArray(candidate.to) &&
    Array.isArray(candidate.cc) &&
    Array.isArray(candidate.bcc)
  );
}

export function filterMailDraftRecords(values: readonly unknown[]): readonly MailDraft[] {
  return values.filter(isMailDraftRecord);
}

/** Initial hydrate snapshot after reconcile (no silent overwrite). */
export type ComposeOpenHydration =
  | { readonly kind: "empty" }
  | {
      readonly kind: "fields";
      readonly fields: MailComposeDraftFields;
      readonly recoveryNotice: boolean;
      readonly clearLocal: boolean;
      readonly serverDraftId?: string;
      readonly serverVersion?: number;
    }
  | {
      readonly kind: "conflict";
      readonly local: MailComposeRecovery;
      readonly server: MailComposeDraftFields & { readonly updatedAt?: string };
      readonly serverDraftId: string;
      readonly serverVersion: number;
    };

export function hydrationFromReconcile(input: {
  readonly decision: import("./mail-compose-recovery").MailComposeReconcileDecision;
  readonly serverDraft?: MailDraft | null;
}): ComposeOpenHydration {
  const { decision, serverDraft } = input;
  switch (decision.action) {
    case "empty":
      return { kind: "empty" };
    case "use-local":
      return {
        kind: "fields",
        fields: {
          to: decision.local.to,
          cc: decision.local.cc,
          bcc: decision.local.bcc,
          subject: decision.local.subject,
          body: decision.local.body,
        },
        recoveryNotice: true,
        clearLocal: false,
        ...(serverDraft !== null && serverDraft !== undefined
          ? { serverDraftId: serverDraft.id, serverVersion: serverDraft.version }
          : {}),
      };
    case "use-server": {
      if (serverDraft === null || serverDraft === undefined) {
        return { kind: "empty" };
      }
      const fields = serverDraftToComposeFields(serverDraft);
      return {
        kind: "fields",
        fields: {
          to: fields.to,
          cc: fields.cc,
          bcc: fields.bcc,
          subject: fields.subject,
          body: fields.body,
        },
        recoveryNotice: false,
        clearLocal: decision.clearLocal,
        serverDraftId: serverDraft.id,
        serverVersion: serverDraft.version,
      };
    }
    case "conflict":
      return {
        kind: "conflict",
        local: decision.local,
        server: decision.server,
        serverDraftId: serverDraft?.id ?? "",
        serverVersion: serverDraft?.version ?? 1,
      };
  }
}
