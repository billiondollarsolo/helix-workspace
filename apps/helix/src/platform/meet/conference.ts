import type { CalendarConferenceProvider } from "../calendar/types.js";
import { type CreateMeetToolDefinitionsOptions, deploymentJitsiOrigin } from "./tools.js";

/**
 * Video conferencing for Calendar's "Add video conferencing": a scheduled room
 * for the event's attendees, linked by its join code. Registered only when Meet
 * has deployment credentials, like the Meet tools themselves.
 */
export function createMeetConferenceProvider(
  options: Pick<CreateMeetToolDefinitionsOptions, "store" | "jitsiPublicUrl" | "jwtSubject"> & {
    readonly publicBaseUrl: string;
  },
): CalendarConferenceProvider {
  const jitsiDomain = new URL(deploymentJitsiOrigin(options)).hostname;
  return {
    async createRoom(input) {
      const room = await options.store.createRoom({
        orgId: input.orgId,
        actorId: input.actorId,
        subject: input.subject,
        jitsiDomain,
        participantActorIds: input.participantActorIds,
        scheduledStartAt: input.startsAt,
        scheduledEndAt: input.endsAt,
        status: "scheduled",
        metadata: { source: "calendar" },
      });
      const joinUrl = new URL("/meet", options.publicBaseUrl);
      joinUrl.searchParams.set("code", room.joinCode);
      return { roomId: room.id, joinCode: room.joinCode, joinUrl: joinUrl.toString() };
    },
  };
}
