import type { AuthFetch } from "@/lib/auth";
import { authenticatedFetch } from "@/lib/auth";

const jsonHeaders = { "content-type": "application/json" } as const;

export type WelcomeActivationAction =
  "try_editor" | "install_integration" | "invite_team" | "view_docs";

export type WelcomeActivationEvent =
  | { readonly event: "viewed" }
  | { readonly event: "action_clicked"; readonly action: WelcomeActivationAction };

export type SendWelcomeActivationEvent = (input: WelcomeActivationEvent) => Promise<void>;

export async function sendWelcomeActivationEvent(
  input: WelcomeActivationEvent,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  const response = await fetchImpl("/api/signup/welcome-event", {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Failed to record welcome activation event (${String(response.status)}).`);
  }
}
