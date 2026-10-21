import { queryOptions } from "@tanstack/react-query";
import {
  getMailThread,
  getMailUserSettings,
  getMailVacation,
  listMailFilters,
  listMailFolders,
  listMailLabels,
  listMailThreads,
  listScheduledMail,
  type MailThreadsListInput,
} from "./api";

const mailQueryKeys = {
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
  settings: () => ["mail", "settings"] as const,
  scheduled: () => ["mail", "scheduled"] as const,
};

export function mailThreadsQueryOptions(input: MailThreadsListInput) {
  return queryOptions({
    queryKey: mailQueryKeys.threads(input),
    queryFn: () => listMailThreads(input),
    throwOnError: false,
  });
}

/** Scheduled sends, for Reschedule and Cancel send in the Scheduled folder. */
export function mailScheduledQueryOptions() {
  return queryOptions({
    queryKey: mailQueryKeys.scheduled(),
    queryFn: () => listScheduledMail({ limit: 200 }),
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

export function mailThreadQueryOptions(threadId: string) {
  return queryOptions({
    queryKey: mailQueryKeys.thread(threadId),
    queryFn: () => getMailThread(threadId),
    throwOnError: false,
  });
}

export function mailUserSettingsQueryOptions() {
  return queryOptions({
    queryKey: mailQueryKeys.settings(),
    queryFn: () => getMailUserSettings(),
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

export function mailVacationQueryOptions() {
  return queryOptions({
    queryKey: mailQueryKeys.vacation(),
    queryFn: () => getMailVacation(),
    throwOnError: false,
  });
}
