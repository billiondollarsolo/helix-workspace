import { authenticatedFetch } from "@/lib/auth";
import { callTool } from "@/lib/tool-call";
import type {
  MailAddress,
  MailAttachmentInput,
  MailFilter,
  MailOutboundRecord,
  MailThreadRow as MailThreadRowContract,
  MailThreadsListResult as MailThreadsListResultContract,
} from "@helix/contracts";

export type MailApiAddress = MailAddress;

export type MailFolderKey =
  | "inbox"
  | "starred"
  | "snoozed"
  | "sent"
  | "drafts"
  | "archive"
  | "spam"
  | "trash";

export type MailCategoryTab = "primary" | "updates" | "promotions" | "social";

export type MailThreadRow = MailThreadRowContract & {
  readonly category: MailCategoryTab;
  readonly folder: MailFolderKey;
};

export interface MailThreadsListInput {
  readonly folder: MailFolderKey;
  readonly tab?: MailCategoryTab;
  readonly label?: string;
  readonly query?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export type MailThreadsListResult = Omit<MailThreadsListResultContract, "threads"> & {
  readonly threads: readonly MailThreadRow[];
  readonly limit: number;
  readonly offset: number;
};

export interface MailFolderSummary {
  readonly id: MailFolderKey;
  readonly label: string;
  readonly total: number;
  readonly unread: number;
}

export interface MailLabelSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly color: string;
  readonly sortOrder: number;
  readonly threadCount: number;
  readonly shared: boolean;
}

export interface MailSearchHit {
  readonly threadId: string;
  readonly messageId: string;
  readonly subject: string;
  readonly from?: MailApiAddress;
  readonly preview: string;
  readonly sentAt: string;
  readonly labels: readonly string[];
  readonly unread?: boolean;
  readonly starred?: boolean;
}

export interface MailThreadMessage {
  readonly id: string;
  readonly from?: MailApiAddress;
  readonly to: readonly MailApiAddress[];
  readonly cc: readonly MailApiAddress[];
  readonly bcc: readonly MailApiAddress[];
  readonly sentAt: string;
  readonly body: string;
  readonly bodyFormat: "plain" | "html";
  readonly hasAttachment: boolean;
}

export interface MailThreadDetail {
  readonly id: string;
  readonly subject: string;
  readonly preview: string;
  readonly participants: readonly MailApiAddress[];
  readonly messages: readonly MailThreadMessage[];
  readonly labels: readonly string[];
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly snoozedUntil: string | null;
  readonly lastActivity: string;
  readonly unread: boolean;
  readonly starred: boolean;
  readonly direction: "inbound" | "outbound" | "mixed";
}

/** Prefer Drive `objectId` for large files; base64 `content` remains for small inline attachments. */
export type MailAttachment = MailAttachmentInput & {
  readonly filename?: string;
  readonly contentType?: string;
  readonly content?: string;
  readonly objectId?: string;
};

export interface MailSendInput {
  readonly to: readonly MailApiAddress[];
  readonly cc?: readonly MailApiAddress[];
  readonly bcc?: readonly MailApiAddress[];
  readonly subject: string;
  readonly bodyText: string;
  readonly attachments?: readonly MailAttachment[];
}

export interface MailReplyInput extends MailSendInput {
  readonly threadId: string;
}

export interface MailSendResult {
  readonly id?: string;
  readonly outboundId?: string;
  readonly messageId?: string;
  readonly threadId?: string;
  readonly status?: string;
  readonly undoUntil?: string;
  readonly queuedAt?: string;
}

export interface MailDraftResult {
  readonly id: string;
  readonly version: number;
  readonly updatedAt: string;
}

export interface MailDraftSaveInput {
  readonly id?: string;
  readonly expectedVersion?: number;
  readonly to: readonly MailApiAddress[];
  readonly cc: readonly MailApiAddress[];
  readonly bcc: readonly MailApiAddress[];
  readonly subject: string;
  readonly bodyText: string;
  readonly attachments: readonly MailAttachment[];
}

export interface MailFilterCriteria {
  readonly fromContains?: string;
  readonly toContains?: string;
  readonly subjectContains?: string;
  readonly bodyContains?: string;
  readonly hasAttachment?: boolean;
}

export interface MailFilterActions {
  readonly applyLabels?: readonly string[];
  readonly archive?: boolean;
  readonly delete?: boolean;
  readonly snoozeUntil?: string;
}

export type MailFilterRecord = MailFilter;

export interface MailFilterCreateInput {
  readonly name: string;
  readonly enabled?: boolean;
  readonly priority?: number;
  readonly criteria?: MailFilterCriteria;
  readonly actions?: MailFilterActions;
}

export interface MailFilterUpdateInput extends Partial<MailFilterCreateInput> {
  readonly id: string;
}

export interface MailVacationSettings {
  readonly id?: string;
  readonly enabled: boolean;
  readonly subject: string;
  readonly body: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly updatedAt?: string;
}

export interface MailVacationSetInput {
  readonly enabled: boolean;
  readonly subject: string;
  readonly body: string;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
}

export type MailApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function searchMail(
  input: { readonly query?: string; readonly labels?: readonly string[]; readonly limit?: number },
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<readonly MailSearchHit[]> {
  const output = await callMailTool<{ readonly hits?: readonly MailSearchHit[] }>(
    "mail.search",
    {
      query: input.query,
      labels: input.labels ?? [],
      limit: input.limit ?? 50,
    },
    fetchImpl,
  );

  return output.hits ?? [];
}

export async function listMailThreads(
  input: MailThreadsListInput,
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<MailThreadsListResult> {
  const output = await callMailTool<Partial<MailThreadsListResult>>(
    "mail.threads.list",
    {
      folder: input.folder,
      ...(input.tab === undefined ? {} : { tab: input.tab }),
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.query === undefined || input.query.trim() === ""
        ? {}
        : { query: input.query.trim() }),
      limit: input.limit ?? 50,
      offset: input.offset ?? 0,
    },
    fetchImpl,
  );
  return {
    threads: output.threads ?? [],
    total: output.total ?? 0,
    limit: output.limit ?? input.limit ?? 50,
    offset: output.offset ?? input.offset ?? 0,
  };
}

export async function listMailFolders(
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<readonly MailFolderSummary[]> {
  const output = await callMailTool<{ readonly folders?: readonly MailFolderSummary[] }>(
    "mail.folders.list",
    {},
    fetchImpl,
  );
  return output.folders ?? [];
}

export async function listMailLabels(
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<readonly MailLabelSummary[]> {
  const output = await callMailTool<{ readonly labels?: readonly MailLabelSummary[] }>(
    "mail.labels.list",
    {},
    fetchImpl,
  );
  return output.labels ?? [];
}

export async function sendMail(
  input: MailSendInput,
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<MailSendResult> {
  return callMailTool<MailSendResult>(
    "mail.send",
    {
      to: input.to,
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      subject: input.subject,
      bodyText: input.bodyText,
      ...(input.attachments !== undefined && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
    },
    fetchImpl,
  );
}

export async function getMailThread(
  threadId: string,
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<MailThreadDetail | null> {
  const output = await callMailTool<{ readonly thread?: MailThreadDetail | null }>(
    "mail.thread.get",
    { threadId },
    fetchImpl,
  );
  return output.thread ?? null;
}

export async function replyToMail(
  input: MailReplyInput,
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<MailSendResult> {
  return callMailTool<MailSendResult>(
    "mail.reply",
    {
      threadId: input.threadId,
      to: input.to,
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      subject: input.subject,
      bodyText: input.bodyText,
    },
    fetchImpl,
  );
}

export async function archiveMailThread(
  threadId: string,
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<void> {
  await callMailTool("mail.archive", { threadId }, fetchImpl);
}

export async function deleteMailThread(
  threadId: string,
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<void> {
  await callMailTool("mail.delete", { threadId }, fetchImpl);
}

export async function spamMailThread(
  threadId: string,
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<void> {
  await callMailTool("mail.spam", { threadId, spam: true }, fetchImpl);
}

export async function cancelOutboundMail(
  outboundId: string,
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<MailOutboundRecord | null> {
  const output = await callMailTool<{ readonly outbound?: MailOutboundRecord | null }>(
    "mail.outbound.cancel",
    { outboundId },
    fetchImpl,
  );
  return output.outbound ?? null;
}

export async function listMailDrafts(
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<readonly unknown[]> {
  const output = await callMailTool<{ readonly drafts?: readonly unknown[] }>(
    "mail.draft.list",
    {},
    fetchImpl,
  );
  return output.drafts ?? [];
}

export async function saveMailDraft(
  input: MailDraftSaveInput,
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<MailDraftResult> {
  return callMailTool<MailDraftResult>("mail.draft.save", input, fetchImpl);
}

export async function discardMailDraft(
  id: string,
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<boolean> {
  const output = await callMailTool<{ readonly deleted?: boolean }>(
    "mail.draft.discard",
    { id },
    fetchImpl,
  );
  return output.deleted ?? false;
}

export async function snoozeMailThread(
  input: { readonly threadId: string; readonly until: string },
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<void> {
  await callMailTool("mail.snooze", input, fetchImpl);
}

export async function setMailThreadRead(
  input: { readonly threadId: string; readonly unread: boolean },
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<void> {
  await callMailTool("mail.read.set", input, fetchImpl);
}

export async function setMailThreadStarred(
  input: { readonly threadId: string; readonly starred: boolean },
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<void> {
  await callMailTool("mail.star.set", input, fetchImpl);
}

export async function applyMailLabels(
  input: {
    readonly threadId: string;
    readonly add?: readonly string[];
    readonly remove?: readonly string[];
  },
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<void> {
  await callMailTool(
    "mail.label.apply",
    {
      threadId: input.threadId,
      add: input.add ?? [],
      remove: input.remove ?? [],
    },
    fetchImpl,
  );
}

export async function createMailFilter(
  input: MailFilterCreateInput,
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<MailFilterRecord> {
  return callMailTool<MailFilterRecord>(
    "mail.filter.create",
    {
      name: input.name,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 100,
      criteria: input.criteria ?? {},
      actions: input.actions ?? {},
    },
    fetchImpl,
  );
}

export async function listMailFilters(
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<readonly MailFilterRecord[]> {
  const output = await callMailTool<{ readonly filters?: readonly MailFilterRecord[] }>(
    "mail.filter.list",
    {},
    fetchImpl,
  );
  return output.filters ?? [];
}

export async function updateMailFilter(
  input: MailFilterUpdateInput,
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<MailFilterRecord> {
  return callMailTool<MailFilterRecord>(
    "mail.filter.update",
    {
      id: input.id,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.criteria === undefined ? {} : { criteria: input.criteria }),
      ...(input.actions === undefined ? {} : { actions: input.actions }),
    },
    fetchImpl,
  );
}

export async function deleteMailFilter(
  id: string,
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<boolean> {
  const output = await callMailTool<{ readonly deleted?: boolean }>(
    "mail.filter.delete",
    { id },
    fetchImpl,
  );
  return output.deleted ?? false;
}

export async function getMailVacation(
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<MailVacationSettings | null> {
  const output = await callMailTool<{ readonly vacation?: MailVacationSettings | null }>(
    "mail.vacation.get",
    {},
    fetchImpl,
  );
  return output.vacation ?? null;
}

export async function setMailVacation(
  input: MailVacationSetInput,
  fetchImpl: MailApiFetch = authenticatedFetch,
): Promise<MailVacationSettings> {
  const output = await callMailTool<{ readonly vacation?: MailVacationSettings }>(
    "mail.vacation.set",
    {
      enabled: input.enabled,
      subject: input.subject,
      body: input.body,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
    },
    fetchImpl,
  );

  if (output.vacation === undefined) {
    throw new Error("mail.vacation.set response was missing vacation settings.");
  }
  return output.vacation;
}

async function callMailTool<Output = unknown>(
  toolId: string,
  input: unknown,
  fetchImpl: MailApiFetch,
): Promise<Output> {
  return callTool<Output>(toolId, input, { fetchImpl });
}
