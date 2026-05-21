import {
  Bot,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Folder,
  Inbox,
  MessageSquare,
  MoreVertical,
  Settings,
  Shield,
  Video,
  X,
} from "lucide-react";
import type { WebPlatformHost } from "@helix/sdk-web";
import { toggleRightRailOpen } from "@/components/shell-store";
import { AssistantRightRailPanel } from "@/features/assistant/assistant-right-rail-panel";

const platformPluginId = "com.helix.platform.web";

export function registerPlatformShellContributions(host: WebPlatformHost) {
  const items = [
    { id: "mail", route: "/mail", label: "Mail", icon: Inbox, order: 1, shortcut: "G M" },
    { id: "chat", route: "/chat", label: "Chat", icon: MessageSquare, order: 2, shortcut: "G C" },
    { id: "drive", route: "/drive", label: "Drive", icon: Folder, order: 3, shortcut: "G D" },
    {
      id: "calendar",
      route: "/calendar",
      label: "Calendar",
      icon: CalendarDays,
      order: 5,
      shortcut: "G A",
    },
    { id: "meet", route: "/meet", label: "Meet", icon: Video, order: 6, shortcut: "G V" },
    {
      id: "assistant",
      route: "/assistant",
      label: "Assistant",
      icon: Bot,
      order: 7,
      shortcut: "G H",
    },
    { id: "settings", route: "/settings", label: "Settings", icon: Settings, order: 900 },
    { id: "admin", route: "/admin", label: "Admin", icon: Shield, order: 950, adminOnly: true },
  ] as const;

  for (const item of items) {
    host.registerShellRoute({
      id: item.id,
      path: item.route,
      label: item.label,
      pluginId: platformPluginId,
      order: item.order,
    });
    host.registerLeftRailItem({
      ...item,
      pluginId: platformPluginId,
    });
  }

  host.registerCommandPaletteItems([
    {
      id: "theme.toggle",
      pluginId: platformPluginId,
      label: "Toggle theme",
      group: "Preferences",
      keywords: ["light", "dark", "system"],
      shortcut: "T",
      run: () => {
        document.dispatchEvent(new CustomEvent("helix:toggle-theme"));
      },
    },
    {
      id: "shell.help",
      pluginId: platformPluginId,
      label: "Open help",
      group: "Workspace",
      keywords: ["support", "docs"],
      run: () => {
        document.dispatchEvent(new CustomEvent("helix:open-help"));
      },
    },
  ]);

  host.registerRightRailPanel({
    id: "calendar.mail-glance",
    pluginId: platformPluginId,
    label: "Calendar",
    order: 0,
    appliesTo: (routePath) => routePath === "/mail",
    render: () => <MailCalendarGlancePanel />,
  });

  host.registerRightRailPanel({
    id: "assistant.context",
    pluginId: platformPluginId,
    label: "Assistant",
    order: 1,
    appliesTo: () => true,
    render: () => <AssistantRightRailPanel />,
  });
}

function MailCalendarGlancePanel() {
  return (
    <section className="mail-calendar-panel" aria-label="Calendar panel">
      <header>
        <div>
          <span>Calendar</span>
          <strong>Wed, May 20</strong>
        </div>
        <button aria-label="Open calendar in full view" type="button">
          <ExternalLink aria-hidden="true" size={18} />
        </button>
        <button
          aria-label="Close calendar panel"
          onClick={() => toggleRightRailOpen("/mail")}
          type="button"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </header>
      <div className="mail-calendar-controls">
        <button type="button">Today</button>
        <button aria-label="Previous day" type="button">
          <ChevronLeft aria-hidden="true" size={18} />
        </button>
        <button aria-label="Next day" type="button">
          <ChevronRight aria-hidden="true" size={18} />
        </button>
        <button aria-label="Calendar options" type="button">
          <MoreVertical aria-hidden="true" size={18} />
        </button>
      </div>
      <div className="mail-calendar-all-day">
        <span>Erica's birthday</span>
        <span>1 pending task</span>
      </div>
      <div className="mail-calendar-day" aria-label="Wednesday schedule">
        {[
          "6 AM",
          "7 AM",
          "8 AM",
          "9 AM",
          "10 AM",
          "11 AM",
          "12 PM",
          "1 PM",
          "2 PM",
          "3 PM",
          "4 PM",
          "5 PM",
          "6 PM",
          "7 PM",
        ].map((hour) => (
          <div className="mail-calendar-hour" key={hour}>
            <span>{hour}</span>
          </div>
        ))}
        <div className="mail-calendar-event match">
          Order match ball
          <br />
          10 - 11am
        </div>
        <div className="mail-calendar-event piano">
          4:40 piano lesson
          <br />
          4:20 - 5:20pm
        </div>
        <div className="mail-calendar-now" />
      </div>
    </section>
  );
}
