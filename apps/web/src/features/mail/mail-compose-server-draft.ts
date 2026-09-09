import { mailDraftSchema, type MailDraft } from "@helix/contracts";
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
  draft: Pick<
    MailDraft,
    "to" | "cc" | "bcc" | "subject" | "bodyText" | "attachments" | "updatedAt"
  >,
): MailComposeDraftFields & { readonly updatedAt: string } {
  return {
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    bodyText: draft.bodyText,
    attachments: draft.attachments,
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
  return mailDraftSchema.safeParse(value).success;
}

export function filterMailDraftRecords(values: readonly unknown[]): readonly MailDraft[] {
  return values.flatMap((value) => {
    const parsed = mailDraftSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
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
          bodyText: decision.local.bodyText,
          attachments: decision.local.attachments,
        },
        recoveryNotice: true,
        clearLocal: false,
        ...(serverDraft !== null && serverDraft !== undefined
          ? { serverDraftId: serverDraft.id, serverVersion: serverDraft.revision }
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
          bodyText: fields.bodyText,
          attachments: fields.attachments,
        },
        recoveryNotice: false,
        clearLocal: decision.clearLocal,
        serverDraftId: serverDraft.id,
        serverVersion: serverDraft.revision,
      };
    }
    case "conflict":
      return {
        kind: "conflict",
        local: decision.local,
        server: decision.server,
        serverDraftId: serverDraft?.id ?? "",
        serverVersion: serverDraft?.revision ?? 1,
      };
  }
}
