/* SideSheet — a panel that slides in from the right edge for details,
   filters, and settings that should not leave the current page.

   Built on Radix Dialog: role="dialog" with aria-modal, labelled by the
   title, focus trapped inside and returned to the opener on close, Escape and
   the backdrop close it, background scroll locked. Full width on phones.

   <SideSheet open={open} onOpenChange={setOpen} title="Details">…</SideSheet> */

import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SideSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Heading and accessible name. */
  title: ReactNode;
  /** Optional sentence under the title; also the accessible description. */
  description?: ReactNode;
  children: ReactNode;
  /** Sticky footer, usually Save / Cancel. */
  footer?: ReactNode;
  /** Sheet width on wider screens. */
  size?: "sm" | "md" | "lg";
  className?: string;
}

const WIDTH = { sm: "sm:w-80", md: "sm:w-[400px]", lg: "sm:w-[560px]" } as const;

export function SideSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  className,
}: SideSheetProps) {
  const openerRef = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-[ui-fade-in_var(--motion-duration-base)_var(--motion-ease-enter)]" />
        <DialogPrimitive.Content
          data-slot="side-sheet"
          onOpenAutoFocus={() => {
            openerRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            // Opened without a Radix Trigger, so return focus to the opener here.
            event.preventDefault();
            if (openerRef.current?.isConnected === true) openerRef.current.focus();
          }}
          {...(description ? {} : { "aria-describedby": undefined })}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-full max-w-full flex-col border-l border-border bg-popover text-popover-foreground shadow-[var(--shadow-lg)] outline-none data-[state=open]:animate-[ui-sheet-in_var(--motion-duration-slow)_var(--motion-ease-enter)]",
            WIDTH[size],
            className,
          )}
        >
          <header className="flex items-start gap-2 border-b border-border px-5 py-3">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="m-0 type-h3 font-semibold">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="m-0 mt-0.5 type-body-sm text-muted-foreground">
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
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
            {children}
          </div>
          {footer ? (
            <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
              {footer}
            </footer>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
