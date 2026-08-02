/* Dialog — lightweight modal. Ported from the design handoff (components.jsx).
   Backdrop click and Escape both close. Focus is trapped inside the dialog.

   This is the Helix design-system dialog and is distinct from the Radix-based
   `ui/dialog.tsx`. Surface agents should import this one for handoff-faithful
   modals (Share dialog, event editor, etc.). */

import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";

export interface DialogProps {
  /** Header title. */
  title: ReactNode;
  /** Dialog body content. */
  children: ReactNode;
  /** Called on Escape, backdrop click, or any explicit close affordance. */
  onClose?: () => void;
  /** Optional footer slot (typically action buttons). */
  footer?: ReactNode;
  /** Override the default 480px width. */
  width?: number | string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ title, children, onClose, footer, width }: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    let cancelled = false;

    document.body.style.overflow = "hidden";
    queueMicrotask(() => {
      if (cancelled) {
        return;
      }
      const node = dialogRef.current;
      const focusable = node?.querySelector<HTMLElement>(FOCUSABLE);
      (focusable ?? node)?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose?.();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) {
        return;
      }
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelled = true;
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected === true) {
        previousFocus.focus();
      }
    };
  }, [onClose]);

  const style: CSSProperties | undefined = width ? { width } : undefined;

  return (
    <div
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose?.();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="dialog"
        style={style}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div id={titleId} className="dialog-header">
          {title}
        </div>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-footer">{footer}</div> : null}
      </div>
    </div>
  );
}
