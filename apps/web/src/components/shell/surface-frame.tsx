/* SurfaceFrame — the per-surface chrome wrapper.
   Renders `.workspace` (TopBar + `.workspace-body`) with the right side-panel
   rail, mirroring the prototype's per-app `.workspace` element.

   Surface agents wrap their surface body in this:

     <SurfaceFrame title="Mail" icon={<Icons.Mail />}>
       <MailSidebar /> <ThreadList />
     </SurfaceFrame>

   The TopBar's search becomes a live input when `searchValue` +
   `onSearchChange` are passed; otherwise it opens the ⌘K palette. */

import { useState, type ReactNode } from "react";
import { TopBar } from "@/components/shell/top-bar";
import { SidePanel, SidePanelRail, type SideTool } from "@/components/shell/side-panel";
import { useQuery } from "@tanstack/react-query";
import { unreadCountQueryOptions } from "@/features/notifications/api";

export interface SurfaceFrameProps {
  /** Surface name shown in the TopBar. */
  title: string;
  /** Icon next to the title. */
  icon?: ReactNode;
  /** Search placeholder text. */
  searchPlaceholder?: string;
  /** Surface-specific TopBar action buttons. */
  actions?: ReactNode;
  /** Live search value — supply with `onSearchChange` for an operator-style
   *  search input (Mail). Omit to use the ⌘K palette trigger. */
  searchValue?: string;
  /** Live search change handler. */
  onSearchChange?: (value: string) => void;
  /** The surface body — typically a left sidebar + main pane. Rendered inside
   *  `.workspace-body`, before the side-panel rail. */
  children: ReactNode;
}

export function SurfaceFrame({
  title,
  icon,
  searchPlaceholder,
  actions,
  searchValue,
  onSearchChange,
  children,
}: SurfaceFrameProps) {
  const [sideTool, setSideTool] = useState<SideTool | null>(null);
  // Live unread count for the bell badge. Polls every 30s and refreshes when
  // notifications.mark-read / mark-all-read run (queryClient invalidation).
  const { data: unreadData } = useQuery(unreadCountQueryOptions());

  return (
    <div className="workspace">
      <TopBar
        title={title}
        icon={icon}
        searchPlaceholder={searchPlaceholder}
        actions={actions}
        notifUnread={unreadData?.count ?? 0}
        searchValue={searchValue}
        onSearchChange={onSearchChange}
      />
      <main id="main-content" className="workspace-body" aria-label={title} tabIndex={-1}>
        {children}
        <SidePanel activeTool={sideTool} onClose={() => setSideTool(null)} />
        <SidePanelRail
          activeTool={sideTool}
          onToggle={(tool) => setSideTool((current) => (current === tool ? null : tool))}
        />
      </main>
    </div>
  );
}
