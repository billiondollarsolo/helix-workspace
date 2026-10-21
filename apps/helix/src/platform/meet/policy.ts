import type { MeetAudiencePolicy, MeetControlState } from "./types.js";

/**
 * What a participant may do in the call under the room's current controls:
 * chat, reactions, screen sharing and unmuting. Signed into the join token and
 * re-applied to connected participants when a host changes a policy.
 */
export function meetJwtFeatures(
  controls: MeetControlState,
  participantSubject: string,
  moderator: boolean,
) {
  const audienceAllows = (policy: MeetAudiencePolicy) =>
    policy === "everyone" || (policy === "hosts" && moderator);
  const canPresent =
    controls.presenterPolicy === "everyone" ||
    (controls.presenterPolicy === "hosts" && moderator) ||
    (controls.presenterPolicy === "selected" && controls.presenterSubject === participantSubject);
  return {
    "send-groupchat": audienceAllows(controls.chatPolicy),
    "send-reactions": audienceAllows(controls.reactionPolicy),
    "screen-sharing": canPresent,
    // A moderated room: only hosts may unmute.
    microphone: controls.mutePolicy !== "moderated" || moderator,
  };
}
