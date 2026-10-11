/* Video conferencing for events.

   The calendar API has no conference field, so "Add video conferencing"
   creates a scheduled Meet room through the Meet tools and stores its join
   link in the event's `metadata.conference`. Swap `ConferenceProvider` when
   the calendar API grows native conference support. */

import { createMeetRoom } from "@/features/meet/api";

export interface EventConference {
  readonly provider: "helix-meet";
  readonly roomId: string;
  readonly joinCode: string;
  /** In-app join link, e.g. `/meet?code=abc-defg-hij`. */
  readonly url: string;
}

interface ConferenceRequest {
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly participantActorIds: readonly string[];
}

export interface ConferenceProvider {
  create(request: ConferenceRequest): Promise<EventConference>;
}

export const meetConferenceProvider: ConferenceProvider = {
  async create(request) {
    const room = await createMeetRoom({
      subject: request.title.slice(0, 200),
      participantActorIds: request.participantActorIds,
      scheduledStartAt: request.startsAt,
      scheduledEndAt: request.endsAt,
      metadata: { source: "calendar" },
    });
    return {
      provider: "helix-meet",
      roomId: room.id,
      joinCode: room.joinCode,
      url: `/meet?code=${encodeURIComponent(room.joinCode)}`,
    };
  },
};

export function conferenceFromMetadata(
  metadata: Record<string, unknown> | undefined,
): EventConference | null {
  const value = metadata?.conference;
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return record.provider === "helix-meet" &&
    typeof record.roomId === "string" &&
    typeof record.joinCode === "string" &&
    typeof record.url === "string"
    ? {
        provider: "helix-meet",
        roomId: record.roomId,
        joinCode: record.joinCode,
        url: record.url,
      }
    : null;
}

export function metadataWithConference(
  metadata: Record<string, unknown>,
  conference: EventConference | null,
): Record<string, unknown> {
  const rest = Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "conference"));
  return conference === null ? rest : { ...rest, conference };
}
