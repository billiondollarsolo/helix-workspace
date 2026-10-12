/* Signed-in devices and self-service app passwords: query factories and
   mutations that update the list at once and roll back if the server says no. */

import type { AccountSession } from "@helix/contracts";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { listPasskeys } from "@/lib/auth";
import {
  createMyAppPassword,
  listAccountSessions,
  listMyAppPasswords,
  revokeAccountSession,
  revokeMyAppPassword,
  revokeOtherAccountSessions,
  type AppPasswordRecord,
  type MyAppPasswords,
} from "./api";

/** Your signed-in browsers and devices. */
export function accountSessionsQueryOptions() {
  return queryOptions({
    queryKey: ["account", "sessions"] as const,
    queryFn: () => listAccountSessions(),
    throwOnError: false,
  });
}

/** Your passkeys, read fresh each time: they decide how you can verify. */
export function accountPasskeysQueryOptions() {
  return queryOptions({
    queryKey: ["account", "passkeys"] as const,
    queryFn: () => listPasskeys(),
    staleTime: 0,
    throwOnError: false,
  });
}

/** Sign out one device; it leaves the list at once and returns if that fails. */
export function useRevokeAccountSession() {
  const queryClient = useQueryClient();
  const { queryKey } = accountSessionsQueryOptions();
  return useMutation({
    mutationFn: (session: AccountSession) => revokeAccountSession(session.id),
    onMutate: async (session) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<readonly AccountSession[]>(queryKey);
      queryClient.setQueryData<readonly AccountSession[]>(queryKey, (current) =>
        current?.filter((entry) => entry.id !== session.id),
      );
      return { previous };
    },
    onError: (_error, _session, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(queryKey, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}

/** Sign out every device except this one; resolves to how many ended. */
export function useRevokeOtherAccountSessions() {
  const queryClient = useQueryClient();
  const { queryKey } = accountSessionsQueryOptions();
  return useMutation({
    mutationFn: () => revokeOtherAccountSessions(),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<readonly AccountSession[]>(queryKey);
      queryClient.setQueryData<readonly AccountSession[]>(queryKey, (current) =>
        current?.filter((entry) => entry.current),
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(queryKey, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}

/** Your app passwords and the scopes you may grant to a new one. */
export function myAppPasswordsQueryOptions(actorId: string) {
  return queryOptions({
    queryKey: ["account", "app-passwords", actorId] as const,
    queryFn: () => listMyAppPasswords({ actorId }),
    throwOnError: false,
  });
}

/** Create an app password; the one-time secret comes back in the result. */
export function useCreateMyAppPassword(actorId: string) {
  const queryClient = useQueryClient();
  const { queryKey } = myAppPasswordsQueryOptions(actorId);
  return useMutation({
    mutationFn: (input: { readonly label: string; readonly scopes: readonly string[] }) =>
      createMyAppPassword(input),
    onMutate: () => queryClient.cancelQueries({ queryKey }),
    onError: () => queryClient.invalidateQueries({ queryKey }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
}

/** Revoke an app password; it leaves the list at once and returns if that fails. */
export function useRevokeMyAppPassword(actorId: string) {
  const queryClient = useQueryClient();
  const { queryKey } = myAppPasswordsQueryOptions(actorId);
  return useMutation({
    mutationFn: (record: AppPasswordRecord) => revokeMyAppPassword(record.id),
    onMutate: async (record) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<MyAppPasswords>(queryKey);
      if (previous !== undefined) {
        queryClient.setQueryData<MyAppPasswords>(queryKey, {
          ...previous,
          appPasswords: previous.appPasswords.filter((entry) => entry.id !== record.id),
        });
      }
      return { previous };
    },
    onError: (_error, _record, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(queryKey, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}
