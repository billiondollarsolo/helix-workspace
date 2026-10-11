import type { AccountPreferences, AccountPreferencesSetInput } from "@helix/contracts";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAccountPreferences, setAccountPreferences } from "./api";

/** One cache entry for `account.preferences`, shared by every surface that reads them. */
export function accountPreferencesQueryOptions() {
  return queryOptions({
    queryKey: ["account", "preferences"] as const,
    queryFn: () => getAccountPreferences(),
    throwOnError: false,
  });
}

/**
 * Saves a partial preferences update. The cache shows the change at once and
 * rolls back if the save fails; the saved record replaces it on success.
 */
export function useSetAccountPreferences() {
  const queryClient = useQueryClient();
  const { queryKey } = accountPreferencesQueryOptions();
  return useMutation({
    mutationFn: (input: AccountPreferencesSetInput) => setAccountPreferences(input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<AccountPreferences>(queryKey);
      if (previous !== undefined) {
        queryClient.setQueryData<AccountPreferences>(queryKey, mergePreferences(previous, input));
      }
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(queryKey, context.previous);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKey, saved);
    },
  });
}

function mergePreferences(
  current: AccountPreferences,
  input: AccountPreferencesSetInput,
): AccountPreferences {
  const { mail, ...rest } = input;
  const fields = stripUndefined(rest) as Partial<AccountPreferences> & {
    detectedTimeZone?: string;
  };
  delete fields.detectedTimeZone;
  return { ...current, ...fields, mail: { ...current.mail, ...stripUndefined(mail ?? {}) } };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
