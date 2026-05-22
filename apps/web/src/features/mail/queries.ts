import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import {
  getMailThread,
  getMailVacation,
  listMailFilters,
  listMailFolders,
  listMailLabels,
  listMailThreads,
  searchMail,
  type MailThreadsListInput,
} from "./api";

export interface MailSearchQueryInput {
  readonly query?: string;
  readonly labels?: readonly string[];
  readonly limit?: number;
}

export const mailRouteMailboxes = ["inbox", "starred", "sent", "drafts", "archive"] as const;
export type MailRouteMailbox = (typeof mailRouteMailboxes)[number];

export const mailRouteLabels = ["planning", "finance", "support", "team"] as const;
export type MailRouteLabel = (typeof mailRouteLabels)[number];

export interface MailRouteSearch {
  readonly thread?: string;
  readonly message?: string;
  readonly q?: string;
  readonly label?: MailRouteLabel;
  readonly mailbox?: MailRouteMailbox;
  readonly unread?: boolean;
  readonly priority?: boolean;
  readonly attachments?: boolean;
}

export interface MailSearchState {
  readonly query: string;
  readonly label: MailRouteLabel | "all";
  readonly mailbox: MailRouteMailbox;
  readonly unreadOnly: boolean;
  readonly priorityOnly: boolean;
  readonly attachmentsOnly: boolean;
}

export const defaultMailSearchInput = {
  query: "",
  labels: [],
  limit: 50,
} as const satisfies MailSearchQueryInput;

export const defaultMailSearchState = {
  query: "",
  label: "all",
  mailbox: "inbox",
  unreadOnly: false,
  priorityOnly: false,
  attachmentsOnly: false,
} as const satisfies MailSearchState;

export const mailQueryKeys = {
  search: (input: MailSearchQueryInput = defaultMailSearchInput) =>
    [
      "mail",
      "search",
      input.query ?? "",
      [...(input.labels ?? [])].sort().join(","),
      input.limit ?? 50,
    ] as const,
  thread: (threadId: string) => ["mail", "thread", threadId] as const,
  threads: (input: MailThreadsListInput) =>
    [
      "mail",
      "threads",
      input.folder,
      input.tab ?? "",
      input.label ?? "",
      input.query?.trim() ?? "",
      input.limit ?? 50,
      input.offset ?? 0,
    ] as const,
  folders: () => ["mail", "folders"] as const,
  labels: () => ["mail", "labels"] as const,
  filters: () => ["mail", "filters"] as const,
  vacation: () => ["mail", "vacation"] as const,
};

export function mailThreadsQueryOptions(input: MailThreadsListInput) {
  return queryOptions({
    queryKey: mailQueryKeys.threads(input),
    queryFn: () => listMailThreads(input),
    throwOnError: false,
  });
}

export function mailFoldersQueryOptions() {
  return queryOptions({
    queryKey: mailQueryKeys.folders(),
    queryFn: () => listMailFolders(),
    throwOnError: false,
  });
}

export function mailLabelsQueryOptions() {
  return queryOptions({
    queryKey: mailQueryKeys.labels(),
    queryFn: () => listMailLabels(),
    throwOnError: false,
  });
}

const nonEmptyStringParam = z
  .string()
  .trim()
  .min(1)
  .optional()
  .catch(undefined);

const booleanRouteParam = z
  .union([z.literal(true), z.literal("true"), z.literal("1")])
  .optional()
  .catch(undefined);

const mailRouteSearchSchema = z
  .object({
    thread: nonEmptyStringParam,
    message: nonEmptyStringParam,
    q: nonEmptyStringParam,
    label: z.enum(mailRouteLabels).optional().catch(undefined),
    mailbox: z.enum(mailRouteMailboxes).optional().catch(undefined),
    unread: booleanRouteParam,
    priority: booleanRouteParam,
    attachments: booleanRouteParam,
  })
  .catch({});

export function mailSearchQueryOptions(input: MailSearchQueryInput = defaultMailSearchInput) {
  return queryOptions({
    queryKey: mailQueryKeys.search(input),
    queryFn: () => searchMail(input),
    throwOnError: false,
  });
}

export function validateMailRouteSearch(search: Record<string, unknown>): MailRouteSearch {
  const parsed = mailRouteSearchSchema.parse(search);

  return {
    thread: parsed.thread,
    message: parsed.message,
    q: parsed.q,
    label: parsed.label,
    mailbox: parsed.mailbox,
    unread: parsed.unread === undefined ? undefined : true,
    priority: parsed.priority === undefined ? undefined : true,
    attachments: parsed.attachments === undefined ? undefined : true,
  };
}

export function mailSearchStateFromRouteSearch(search: MailRouteSearch): MailSearchState {
  return {
    query: search.q ?? defaultMailSearchState.query,
    label: search.label ?? defaultMailSearchState.label,
    mailbox: search.mailbox ?? defaultMailSearchState.mailbox,
    unreadOnly: search.unread ?? defaultMailSearchState.unreadOnly,
    priorityOnly: search.priority ?? defaultMailSearchState.priorityOnly,
    attachmentsOnly: search.attachments ?? defaultMailSearchState.attachmentsOnly,
  };
}

export function mailRouteSearchFromState(
  state: MailSearchState,
  current: Pick<MailRouteSearch, "thread" | "message"> = {},
): MailRouteSearch {
  return {
    thread: current.thread,
    message: current.message,
    q: state.query.trim() || undefined,
    label: state.label === "all" ? undefined : state.label,
    mailbox: state.mailbox === defaultMailSearchState.mailbox ? undefined : state.mailbox,
    unread: state.unreadOnly || undefined,
    priority: state.priorityOnly || undefined,
    attachments: state.attachmentsOnly || undefined,
  };
}

export function mailSearchInputFromState(state: MailSearchState): MailSearchQueryInput {
  return {
    query: state.query,
    labels: state.label === "all" ? [] : [state.label],
    limit: defaultMailSearchInput.limit,
  };
}

export function mailSearchInputFromRouteSearch(search: MailRouteSearch): MailSearchQueryInput {
  return mailSearchInputFromState(mailSearchStateFromRouteSearch(search));
}

export function mailThreadQueryOptions(threadId: string) {
  return queryOptions({
    queryKey: mailQueryKeys.thread(threadId),
    queryFn: () => getMailThread(threadId),
    throwOnError: false,
  });
}

export function mailVacationQueryOptions() {
  return queryOptions({
    queryKey: mailQueryKeys.vacation(),
    queryFn: () => getMailVacation(),
    throwOnError: false,
  });
}

export function mailFiltersQueryOptions() {
  return queryOptions({
    queryKey: mailQueryKeys.filters(),
    queryFn: () => listMailFilters(),
    throwOnError: false,
  });
}
