export interface AppUnreadCounts {
  readonly mail: number;
  readonly chat: number;
}

export function UnreadBadge({ count, id }: { readonly count: number; readonly id: string }) {
  if (count <= 0) return null;
  return (
    <span className="topbar-badge app-unread-badge">
      <span aria-hidden="true">{count > 99 ? "99+" : count}</span>
      <span id={id} className="sr-only">
        {count === 1 ? "1 unread message" : `${String(count)} unread messages`}
      </span>
    </span>
  );
}
