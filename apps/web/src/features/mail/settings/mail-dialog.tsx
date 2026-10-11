/* Modal used by the label, filter and remove dialogs. Radix Dialog gives
   aria-modal, focus trapping and focus return; it sits above the full-screen
   settings overlay so the same dialog works from Mail and from Settings. */

import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useRef, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface MailDialogProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly footer: ReactNode;
  readonly onClose: () => void;
  /** The body is a form; the footer's submit button submits it. */
  readonly onSubmit?: () => void;
  readonly size?: "sm" | "md";
  /** `alertdialog` for confirmations. */
  readonly role?: "dialog" | "alertdialog";
}

export function MailDialog({
  title,
  description,
  children,
  footer,
  onClose,
  onSubmit,
  size = "md",
  role = "dialog",
}: MailDialogProps) {
  const openerRef = useRef<HTMLElement | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit?.();
  };
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
          onOpenAutoFocus={() => {
            openerRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (openerRef.current?.isConnected === true) openerRef.current.focus();
          }}
          // Escape closes this dialog only, not the settings page underneath.
          onEscapeKeyDown={(event) => event.stopPropagation()}
          {...(description ? {} : { "aria-describedby": undefined })}
          className={cn(
            "fixed top-1/2 left-1/2 z-[400] flex max-h-[min(90dvh,760px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[var(--radius-lg)] border border-border bg-popover text-popover-foreground shadow-[var(--shadow-lg)] outline-none data-[state=open]:animate-[ui-pop-in_var(--motion-duration-fast)_var(--motion-ease-enter)]",
            size === "sm" ? "sm:w-[400px]" : "sm:w-[560px]",
          )}
        >
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit} noValidate>
            <header className="flex items-start gap-2 px-5 pt-4 pb-2">
              <div className="min-w-0 flex-1">
                <DialogPrimitive.Title className="m-0 type-h3 font-semibold">
                  {title}
                </DialogPrimitive.Title>
                {description ? (
                  <DialogPrimitive.Description className="m-0 mt-1 type-body-sm text-muted-foreground">
                    {description}
                  </DialogPrimitive.Description>
                ) : null}
              </div>
              <DialogPrimitive.Close asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Close">
                  <X aria-hidden="true" />
                </Button>
              </DialogPrimitive.Close>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-2">
              {children}
            </div>
            <footer className="flex flex-wrap items-center justify-end gap-2 px-5 pt-3 pb-4">
              {footer}
            </footer>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
