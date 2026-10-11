/* Video conferencing on events. The server creates the Meet room when an
   event is created or updated with `conference: "meet"`, and stores
   `metadata.conference = { provider, roomId, joinCode, joinUrl }`. An
   invitation imported from mail stores `{ provider: "external", joinUrl }`:
   another system's meeting, shown only as a plain link. */

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

/** The meeting link an imported invitation carried, or null. */
export function externalConferenceUrl(
  metadata: Record<string, unknown> | undefined,
): string | null {
  const value = metadata?.conference;
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return record.provider === "external" && typeof record.joinUrl === "string"
    ? record.joinUrl
    : null;
}

/**
 * Metadata with the Meet link kept, or removed when the user took it off. An
 * imported invitation's external link is not the user's to remove here.
 */
export function metadataWithConference(
  metadata: Record<string, unknown>,
  conference: EventConference | null,
): Record<string, unknown> {
  if (conference !== null) return { ...metadata, conference };
  if (conferenceFromMetadata(metadata) === null) return metadata;
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "conference"));
}
