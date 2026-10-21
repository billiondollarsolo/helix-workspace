/* The meeting lobby for hosts and co-hosts: who is waiting to join, with
   Admit and Deny. The list comes from `meet.lobby.list`; it is fetched on
   join, whenever the server's `helix.lobby` data message arrives (see
   `useLiveKitCall`'s `onLobbyWaiting`), and every 10 s as a fallback. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { admitMeetLobbyGuest, denyMeetLobbyGuest, type MeetLobbyRequest } from "./api";
import { meetLobbyQueryOptions, meetQueryKeys } from "./queries";

type LobbyDecision = "admit" | "deny";

export interface MeetLobbyControls {
  readonly waiting: readonly MeetLobbyRequest[];
  /** Fetch the list again now (the server said someone started waiting). */
  readonly refresh: () => void;
  readonly decide: (participantSubject: string, decision: LobbyDecision) => void;
  /** The guest a decision is being saved for. */
  readonly pendingSubject: string | null;
  readonly errorMessage: string | null;
}

export function useMeetLobby(roomId: string, enabled: boolean): MeetLobbyControls {
  const queryClient = useQueryClient();
  const query = useQuery(meetLobbyQueryOptions(roomId, enabled));
  const refresh = useCallback(() => {
    if (enabled) void queryClient.invalidateQueries({ queryKey: meetQueryKeys.lobby(roomId) });
  }, [enabled, queryClient, roomId]);

  const mutation = useMutation({
    mutationFn: async (input: {
      readonly participantSubject: string;
      readonly decision: LobbyDecision;
    }) => {
      if (input.decision === "admit") await admitMeetLobbyGuest(roomId, input.participantSubject);
      else await denyMeetLobbyGuest(roomId, input.participantSubject);
    },
    onMutate: () => undefined,
    onSettled: () => {
      refresh();
    },
    onError: () => undefined,
  });

  return {
    waiting: enabled ? (query.data ?? []) : [],
    refresh,
    decide: (participantSubject, decision) => {
      if (!mutation.isPending) mutation.mutate({ participantSubject, decision });
    },
    pendingSubject: mutation.isPending ? (mutation.variables?.participantSubject ?? null) : null,
    errorMessage: mutation.isError
      ? mutation.error instanceof Error && mutation.error.message.length > 0
        ? mutation.error.message
        : "That didn’t work. Try again."
      : null,
  };
}

/** A non-blocking notice over the call: who is waiting, with Admit and Deny. */
export function LobbyNotice({ lobby }: { readonly lobby: MeetLobbyControls }) {
  const { waiting, pendingSubject } = lobby;
  if (waiting.length === 0 && lobby.errorMessage === null) return null;
  const heading =
    waiting.length === 1
      ? `${waiting[0]?.displayName ?? "Someone"} is waiting to join`
      : `${String(waiting.length)} people are waiting to join`;
  return (
    <section
      aria-label="Waiting to join"
      className="absolute top-3 right-3 z-10 w-80 max-w-[calc(100%-24px)] rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 shadow-lg"
    >
      {waiting.length > 0 ? (
        <p role="status" className="m-0 type-body-sm font-semibold">
          {heading}
        </p>
      ) : null}
      <ul className="m-0 mt-2 grid gap-2 p-0 [list-style:none]">
        {waiting.map((guest) => {
          const busy = pendingSubject === guest.participantSubject;
          return (
            <li key={guest.participantSubject} className="flex items-center gap-2">
              {waiting.length > 1 ? (
                <span className="min-w-0 flex-1 truncate type-body-sm">{guest.displayName}</span>
              ) : (
                <span className="flex-1" />
              )}
              <button
                type="button"
                className="btn sm primary"
                aria-label={`Admit ${guest.displayName}`}
                disabled={pendingSubject !== null}
                aria-busy={busy}
                onClick={() => {
                  lobby.decide(guest.participantSubject, "admit");
                }}
              >
                Admit
              </button>
              <button
                type="button"
                className="btn sm"
                aria-label={`Deny ${guest.displayName}`}
                disabled={pendingSubject !== null}
                onClick={() => {
                  lobby.decide(guest.participantSubject, "deny");
                }}
              >
                Deny
              </button>
            </li>
          );
        })}
      </ul>
      {lobby.errorMessage !== null ? (
        <p role="alert" className="m-0 mt-2 type-meta text-[var(--danger)]">
          {lobby.errorMessage}
        </p>
      ) : null}
    </section>
  );
}
