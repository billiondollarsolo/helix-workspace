import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import {
  sendWelcomeActivationEvent,
  type SendWelcomeActivationEvent,
  type WelcomeActivationAction,
} from "./api";

const actions = [
  {
    id: "try_editor",
    title: "Try the editor",
    body: "Create a doc and see comments, versions, and Drive storage in context.",
    to: "/docs",
    icon: <Icons.Doc />,
  },
  {
    id: "install_integration",
    title: "Install an integration",
    body: "Review apps, identity, and workspace settings from the admin console.",
    to: "/admin",
    icon: <Icons.Grid />,
  },
  {
    id: "invite_team",
    title: "Invite your team",
    body: "Bring teammates into Mail, Calendar, Drive, Chat, and Meet.",
    to: "/chat",
    icon: <Icons.Users />,
  },
  {
    id: "view_docs",
    title: "View docs",
    body: "Open workspace documents and start organizing shared knowledge.",
    to: "/drive",
    icon: <Icons.Drive />,
  },
] satisfies ReadonlyArray<{
  readonly id: WelcomeActivationAction;
  readonly title: string;
  readonly body: string;
  readonly to: string;
  readonly icon: ReactNode;
}>;

export interface WelcomeDashboardProps {
  readonly sendEvent?: SendWelcomeActivationEvent;
}

export function WelcomeDashboard({
  sendEvent = sendWelcomeActivationEvent,
}: WelcomeDashboardProps) {
  const viewRecorded = useRef(false);

  useEffect(() => {
    if (viewRecorded.current) {
      return;
    }
    viewRecorded.current = true;
    void sendEvent({ event: "viewed" }).catch(() => undefined);
  }, [sendEvent]);

  return (
    <SurfaceFrame title="Welcome" icon={<Icons.Helix />} searchPlaceholder="Search workspace">
      <div className="welcome-surface">
        <header className="welcome-header">
          <p className="surface-kicker">Workspace ready</p>
          <h1>Welcome to Helix</h1>
          <p>Start with the surfaces that make the workspace useful on day one.</p>
        </header>

        <div className="welcome-actions">
          {actions.map((action) => (
            <Link
              key={action.id}
              className="welcome-action"
              to={action.to}
              onClick={() => {
                void sendEvent({ event: "action_clicked", action: action.id }).catch(
                  () => undefined,
                );
              }}
            >
              <span className="welcome-action-icon">{action.icon}</span>
              <span>
                <strong>{action.title}</strong>
                <small>{action.body}</small>
              </span>
              <ArrowRight aria-hidden="true" />
            </Link>
          ))}
        </div>
      </div>
    </SurfaceFrame>
  );
}
