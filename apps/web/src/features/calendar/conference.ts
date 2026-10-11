/* Video conferencing on events. The server creates the Meet room when an
   event is created or updated with `conference: "meet"`, and stores
   `metadata.conference = { provider, roomId, joinCode, joinUrl }`. */

export interface EventConference {
  readonly provider: "meet";
  readonly roomId: string;
  readonly joinCode: string;
  readonly joinUrl: string;
}

export function conferenceFromMetadata(
  metadata: Record<string, unknown> | undefined,
): EventConference | null {
  const value = metadata?.conference;
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return record.provider === "meet" &&
    typeof record.roomId === "string" &&
    typeof record.joinCode === "string" &&
    typeof record.joinUrl === "string"
    ? {
        provider: "meet",
        roomId: record.roomId,
        joinCode: record.joinCode,
        joinUrl: record.joinUrl,
      }
    : null;
}

/** Metadata with the conference link kept, or removed when the user took it off. */
export function metadataWithConference(
  metadata: Record<string, unknown>,
  conference: EventConference | null,
): Record<string, unknown> {
  const rest = Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "conference"));
  return conference === null ? rest : { ...rest, conference };
}
