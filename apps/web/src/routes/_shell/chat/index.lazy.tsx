import { createLazyFileRoute } from "@tanstack/react-router";
import { CoreAppGate } from "@/components/core-app-gate";
import { ChatShell } from "@/features/chat/chat-shell";

export const Route = createLazyFileRoute("/_shell/chat/")({
  component: ChatRoute,
});

function ChatRoute() {
  const { message, room } = Route.useSearch();

  return (
    <CoreAppGate app="chat">
      <ChatShell initialMessageId={message} initialRoomId={room} />
    </CoreAppGate>
  );
}
