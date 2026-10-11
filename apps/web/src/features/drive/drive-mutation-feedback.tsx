/** Inline success or actionable error text for a Drive mutation. */
export function DriveMutationFeedback({
  success,
  error,
}: {
  readonly success: string | null;
  readonly error: Error | null;
}) {
  if (error !== null) {
    return (
      <div role="alert" className="type-caption [color:var(--danger)] mb-2">
        {error.message}
      </div>
    );
  }
  if (success === null) return null;
  return (
    <div role="status" className="type-caption text-muted-foreground mb-2">
      {success}
    </div>
  );
}
