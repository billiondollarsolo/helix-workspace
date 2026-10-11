/* `/chat?dm=<actorId>` (from a person's hovercard or the contacts panel)
   opens the direct message with that person, starting it when needed. The
   server returns the existing conversation for the same participants. */

import { notify } from "@/components/ui/toast";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { createChatRoom } from "./api";
import { chatQueryKeys } from "./queries";

export function useDirectMessageHandoff(
  peerActorId: string | undefined,
  onOpenRoom: (roomId: string) => void,
) {
  const queryClient = useQueryClient();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (peerActorId === undefined || handled.current === peerActorId) return;
    handled.current = peerActorId;
    void createChatRoom({ kind: "chat_dm", memberActorIds: [peerActorId] })
      .then(async (room) => {
        await queryClient.invalidateQueries({ queryKey: chatQueryKeys.rooms() });
        onOpenRoom(room.id);
      })
      .catch((error: unknown) => {
        notify({
          tone: "error",
          message: "Couldn’t open the direct message",
          description:
            error instanceof Error && error.message.length > 0
              ? error.message
              : "Try again from the person’s profile card.",
        });
      });
  }, [peerActorId, onOpenRoom, queryClient]);
}
