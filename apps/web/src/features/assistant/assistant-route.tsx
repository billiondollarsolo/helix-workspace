/* `/assistant` — the Helix AI surface, or why it is unavailable. The composer
   is shown only while a model provider answers; otherwise the page says what
   to do (which setting to change for admins, whom to ask for members) instead
   of letting a chat fail. */

import { Sparkles as SparklesIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { SurfaceFrame } from "@/components/shell";
import { EmptyState } from "@/components/ui/empty-state";
import { useAdminAccess } from "@/features/admin/use-admin-access";
import { AssistantSurface } from "./assistant-surface";
import { useAssistantAvailability } from "./use-assistant-availability";

export const ASSISTANT_UNAVAILABLE_FALLBACK =
  "Helix AI is unavailable right now. Ask your administrator to set up Helix AI.";

export function AssistantRoute() {
  const assistant = useAssistantAvailability();
  const admin = useAdminAccess();

  if (assistant.available) {
    return <AssistantSurface />;
  }

  return (
    <SurfaceFrame title="Helix AI" icon={<SparklesIcon size={16} />}>
      {assistant.isLoading ? (
        <div role="status" className="flex-1">
          <span className="sr-only">Checking whether Helix AI is available…</span>
        </div>
      ) : (
        <div role="status" className="flex-1">
          <EmptyState
            icon={<SparklesIcon />}
            title="Helix AI is unavailable"
            body={assistant.message ?? ASSISTANT_UNAVAILABLE_FALLBACK}
            action={
              admin.isAdmin ? (
                <Link className="btn" to="/admin/$section" params={{ section: "assistant" }}>
                  Open Assistant settings
                </Link>
              ) : undefined
            }
          />
        </div>
      )}
    </SurfaceFrame>
  );
}
