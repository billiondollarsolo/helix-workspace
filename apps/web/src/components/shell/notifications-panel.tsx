/* NotificationsPanel — cross-app notification feed.
   Wired to the notifications.* helix tools (replaces the prior static stub).
   Tabs (All / Unread); rows mark themselves read on click and navigate to
   the source app via the verb→route map below. */

import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Icons, type IconComponent } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import {
  notificationsListQuery,
  useMarkAllRead,
  useMarkRead,
  type NotificationItem,
} from "@/features/notifications/api";

type NotificationKind =
  | "mention"
  | "share"
  | "comment"
  | "calendar"
  | "dm"
  | "approval"
  | "recording"
  | "system";

const NOTIF_ICONS: Record<NotificationKind, { Icon: IconComponent; bg: string }> = {
  mention:   { Icon: Icons.Comment,  bg: "#7c3aed" },
  share:     { Icon: Icons.Drive,    bg: "#7c3aed" },
  comment:   { Icon: Icons.Comment,  bg: "#0891b2" },
  calendar:  { Icon: Icons.Calendar, bg: "#ea580c" },
  dm:        { Icon: Icons.Chat,     bg: "#db2777" },
  approval:  { Icon: Icons.Shield,   bg: "#dc2626" },
  recording: { Icon: Icons.Drive,    bg: "#dc2626" },
  system:    { Icon: Icons.Bell,     bg: "#475569" },
};

/** Map server-side verbs to the icon kind and the in-app route to open. */
function kindForVerb(verb: string): NotificationKind {
  if (verb.startsWith("meet.recording")) return "recording";
  if (verb.startsWith("meet.")) return "calendar";
  if (verb.startsWith("calendar.")) return "calendar";
  if (verb.startsWith("docs.comment") || verb.startsWith("docs.suggestion")) return "comment";
  if (verb.startsWith("docs.") || verb.startsWith("drive.")) return "share";
  if (verb.startsWith("chat.")) return "dm";
  if (verb.startsWith("mail.")) return "mention";
  if (verb.includes("approval")) return "approval";
  return "system";
}

function routeForNotification(item: NotificationItem): string | null {
  if (item.verb.startsWith("meet.")) {
    return "/meet";
  }
  if (item.verb.startsWith("calendar.")) return "/calendar";
  if (item.verb.startsWith("docs.")) return "/docs";
  if (item.verb.startsWith("drive.")) return "/drive";
  if (item.verb.startsWith("chat.")) return "/chat";
  if (item.verb.startsWith("mail.")) return "/mail";
  return null;
}

function relativeTime(iso: string): string {
  const created = new Date(iso).getTime();
  const seconds = Math.max(0, (Date.now() - created) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export interface NotificationsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function NotificationsPanel({ open, onClose }: NotificationsPanelProps) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const { data, isLoading, isError } = useQuery(notificationsListQuery(false));
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const all = data?.items ?? [];
  const items = filter === "all" ? all : all.filter((n) => n.unread);
  const unreadCount = all.filter((n) => n.unread).length;
  const tabs = [
    { id: "all" as const, label: `All (${all.length})` },
    { id: "unread" as const, label: `Unread (${unreadCount})` },
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
        <span style={{ fontSize: "var(--text-body)", fontWeight: 600 }}>Notifications</span>
        <button
          type="button"
          className="btn sm"
          style={{ marginLeft: "auto", marginRight: 4 }}
          disabled={unreadCount === 0 || markAllRead.isPending}
          onClick={() => markAllRead.mutate()}
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
            style={{ height: 32, fontSize: "var(--text-meta)" }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div style={{ overflowY: "auto", flex: 1 }}>
        {isLoading ? (
          <div className="empty" style={{ padding: 32 }}>
            <Icons.Bell />
            <div>Loading…</div>
          </div>
        ) : isError ? (
          <div className="empty" style={{ padding: 32, color: "var(--danger)" }}>
            <Icons.Bell />
            <div>Could not load notifications.</div>
          </div>
        ) : null}
        {items.map((notification) => {
          const kind = kindForVerb(notification.verb);
          const meta = NOTIF_ICONS[kind];
          const { Icon } = meta;
          const route = routeForNotification(notification);
          return (
            <button
              key={notification.id}
              type="button"
              onClick={() => {
                if (notification.unread) {
                  markRead.mutate([notification.id]);
                }
                if (route !== null) {
                  void navigate({ to: route });
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
                <Avatar name={notification.summary} size={32} />
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
                <div style={{ fontSize: "var(--text-meta)", lineHeight: 1.45 }}>
                  <span style={{ fontWeight: 600 }}>{notification.summary}</span>
                </div>
                {notification.body ? (
                  <div
                    className="truncate"
                    style={{
                      fontSize: "var(--text-caption)",
                      color: "var(--text-3)",
                      marginTop: 4,
                      padding: "4px 8px",
                      background: "var(--surface-2)",
                      borderRadius: 4,
                      lineHeight: 1.4,
                    }}
                  >
                    {notification.body}
                  </div>
                ) : null}
                <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)", marginTop: 4 }}>
                  {relativeTime(notification.createdAt)} ago
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
        {!isLoading && !isError && items.length === 0 ? (
          <div className="empty" style={{ padding: 32 }}>
            <Icons.Bell />
            <div>You&apos;re all caught up</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
