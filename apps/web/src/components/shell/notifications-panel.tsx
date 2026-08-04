/* NotificationsPanel — cross-app notification feed.
   Wired to the notifications.* helix tools (replaces the prior static stub).
   Tabs (All / Unread); rows mark themselves read on click and navigate to
   the source app via the verb→route map below. */

import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Icons, type IconComponent } from "@/components/icons";
import { CORE_WORKSPACE_STORAGE_ONLY } from "@/components/apps";
import { Avatar } from "@/components/ui/avatar";
import {
  notificationsListQueryOptions,
  notificationsQueryKey,
  useMarkAllRead,
  useMarkRead,
  type NotificationItem,
} from "@/features/notifications/api";

type NotificationKind =
  "mention" | "share" | "comment" | "calendar" | "dm" | "approval" | "recording" | "system";

const NOTIF_ICONS: Record<NotificationKind, { Icon: IconComponent; bg: string }> = {
  mention: { Icon: Icons.Comment, bg: "#7c3aed" },
  share: { Icon: Icons.Drive, bg: "#7c3aed" },
  comment: { Icon: Icons.Comment, bg: "#0891b2" },
  calendar: { Icon: Icons.Calendar, bg: "#ea580c" },
  dm: { Icon: Icons.Chat, bg: "#db2777" },
  approval: { Icon: Icons.Shield, bg: "#dc2626" },
  recording: { Icon: Icons.Drive, bg: "#dc2626" },
  system: { Icon: Icons.Bell, bg: "#475569" },
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

export function notificationVisibleForBuild(
  item: Pick<NotificationItem, "verb">,
  storageOnly: boolean,
): boolean {
  if (!storageOnly) return true;
  if (item.verb.startsWith("calendar.")) return false;
  if (item.verb.startsWith("meet.") && !item.verb.startsWith("meet.recording")) return false;
  if (item.verb.startsWith("docs.")) return false;
  return true;
}

export function routeForNotification(
  item: Pick<NotificationItem, "verb">,
  storageOnly: boolean = CORE_WORKSPACE_STORAGE_ONLY,
): string | null {
  if (item.verb.startsWith("meet.")) {
    return storageOnly ? "/drive" : "/meet";
  }
  if (item.verb.startsWith("calendar.")) return storageOnly ? null : "/calendar";
  if (item.verb.startsWith("docs.")) return storageOnly ? "/drive" : "/docs";
  if (item.verb.startsWith("drive.")) return "/drive";
  if (item.verb.startsWith("chat.")) return "/chat";
  if (item.verb.startsWith("mail.")) return "/mail";
  return null;
}

interface RelativeTimeUnit {
  readonly upperBound: number;
  readonly unit: Intl.RelativeTimeFormatUnit;
  readonly divisor: number;
}

/* Ordered finest → coarsest. Anything past the last bound reads in days. */
const RELATIVE_TIME_UNITS: readonly RelativeTimeUnit[] = [
  { upperBound: 60_000, unit: "second", divisor: 1_000 },
  { upperBound: 3_600_000, unit: "minute", divisor: 60_000 },
  { upperBound: 86_400_000, unit: "hour", divisor: 3_600_000 },
];

const RELATIVE_TIME_DAYS: RelativeTimeUnit = {
  upperBound: Number.POSITIVE_INFINITY,
  unit: "day",
  divisor: 86_400_000,
};

export function formatRelativeNotificationTime(
  iso: string,
  now = Date.now(),
  locales?: Intl.LocalesArgument,
): { readonly relative: string; readonly absolute: string } {
  const created = new Date(iso);
  const createdAt = created.getTime();
  if (!Number.isFinite(createdAt)) {
    return { relative: "Unknown time", absolute: "Unknown time" };
  }
  const elapsed = createdAt - now;
  const absoluteElapsed = Math.abs(elapsed);
  // Coarsest unit whose threshold the elapsed time has not yet crossed.
  const { unit, divisor } =
    RELATIVE_TIME_UNITS.find((candidate) => absoluteElapsed < candidate.upperBound) ??
    RELATIVE_TIME_DAYS;
  return {
    relative: new Intl.RelativeTimeFormat(locales, { numeric: "auto" }).format(
      Math.round(elapsed / divisor),
      unit,
    ),
    absolute: new Intl.DateTimeFormat(locales, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(created),
  };
}

/** Decorative bell used by the panel's loading / error / empty states. */
function BellGlyph() {
  return (
    <span aria-hidden="true">
      <Icons.Bell />
    </span>
  );
}

export interface NotificationsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function NotificationsPanel({ open, onClose }: NotificationsPanelProps) {
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const { data, isLoading, isError, isFetching } = useQuery(notificationsListQueryOptions(false));
  const queryClient = useQueryClient();
  /* Invalidate the shared key rather than this observer's own `refetch`, so a
     recovery here also un-sticks the unread-count badge in the topbar, which
     reads a sibling key under the same root. Destructuring `refetch` also hid
     this call from `helix/query-refresh-discipline`, which only matched member
     calls — the rule now catches the bare form too. */
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: notificationsQueryKey });
  };
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();

  useEffect(() => {
    if (!open) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        panelRef.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
      }
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKeyDown);
      if (previousFocus?.isConnected === true) {
        previousFocus.focus();
      }
    };
  }, [open, onClose]);

  if (!open) return null;

  const all = (data?.items ?? []).filter((item) =>
    notificationVisibleForBuild(item, CORE_WORKSPACE_STORAGE_ONLY),
  );
  const items = filter === "all" ? all : all.filter((n) => n.unread);
  const unreadCount = all.filter((n) => n.unread).length;
  const tabs = [
    { id: "all" as const, label: `All (${all.length})` },
    { id: "unread" as const, label: `Unread (${unreadCount})` },
  ];

  return (
    <div
      ref={panelRef}
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
          <span aria-hidden="true">
            <Icons.X />
          </span>
        </button>
      </div>
      <div
        role="tablist"
        aria-label="Notification filters"
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
            id={`notifications-tab-${tab.id}`}
            role="tab"
            aria-selected={filter === tab.id}
            aria-controls="notifications-results"
            onClick={() => setFilter(tab.id)}
            className={filter === tab.id ? "tab active" : "tab"}
            style={{ height: 32, fontSize: "var(--text-meta)" }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id="notifications-results"
        role="tabpanel"
        aria-labelledby={`notifications-tab-${filter}`}
        tabIndex={0}
        style={{ overflowY: "auto", flex: 1 }}
      >
        {isLoading ? (
          <div className="empty" role="status" aria-live="polite" style={{ padding: 32 }}>
            <BellGlyph />
            <div>Loading…</div>
          </div>
        ) : null}
        {!isLoading && isError ? (
          <div className="empty" role="alert" style={{ padding: 32, color: "var(--danger)" }}>
            <BellGlyph />
            <div>Could not load notifications. Check your connection and try again.</div>
            <button
              type="button"
              className="btn sm"
              disabled={isFetching}
              aria-busy={isFetching}
              onClick={retry}
            >
              {isFetching ? "Retrying…" : "Retry"}
            </button>
          </div>
        ) : null}
        {items.map((notification) => {
          const kind = kindForVerb(notification.verb);
          const meta = NOTIF_ICONS[kind];
          const { Icon } = meta;
          const route = routeForNotification(notification);
          const timestamp = formatRelativeNotificationTime(notification.createdAt);
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
              className={`notification-row${notification.unread ? " unread" : ""}`}
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
                  <span aria-hidden="true" style={{ display: "block", transform: "scale(0.55)" }}>
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
                <time
                  dateTime={notification.createdAt}
                  title={timestamp.absolute}
                  style={{
                    display: "block",
                    fontSize: "var(--text-caption)",
                    color: "var(--text-3)",
                    marginTop: 4,
                  }}
                >
                  {timestamp.relative}
                </time>
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
                  aria-hidden="true"
                />
              ) : null}
            </button>
          );
        })}
        {!isLoading && !isError && items.length === 0 ? (
          <div className="empty" style={{ padding: 32 }}>
            <BellGlyph />
            <div>You&apos;re all caught up</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
