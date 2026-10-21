/* Carries out an authorized host control on the live call. The store has already
   checked the host's authority, recorded the change and audited it; this applies
   the result to LiveKit. It acts on the subject the store authorized, never on a
   participant id the browser supplied. */

import { liveKitPolicyGrants } from "./livekit.js";
import type { LiveKitRooms } from "./livekit-rooms.js";
import { meetJwtFeatures } from "./policy.js";
import type { MeetControlAction, MeetControlState } from "./types.js";

export async function applyHostControlToCall(
  rooms: LiveKitRooms,
  input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly control: MeetControlAction;
    readonly state: MeetControlState;
  },
): Promise<void> {
  const { orgId, roomId, control } = input;
  switch (control.action) {
    case "remove":
      await rooms.removeParticipant(orgId, roomId, control.participantSubject);
      return;
    case "mute": {
      const source = control.mediaType === "audio" ? "microphone" : "camera";
      const participant = (await rooms.listParticipants(orgId, roomId)).find(
        (candidate) => candidate.identity === control.participantSubject,
      );
      for (const track of participant?.tracks ?? []) {
        if (track.source === source)
          await rooms.muteTrack(orgId, roomId, participant?.identity ?? "", track.sid);
      }
      return;
    }
    // Lobby and lock are enforced when Helix issues join tokens.
    case "set_lobby":
    case "admit":
    case "set_lock":
      return;
    default:
      await syncCallPermissions(rooms, input);
  }
}

/** Re-applies every connected participant's permissions and host badge. */
export async function syncCallPermissions(
  rooms: LiveKitRooms,
  input: { readonly orgId: string; readonly roomId: string; readonly state: MeetControlState },
): Promise<void> {
  const { orgId, roomId, state } = input;
  for (const participant of await rooms.listParticipants(orgId, roomId)) {
    const moderator =
      state.hostActorId === participant.identity ||
      state.cohostActorIds.includes(participant.identity);
    const grants = liveKitPolicyGrants(meetJwtFeatures(state, participant.identity, moderator));
    await rooms.updateParticipant(orgId, roomId, participant.identity, {
      permission: { ...grants, canUpdateMetadata: true },
      // An empty value removes the attribute.
      attributes: { helixRole: moderator ? "host" : "" },
    });
  }
}
