export const FILTER_ACTION_REQUIRED =
  "A mail filter needs at least one action: applyLabels (one or more labels), archive: true, delete: true, or snoozeUntil (ISO date-time).";

/** True when the filter would change a matching message. */
export function hasFilterAction(actions: {
  readonly applyLabels?: readonly string[] | undefined;
  readonly archive?: boolean | undefined;
  readonly delete?: boolean | undefined;
  readonly snoozeUntil?: string | undefined;
}): boolean {
  return (
    (actions.applyLabels?.length ?? 0) > 0 ||
    actions.archive === true ||
    actions.delete === true ||
    actions.snoozeUntil !== undefined
  );
}
