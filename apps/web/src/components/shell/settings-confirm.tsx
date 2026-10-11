/* Dialogs opened from a settings section. Radix gives aria-modal, focus
   trapping and focus return; they sit above the full-screen settings
   overlay, and Escape closes only the dialog. */

import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function SettingsDialog({
  title,
  description,
  children,
  footer,
  onClose,
  role = "dialog",
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly footer: ReactNode;
  readonly onClose: () => void;
  /** `alertdialog` for confirmations. */
  readonly role?: "dialog" | "alertdialog";
}) {
  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[400] bg-black/40 data-[state=open]:animate-[ui-fade-in_var(--motion-duration-base)_var(--motion-ease-enter)]" />
        <DialogPrimitive.Content
          role={role}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          {...(description === undefined ? { "aria-describedby": undefined } : {})}
          className="fixed top-1/2 left-1/2 z-[400] flex max-h-[min(90dvh,720px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[var(--radius-lg)] border border-border bg-popover text-popover-foreground shadow-[var(--shadow-lg)] outline-none sm:w-[440px] data-[state=open]:animate-[ui-pop-in_var(--motion-duration-fast)_var(--motion-ease-enter)]"
        >
          <header className="flex items-start gap-2 px-5 pt-4 pb-2">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="m-0 type-h3 font-semibold">
                {title}
              </DialogPrimitive.Title>
              {description === undefined ? null : (
                <DialogPrimitive.Description className="m-0 mt-1 type-body-sm text-muted-foreground">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Close">
                <X aria-hidden="true" />
              </Button>
            </DialogPrimitive.Close>
          </header>
          {children === undefined ? null : (
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-2">
              {children}
            </div>
          )}
          <footer className="flex flex-wrap items-center justify-end gap-2 px-5 pt-3 pb-4">
            {footer}
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Confirm an irreversible action; the description says what happens. */
export function SettingsConfirm({
  title,
  description,
  confirmLabel,
  pending,
  onConfirm,
  onClose,
}: {
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly pending: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  return (
    <SettingsDialog
      role="alertdialog"
      title={title}
      description={description}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" disabled={pending} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn danger" disabled={pending} onClick={onConfirm}>
            {pending ? "Working…" : confirmLabel}
          </button>
        </>
      }
    />
  );
}
