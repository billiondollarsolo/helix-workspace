import { createFileRoute } from "@tanstack/react-router";
import { ChatShell } from "@/features/chat/chat-shell";

export const Route = createFileRoute("/_shell/chat/")({
  component: ChatRoute,
});

function ChatRoute() {
  return <ChatShell />;
}
