/* Shared authentication frame; sign-in also includes the Workspace welcome panel. */

import type { ReactNode } from "react";
import { HelixLogo } from "@/components/shell/helix-logo";

export function AuthCard({
  title,
  subtitle,
  status,
  children,
  footer,
  wide = false,
  split = false,
}: {
  readonly title: string;
  readonly subtitle?: ReactNode;
  /** Replaces the logo with a state icon (success or a problem). */
  readonly status?: { readonly tone: "success" | "danger"; readonly icon: ReactNode };
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  readonly wide?: boolean;
  readonly split?: boolean;
}) {
  return (
    <main className={split ? "auth-screen auth-screen-split" : "auth-screen"}>
      {split ? (
        <aside className="auth-welcome" aria-label="Welcome to Helix Workspace">
          <div className="auth-workspace-brand">
            <HelixLogo size={52} />
            <span>
              Helix Workspace
              <small>Your team's workspace</small>
            </span>
          </div>
          <div className="auth-workspace-story">
            <h2>
              Your work,
              <br />
              <span>in one place.</span>
            </h2>
            <p>
              Mail, files, chat and meetings. Keep your team's conversations and shared work
              together.
            </p>
          </div>
          <ul className="auth-workspace-capabilities" aria-label="Workspace capabilities">
            <li>Mail and calendar</li>
            <li>Shared files</li>
            <li>Chat and meetings</li>
          </ul>
        </aside>
      ) : null}
      <div className="auth-column">
        <section
          className={wide ? "auth-panel signup-panel" : "auth-panel"}
          aria-labelledby="auth-title"
        >
          <div className="auth-brand">
            {status === undefined ? (
              split ? null : (
                <HelixLogo size={44} />
              )
            ) : (
              <div className={`auth-logo ${status.tone}`} aria-hidden="true">
                {status.icon}
              </div>
            )}
            <h1 id="auth-title" className="auth-title">
              {title}
            </h1>
            {subtitle === undefined ? null : <p className="auth-subtitle">{subtitle}</p>}
          </div>
          {children}
        </section>
        {footer === undefined ? null : <div className="auth-footer">{footer}</div>}
      </div>
    </main>
  );
}
