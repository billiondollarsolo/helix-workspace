export const FILTER_ACTION_REQUIRED =
  "A mail filter needs at least one action: applyLabels (one or more labels), archive: true, markRead: true, star: true, delete: true, or snoozeUntil (ISO date-time).";

/** True when the filter would change a matching message. */
export function hasFilterAction(actions: {
  readonly applyLabels?: readonly string[] | undefined;
  readonly archive?: boolean | undefined;
  readonly markRead?: boolean | undefined;
  readonly star?: boolean | undefined;
  readonly delete?: boolean | undefined;
  readonly snoozeUntil?: string | undefined;
}): boolean {
  return (
    (actions.applyLabels?.length ?? 0) > 0 ||
    actions.archive === true ||
    actions.markRead === true ||
    actions.star === true ||
    actions.delete === true ||
    actions.snoozeUntil !== undefined
  );
}
