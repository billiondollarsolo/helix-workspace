import { Bell as BellIcon, X as XIcon } from "lucide-react";
/* NotificationsPanel — the cross-app notification feed behind the bell.
   Grouped by app, newest first within each group. Opening a row marks it read
   and goes to the owning app. */
import { APPS, type HelixApp } from "@/components/apps";
import { iconMap as Icons } from "@/components/icon-map";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import {
  notificationsListQueryOptions,
  notificationsQueryKey,
  useMarkAllRead,
  useMarkRead,
  type NotificationItem,
} from "@/features/notifications/api";
import { cn } from "@/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

/** The app a notification verb belongs to (`mail.received` → Mail). */
export function appForNotification(item: Pick<NotificationItem, "verb">): HelixApp | undefined {
  const prefix = item.verb.split(".")[0];
  return APPS.find((app) => app.id === prefix);
}

interface NotificationGroup {
  readonly id: string;
  readonly label: string;
  readonly app: HelixApp | undefined;
  readonly items: readonly NotificationItem[];
}

/** Groups in app order, with anything app-less last under "Helix". */
function groupNotifications(items: readonly NotificationItem[]): NotificationGroup[] {
  const groups = [...APPS, undefined].map((app) => ({
    id: app?.id ?? "other",
    label: app?.name ?? "Helix",
    app,
    items: items.filter((item) => appForNotification(item) === app),
  }));
  return groups.filter((group) => group.items.length > 0);
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

export interface NotificationsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function NotificationsPanel({ open, onClose }: NotificationsPanelProps) {
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const { data, isLoading, isError, isFetching } = useQuery({
    ...notificationsListQueryOptions(false),
    enabled: open,
  });
  const queryClient = useQueryClient();
  /* Invalidate the shared key rather than this observer's own `refetch`, so a
     recovery here also un-sticks the unread-count badge in the topbar, which
     reads a sibling key under the same root. */
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
    const onPointerDown = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !panelRef.current?.contains(target) &&
        target.closest("[data-notifications-trigger]") === null
      ) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
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
    { id: "all" as const, label: "All" },
    { id: "unread" as const, label: unreadCount > 0 ? `Unread (${unreadCount})` : "Unread" },
  ];

  const openNotification = (notification: NotificationItem) => {
    if (notification.unread) {
      markRead.mutate([notification.id]);
    }
    const app = appForNotification(notification);
    if (app !== undefined) {
      void navigate({ to: app.route });
    }
    onClose();
  };

  return (
    <div ref={panelRef} role="dialog" aria-labelledby="notifications-title" className="notif-panel">
      <div className="notif-panel-header">
        <h2 id="notifications-title" className="notif-panel-title">
          Notifications
        </h2>
        <button
          type="button"
          className="btn sm ml-auto"
          disabled={unreadCount === 0 || markAllRead.isPending}
          onClick={() => markAllRead.mutate()}
        >
          Mark all read
        </button>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <XIcon size={16} aria-hidden="true" />
        </button>
      </div>
      <div role="tablist" aria-label="Notification filters" className="notif-panel-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            id={`notifications-tab-${tab.id}`}
            role="tab"
            aria-selected={filter === tab.id}
            aria-controls="notifications-results"
            onClick={() => setFilter(tab.id)}
            className={cn(filter === tab.id ? "tab active" : "tab", "h-8")}
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
        className="notif-panel-body"
      >
        {isLoading ? (
          <Skeleton variant="row" count={4} label="Loading notifications" className="p-2" />
        ) : null}
        {!isLoading && isError ? (
          <InlineError
            variant="compact"
            className="m-3"
            message="Could not load notifications. Try again in a moment."
            onRetry={retry}
            retrying={isFetching}
          />
        ) : null}
        {groupNotifications(items).map((group) => (
          <section key={group.id} aria-labelledby={`notifications-group-${group.id}`}>
            <h3 id={`notifications-group-${group.id}`} className="notif-group-title">
              {group.label}
            </h3>
            {group.items.map((notification) => (
              <NotificationRow
                key={notification.id}
                notification={notification}
                app={group.app}
                onOpen={openNotification}
              />
            ))}
          </section>
        ))}
        {!isLoading && !isError && items.length === 0 ? (
          <EmptyState
            size="inline"
            headingLevel={3}
            icon={<BellIcon aria-hidden="true" />}
            title={filter === "unread" ? "No unread notifications" : "You’re all caught up"}
            body="New mentions, shares and invitations show up here."
          />
        ) : null}
      </div>
    </div>
  );
}

function NotificationRow({
  notification,
  app,
  onOpen,
}: {
  readonly notification: NotificationItem;
  readonly app: HelixApp | undefined;
  readonly onOpen: (notification: NotificationItem) => void;
}) {
  const Icon = app === undefined ? BellIcon : Icons[app.icon];
  const timestamp = formatRelativeNotificationTime(notification.createdAt);
  return (
    <button
      type="button"
      onClick={() => onOpen(notification)}
      className={notification.unread ? "notification-row unread" : "notification-row"}
    >
      <span className="notification-avatar">
        <Avatar name={notification.summary} size={32} />
        <span
          className="notification-app"
          style={{ background: app?.color ?? "var(--label-slate)" }}
        >
          <Icon size={10} aria-hidden="true" />
        </span>
      </span>
      <span className="notification-text">
        <span className="notification-summary">
          {notification.unread ? <span className="sr-only">Unread: </span> : null}
          {notification.summary}
        </span>
        {notification.body ? <span className="notification-body">{notification.body}</span> : null}
        <time dateTime={notification.createdAt} title={timestamp.absolute}>
          {timestamp.relative}
        </time>
      </span>
      {notification.unread ? <span className="notification-dot" aria-hidden="true" /> : null}
    </button>
  );
}
