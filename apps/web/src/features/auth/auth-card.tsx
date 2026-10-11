/* The centered sign-in card shared by login, invitations, email
   verification and OAuth consent: the Helix mark, a heading, a short line
   of context, then the step's content. */

import type { ReactNode } from "react";
import { HelixLogo } from "@/components/shell/helix-logo";

export function AuthCard({
  title,
  subtitle,
  status,
  children,
  footer,
  wide = false,
}: {
  readonly title: string;
  readonly subtitle?: ReactNode;
  /** Replaces the logo with a state icon (success or a problem). */
  readonly status?: { readonly tone: "success" | "danger"; readonly icon: ReactNode };
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  readonly wide?: boolean;
}) {
  return (
    <main className="auth-screen">
      <div className="auth-column">
        <section
          className={wide ? "auth-panel signup-panel" : "auth-panel"}
          aria-labelledby="auth-title"
        >
          <div className="auth-brand">
            {status === undefined ? (
              <HelixLogo size={44} />
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
