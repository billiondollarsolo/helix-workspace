/* Mutations behind the mail settings: labels, filters, vacation responder,
   signature and blocked senders. Each one refreshes the caches that show
   its result, so the sidebar, thread list and settings stay in step. */

import { MAIL_LABEL_COLORS, type MailLabelColorName } from "@helix/contracts";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createMailFilter,
  createMailLabel,
  deleteMailFilter,
  deleteMailLabel,
  setMailUserSettings,
  setMailVacation,
  updateMailFilter,
  updateMailLabel,
  type MailFilterCreateInput,
  type MailLabelSummary,
  type MailUserSettings,
  type MailVacationSetInput,
} from "../api";
import {
  mailFiltersQueryOptions,
  mailLabelsQueryOptions,
  mailUserSettingsQueryOptions,
  mailVacationQueryOptions,
} from "../queries";

export function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}

/** Retry for a failed load: invalidate the query so it fetches again. */
export function useRetry(queryKey: QueryKey): () => void {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey });
}

/* Mutations without optimistic state have no-op onMutate/onError: callers
   show the error from the mutation result. */

/** Labels show in the sidebar, thread rows and conversations. */
async function refreshLabels(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: mailLabelsQueryOptions().queryKey }),
    queryClient.invalidateQueries({ queryKey: ["mail", "threads"] }),
    queryClient.invalidateQueries({ queryKey: ["mail", "thread"] }),
  ]);
}

interface LabelSaveInput {
  readonly name: string;
  readonly color: MailLabelColorName;
  readonly parentId: string | null;
}

export function useCreateLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LabelSaveInput) => createMailLabel(input),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => refreshLabels(queryClient),
  });
}

/** Shows the change in every label list at once; rolls back if the save fails. */
export function useUpdateLabel() {
  const queryClient = useQueryClient();
  const { queryKey } = mailLabelsQueryOptions();
  return useMutation({
    mutationFn: (input: { readonly id: string } & Partial<LabelSaveInput>) =>
      updateMailLabel(input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<readonly MailLabelSummary[]>(queryKey);
      queryClient.setQueryData<readonly MailLabelSummary[]>(queryKey, (labels) =>
        labels?.map((label) =>
          label.id === input.id
            ? {
                ...label,
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
                ...(input.color === undefined
                  ? {}
                  : { colorName: input.color, color: MAIL_LABEL_COLORS[input.color] }),
              }
            : label,
        ),
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(queryKey, context.previous);
    },
    onSettled: () => refreshLabels(queryClient),
  });
}

export function useRemoveLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteMailLabel(id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => refreshLabels(queryClient),
  });
}

export function useSaveFilter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly id: string | null; readonly filter: MailFilterCreateInput }) =>
      input.id === null
        ? createMailFilter(input.filter)
        : updateMailFilter({ id: input.id, ...input.filter }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: mailFiltersQueryOptions().queryKey }),
  });
}

export function useDeleteFilter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteMailFilter(id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: mailFiltersQueryOptions().queryKey }),
  });
}

export function useSaveVacation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MailVacationSetInput) => setMailVacation(input),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: (saved) => {
      queryClient.setQueryData(mailVacationQueryOptions().queryKey, saved);
    },
  });
}

/** Partial update: fields left out keep their saved values. */
export function useSaveMailUserSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<Omit<MailUserSettings, "updatedAt">>) => setMailUserSettings(input),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: (saved) => {
      queryClient.setQueryData(mailUserSettingsQueryOptions().queryKey, saved);
    },
  });
}
