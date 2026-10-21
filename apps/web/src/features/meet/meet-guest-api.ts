/* Guest join: people outside the organization join with a signed invitation
   from the link's URL fragment. The endpoint is public (no session), so it is
   called with `sessionOptionalFetch`, which never redirects to sign-in. */

import { sessionOptionalFetch, type AuthFetch } from "@/lib/auth";
import { MEET_RECORDING_NOTICE_VERSION, type MeetControlState } from "./api";

/** The LiveKit join payload a guest receives once let in. */
export interface MeetGuestJoin {
  readonly roomId: string;
  readonly roomName: string;
  readonly serverUrl: string;
  readonly token: string;
  readonly recordingActive: boolean;
  readonly recordingNoticeVersion: string;
  readonly controls: MeetControlState;
}

export type MeetGuestJoinResult =
  | { readonly kind: "joined"; readonly join: MeetGuestJoin }
  | { readonly kind: "waiting"; readonly retryAfterMs: number }
  /** The host turned the guest away; this is final. */
  | { readonly kind: "denied" }
  /** The meeting is locked, or this guest was removed. */
  | { readonly kind: "blocked" }
  /** Unknown, expired or revoked invitation, or the meeting ended. */
  | { readonly kind: "invalid" }
  | { readonly kind: "error"; readonly message: string };

export interface MeetGuestJoinInput {
  readonly token: string;
  readonly email: string;
  readonly name: string;
  readonly deviceId: string;
  readonly joinGrantId: string;
}

const DEFAULT_RETRY_MS = 3_000;

export async function postMeetGuestJoin(
  input: MeetGuestJoinInput,
  fetchImpl: AuthFetch = sessionOptionalFetch,
  signal?: AbortSignal,
): Promise<MeetGuestJoinResult> {
  const response = await fetchImpl("/api/meet/guest/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: input.token,
      email: input.email,
      name: input.name,
      recordingNoticeAccepted: true,
      recordingNoticeVersion: MEET_RECORDING_NOTICE_VERSION,
      deviceId: input.deviceId,
      joinGrantId: input.joinGrantId,
    }),
    ...(signal === undefined ? {} : { signal }),
  });
  const body: unknown = await response.json().catch(() => ({}));
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (response.status === 202) {
    const retry = record.retryAfterMs;
    return {
      kind: "waiting",
      retryAfterMs: typeof retry === "number" && retry > 0 ? retry : DEFAULT_RETRY_MS,
    };
  }
  if (response.ok) return { kind: "joined", join: body as MeetGuestJoin };
  if (response.status === 403)
    return record.denied === true ? { kind: "denied" } : { kind: "blocked" };
  if (response.status === 404) return { kind: "invalid" };
  if (response.status === 400) {
    return { kind: "error", message: "Check your name and email, then try again." };
  }
  return { kind: "error", message: "Something went wrong. Try again in a moment." };
}

/** The invitation token from a `/meet/guest#<token>` link. */
export function guestTokenFromHash(hash: string): string {
  const raw = hash.replace(/^#/u, "").trim();
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The link a host shares; the token stays in the fragment, off servers and logs. */
export function meetGuestLink(token: string, origin = window.location.origin): string {
  return `${origin}/meet/guest#${token}`;
}
