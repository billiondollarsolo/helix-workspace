/* NotificationsPanel — cross-app notification feed.
   Ported from the design handoff (overlays.jsx → NotificationsPanel).
   Tabs (All / Unread); each row navigates to the source app on click.
   Replace NOTIFICATIONS with `GET /api/notifications` + WebSocket. */

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Icons, type IconComponent } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";

type NotificationKind =
  | "mention"
  | "share"
  | "comment"
  | "calendar"
  | "dm"
  | "approval"
  | "system";

interface HelixNotification {
  id: number;
  kind: NotificationKind;
  who: string;
  what: string;
  excerpt?: string;
  time: string;
  unread: boolean;
  app?: string;
}

const NOTIFICATIONS: readonly HelixNotification[] = [
  {
    id: 1,
    kind: "mention",
    who: "Mira Okafor",
    what: "@mentioned you in Q3 Roadmap",
    excerpt: "Can you confirm the migration window by Friday?",
    time: "5m",
    unread: true,
    app: "/docs",
  },
  {
    id: 2,
    kind: "share",
    who: "Priya Anand",
    what: "shared Onboarding-mocks-v3.fig with you",
    time: "20m",
    unread: true,
    app: "/drive",
  },
  {
    id: 3,
    kind: "comment",
    who: "Jonas Reichert",
    what: "replied on Q3 Roadmap",
    excerpt: "+1 — and we should re-level the SRE role.",
    time: "1h",
    unread: true,
    app: "/docs",
  },
  {
    id: 4,
    kind: "calendar",
    who: "Calendar",
    what: "Eng standup in 10 minutes",
    time: "10m before",
    unread: false,
    app: "/calendar",
  },
  {
    id: 5,
    kind: "dm",
    who: "Rumi Tanaka",
    what: "sent you a direct message",
    excerpt: "Caroline wants to lock in 2027 pricing.",
    time: "2h",
    unread: false,
    app: "/chat",
  },
  {
    id: 6,
    kind: "approval",
    who: "Helix Admin",
    what: "Apollo.io requested high-risk OAuth scopes",
    time: "Yesterday",
    unread: false,
    app: "/admin",
  },
  {
    id: 7,
    kind: "system",
    who: "System",
    what: "Your weekly digest is ready",
    time: "Yesterday",
    unread: false,
  },
];

/** Unread notification count — exported so the shell can badge the bell. */
export const UNREAD_NOTIFICATION_COUNT = NOTIFICATIONS.filter((n) => n.unread).length;

const NOTIF_ICONS: Record<NotificationKind, { Icon: IconComponent; bg: string }> = {
  mention: { Icon: Icons.Comment, bg: "#7c3aed" },
  share: { Icon: Icons.Drive, bg: "#7c3aed" },
  comment: { Icon: Icons.Comment, bg: "#0891b2" },
  calendar: { Icon: Icons.Calendar, bg: "#ea580c" },
  dm: { Icon: Icons.Chat, bg: "#db2777" },
  approval: { Icon: Icons.Shield, bg: "#dc2626" },
  system: { Icon: Icons.Bell, bg: "#475569" },
};

export interface NotificationsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function NotificationsPanel({ open, onClose }: NotificationsPanelProps) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<"all" | "unread">("all");

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const items = NOTIFICATIONS.filter(
    (n) => filter === "all" || (filter === "unread" && n.unread),
  );
  const tabs = [
    { id: "all" as const, label: `All (${NOTIFICATIONS.length})` },
    {
      id: "unread" as const,
      label: `Unread (${NOTIFICATIONS.filter((n) => n.unread).length})`,
    },
  ];

  return (
    <div
      onClick={(event) => event.stopPropagation()}
      role="dialog"
      aria-label="Notifications"
      style={{
        position: "fixed",
        top: 8,
        right: 56,
        width: 380,
        maxHeight: "80vh",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        boxShadow: "var(--shadow-lg)",
        zIndex: 250,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "12px 14px",
          display: "flex",
          alignItems: "center",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600 }}>Notifications</span>
        <button
          type="button"
          className="btn sm"
          style={{ marginLeft: "auto", marginRight: 4 }}
        >
          Mark all read
        </button>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <Icons.X />
        </button>
      </div>
      <div
        style={{
          display: "flex",
          gap: 2,
          padding: "0 12px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setFilter(tab.id)}
            className={filter === tab.id ? "tab active" : "tab"}
            style={{ height: 32, fontSize: 12 }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div style={{ overflowY: "auto", flex: 1 }}>
        {items.map((notification) => {
          const meta = NOTIF_ICONS[notification.kind];
          const { Icon } = meta;
          return (
            <button
              key={notification.id}
              type="button"
              onClick={() => {
                if (notification.app) {
                  void navigate({ to: notification.app });
                }
                onClose();
              }}
              style={{
                display: "flex",
                gap: 10,
                padding: "10px 14px",
                width: "100%",
                textAlign: "left",
                borderBottom: "1px solid var(--border)",
                cursor: "pointer",
                background: notification.unread ? "var(--accent-soft)" : "transparent",
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = notification.unread
                  ? "var(--accent-soft)"
                  : "var(--hover)";
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = notification.unread
                  ? "var(--accent-soft)"
                  : "transparent";
              }}
            >
              <div style={{ position: "relative", flexShrink: 0 }}>
                <Avatar name={notification.who} size={32} />
                <div
                  style={{
                    position: "absolute",
                    right: -3,
                    bottom: -3,
                    width: 16,
                    height: 16,
                    borderRadius: 999,
                    background: meta.bg,
                    color: "white",
                    display: "grid",
                    placeItems: "center",
                    border: "2px solid var(--surface)",
                  }}
                >
                  <span style={{ display: "block", transform: "scale(0.55)" }}>
                    <Icon />
                  </span>
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, lineHeight: 1.45 }}>
                  <span style={{ fontWeight: 600 }}>{notification.who}</span>{" "}
                  <span style={{ color: "var(--text-2)" }}>{notification.what}</span>
                </div>
                {notification.excerpt ? (
                  <div
                    className="truncate"
                    style={{
                      fontSize: 11,
                      color: "var(--text-3)",
                      marginTop: 4,
                      padding: "4px 8px",
                      background: "var(--surface-2)",
                      borderRadius: 4,
                      lineHeight: 1.4,
                    }}
                  >
                    {notification.excerpt}
                  </div>
                ) : null}
                <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 4 }}>
                  {notification.time} ago
                </div>
              </div>
              {notification.unread ? (
                <div
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    background: "var(--accent)",
                    flexShrink: 0,
                    alignSelf: "center",
                  }}
                />
              ) : null}
            </button>
          );
        })}
        {items.length === 0 ? (
          <div className="empty" style={{ padding: 32 }}>
            <Icons.Bell />
            <div>You&apos;re all caught up</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
