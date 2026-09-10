import { cn } from "@/lib/utils";
import {
  Bell as BellIcon,
  Calendar as CalendarIcon,
  MessageCircle as ChatIcon,
  MessageSquare as CommentIcon,
  HardDrive as DriveIcon,
  Shield as ShieldIcon,
  X as XIcon,
  type LucideIcon as IconComponent,
} from "lucide-react";
/* NotificationsPanel — cross-app notification feed.
   Wired to the notifications.* helix tools (replaces the prior static stub).
   Tabs (All / Unread); rows mark themselves read on click and navigate to
   the source app via the verb→route map below. */
import { Avatar } from "@/components/ui/avatar";
import {
  notificationsListQueryOptions,
  notificationsQueryKey,
  useMarkAllRead,
  useMarkRead,
  type NotificationItem,
} from "@/features/notifications/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
type NotificationKind =
  "mention" | "share" | "comment" | "calendar" | "dm" | "approval" | "recording" | "system";
const NOTIF_ICONS: Record<
  NotificationKind,
  {
    Icon: IconComponent;
    bg: string;
  }
> = {
  mention: { Icon: CommentIcon, bg: "#7c3aed" },
  share: { Icon: DriveIcon, bg: "#7c3aed" },
  comment: { Icon: CommentIcon, bg: "#0891b2" },
  calendar: { Icon: CalendarIcon, bg: "#ea580c" },
  dm: { Icon: ChatIcon, bg: "#db2777" },
  approval: { Icon: ShieldIcon, bg: "#dc2626" },
  recording: { Icon: DriveIcon, bg: "#dc2626" },
  system: { Icon: BellIcon, bg: "#475569" },
};
/** Map server-side verbs to the icon kind and the in-app route to open. */
function kindForVerb(verb: string): NotificationKind {
  if (verb.startsWith("meet.recording")) return "recording";
  if (verb.startsWith("meet.")) return "calendar";
  if (verb.startsWith("calendar.")) return "calendar";
  if (verb.startsWith("drive.comment")) return "comment";
  if (verb.startsWith("drive.")) return "share";
  if (verb.startsWith("chat.")) return "dm";
  if (verb.startsWith("mail.")) return "mention";
  if (verb.includes("approval")) return "approval";
  return "system";
}
export function routeForNotification(item: Pick<NotificationItem, "verb">): string | null {
  if (item.verb.startsWith("meet.")) {
    return "/meet";
  }
  if (item.verb.startsWith("calendar.")) return "/calendar";
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
  { upperBound: 60000, unit: "second", divisor: 1000 },
  { upperBound: 3600000, unit: "minute", divisor: 60000 },
  { upperBound: 86400000, unit: "hour", divisor: 3600000 },
];
const RELATIVE_TIME_DAYS: RelativeTimeUnit = {
  upperBound: Number.POSITIVE_INFINITY,
  unit: "day",
  divisor: 86400000,
};
export function formatRelativeNotificationTime(
  iso: string,
  now = Date.now(),
  locales?: Intl.LocalesArgument,
): {
  readonly relative: string;
  readonly absolute: string;
} {
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
      <BellIcon size={16} />
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
  const all = data?.items ?? [];
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
      className="fixed top-2 right-14 w-95 [max-height:80vh] bg-card [border:1px_solid_var(--border)] [border-radius:10px] [box-shadow:var(--shadow-lg)] [z-index:250] flex flex-col"
    >
      <div className="[padding:12px_14px] flex items-center [border-bottom:1px_solid_var(--border)]">
        <span className="[font-size:var(--text-body)] font-semibold">Notifications</span>
        <button
          type="button"
          className="btn sm ml-auto mr-1"

          disabled={unreadCount === 0 || markAllRead.isPending}
          onClick={() => markAllRead.mutate()}
        >
          Mark all read
        </button>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <span aria-hidden="true">
            <XIcon size={16} />
          </span>
        </button>
      </div>
      <div
        role="tablist"
        aria-label="Notification filters"
        className="flex gap-0.5 [padding:0_12px] [border-bottom:1px_solid_var(--border)]"
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
            className={cn(
              filter === tab.id ? "tab active" : "tab",
              "h-8 [font-size:var(--text-meta)]",
            )}
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
        className="overflow-y-auto flex-1"
      >
        {isLoading ? (
          <div className="empty p-8" role="status" aria-live="polite">
            <BellGlyph />
            <div>Loading…</div>
          </div>
        ) : null}
        {!isLoading && isError ? (
          <div className="empty p-8 text-destructive" role="alert">
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
              <div className="relative shrink-0">
                <Avatar name={notification.summary} size={32} />
                <div
                  className="absolute [right:-3px] [bottom:-3px] w-4 h-4 [border-radius:999px] [color:white] grid [place-items:center] [border:2px_solid_var(--surface)]"
                  style={{ background: meta.bg }}
                >
                  <span aria-hidden="true" className="block [transform:scale(0.55)]">
                    <Icon />
                  </span>
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="[font-size:var(--text-meta)] [line-height:1.45]">
                  <span className="font-semibold">{notification.summary}</span>
                </div>
                {notification.body ? (
                  <div className="truncate [font-size:var(--text-caption)] text-muted-foreground mt-1 [padding:4px_8px] bg-muted rounded [line-height:1.4]">
                    {notification.body}
                  </div>
                ) : null}
                <time
                  dateTime={notification.createdAt}
                  title={timestamp.absolute}
                  className="block [font-size:var(--text-caption)] text-muted-foreground mt-1"
                >
                  {timestamp.relative}
                </time>
              </div>
              {notification.unread ? (
                <div
                  className="[width:7px] [height:7px] [border-radius:999px] [background:var(--accent)] shrink-0 [align-self:center]"
                  aria-hidden="true"
                />
              ) : null}
            </button>
          );
        })}
        {!isLoading && !isError && items.length === 0 ? (
          <div className="empty p-8">
            <BellGlyph />
            <div>You&apos;re all caught up</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
