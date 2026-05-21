import { createFileRoute } from "@tanstack/react-router";
import { assistantConversationListQueryOptions } from "@/features/assistant/queries";

export const Route = createFileRoute("/_shell/assistant/")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(assistantConversationListQueryOptions());
  },
});
