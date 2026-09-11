export type DriveItemAction = "share" | "copy" | "move" | "star" | "trash" | "hide";

export interface DriveItemMenuTarget {
  readonly id: string;
  readonly name: string;
  readonly kind: "file" | "folder";
  readonly starred: boolean;
  readonly x: number;
  readonly y: number;
}

export function DriveItemMenu({
  target,
  canHide,
  onClose,
  onAction,
}: {
  readonly target: DriveItemMenuTarget | null;
  readonly canHide: boolean;
  readonly onClose: () => void;
  readonly onAction: (id: string, action: DriveItemAction) => void;
}) {
  if (target === null) return null;
  const run = (action: DriveItemAction) => {
    onAction(target.id, action);
    onClose();
  };
  return (
    <>
      <div aria-hidden="true" className="fixed inset-0 [z-index:99]" onClick={onClose} />
      <div
        role="menu"
        aria-label={`Actions for ${target.name}`}
        className="fixed [z-index:100] min-w-44 bg-card [border:1px_solid_var(--border)] rounded-lg [box-shadow:0_8px_24px_rgba(15,23,42,0.16)] p-1"
        style={{ left: target.x, top: target.y }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <MenuItem label="Share" onClick={() => run("share")} />
        {target.kind === "file" ? (
          <MenuItem label="Make a copy" onClick={() => run("copy")} />
        ) : null}
        <MenuItem label="Move to…" onClick={() => run("move")} />
        {target.kind === "file" ? (
          <MenuItem label={target.starred ? "Unstar" : "Star"} onClick={() => run("star")} />
        ) : null}
        {target.kind === "file" ? (
          <MenuItem label="Move to trash" onClick={() => run("trash")} />
        ) : null}
        {canHide ? (
          <MenuItem label="Remove from Shared with me" onClick={() => run("hide")} />
        ) : null}
      </div>
    </>
  );
}

function MenuItem({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      className="btn w-full justify-start font-normal"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function menuPointFromEvent(event: { readonly clientX: number; readonly clientY: number }): {
  readonly x: number;
  readonly y: number;
} {
  const maxX = typeof window === "undefined" ? event.clientX : Math.max(8, window.innerWidth - 200);
  const maxY =
    typeof window === "undefined" ? event.clientY : Math.max(8, window.innerHeight - 260);
  return { x: Math.min(event.clientX, maxX), y: Math.min(event.clientY, maxY) };
}
