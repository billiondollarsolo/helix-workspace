import { Menu as MenuIcon } from "lucide-react";
/* SurfaceFrame — the per-surface chrome wrapper: `.workspace` with the TopBar,
   the surface body, and the side-panel rail.

     <SurfaceFrame title="Mail" icon={<MailIcon />}>
       <MailSidebar /> <ThreadList />
     </SurfaceFrame>

   The hamburger collapses the surface's `.surf-sidebar` to an icon rail on
   desktop (remembered per device) and opens it as a drawer on phones.

   Search: pass `searchValue` + `onSearchChange` (+ `onSearchSubmit` for Enter)
   for a surface-owned search such as Mail's; omit them and the top bar opens
   `/search?q=…` instead. */

import { SidePanel, SidePanelRail, type SideTool } from "@/components/shell/side-panel";
import { TopBar } from "@/components/shell/top-bar";
import { toggleNavCollapsed, useNavCollapsed } from "@/components/shell/nav-collapse";
import { useMobileLayout } from "@/components/shell/use-mobile-layout";
import { unreadCountQueryOptions } from "@/features/notifications/api";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

export interface SurfaceFrameProps {
  /** Surface name shown in the TopBar. */
  title: string;
  /** Icon next to the title. */
  icon?: ReactNode;
  /** Search placeholder text. */
  searchPlaceholder?: string;
  /** Surface-specific TopBar action buttons. */
  actions?: ReactNode;
  /** Surface-owned query — supply with `onSearchChange`. */
  searchValue?: string;
  /** Makes the top-bar search drive this surface instead of `/search`. */
  onSearchChange?: (value: string) => void;
  /** Enter in a surface-owned search. */
  onSearchSubmit?: (value: string) => void;
  /** The surface body — typically a left sidebar + main pane. Rendered inside
   *  `.workspace-body`, before the side-panel rail. */
  children: ReactNode;
  /** Where the surface is (e.g. the URL). The phone drawer closes when it changes. */
  navigationKey?: string;
}

export function SurfaceFrame({
  title,
  icon,
  searchPlaceholder,
  actions,
  searchValue,
  onSearchChange,
  onSearchSubmit,
  children,
  navigationKey = "",
}: SurfaceFrameProps) {
  // The drawer stays open only on the page it was opened from.
  const [drawerKey, setDrawerKey] = useState<string | null>(null);
  const drawerOpen = drawerKey === navigationKey;
  const [sideTool, setSideTool] = useState<SideTool | null>(null);
  const collapsed = useNavCollapsed();
  const mobile = useMobileLayout();
  // Live unread count for the bell badge. Polls every 30s and refreshes when
  // notifications.mark-read / mark-all-read run (queryClient invalidation).
  const { data: unreadData } = useQuery(unreadCountQueryOptions());

  return (
    <div className="workspace" data-navigation-open={drawerOpen}>
      <TopBar
        navigationToggle={
          <button
            type="button"
            className="icon-btn workspace-navigation-toggle"
            aria-label="Main menu"
            aria-expanded={mobile ? drawerOpen : !collapsed}
            onClick={() => {
              if (mobile) {
                setDrawerKey(drawerOpen ? null : navigationKey);
              } else {
                toggleNavCollapsed();
              }
            }}
          >
            <MenuIcon size={18} aria-hidden="true" />
          </button>
        }
        title={title}
        icon={icon}
        searchPlaceholder={searchPlaceholder}
        actions={actions}
        notifUnread={unreadData?.count ?? 0}
        searchValue={searchValue}
        onSearchChange={onSearchChange}
        onSearchSubmit={onSearchSubmit}
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
