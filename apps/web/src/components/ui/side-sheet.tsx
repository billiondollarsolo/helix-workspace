/* SideSheet keeps details and forms beside the workspace; modal mode is for decisions. */

import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { isValidElement, useRef, type ReactNode } from "react";

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
  /** Creation/editing panels keep the surrounding workspace usable. */
  modal?: boolean;
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
  modal = false,
}: SideSheetProps) {
  const openerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const headingTitle =
    isValidElement(title) && typeof title.type === "string" && /^h[1-6]$/u.test(title.type);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <DialogPrimitive.Portal>
        {modal ? (
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-[ui-fade-in_var(--motion-duration-base)_var(--motion-ease-enter)]" />
        ) : null}
        <DialogPrimitive.Content
          ref={panelRef}
          data-slot="side-sheet"
          onInteractOutside={modal ? undefined : (event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onOpenAutoFocus={(event) => {
            openerRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            const field = bodyRef.current?.querySelector<HTMLElement>(
              'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])',
            );
            if (field) {
              event.preventDefault();
              field.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            // Opened without a Radix Trigger, so return focus to the opener here.
            event.preventDefault();
            if (
              openerRef.current?.isConnected === true &&
              (modal ||
                document.activeElement === document.body ||
                panelRef.current?.contains(document.activeElement))
            )
              openerRef.current.focus();
          }}
          {...(description ? {} : { "aria-describedby": undefined })}
          className={cn(
            "fixed inset-y-0 right-0 z-[var(--sheet-layer,50)] flex w-full max-w-full flex-col border-l border-border bg-popover text-popover-foreground shadow-[var(--shadow-lg)] outline-none data-[state=open]:animate-[ui-sheet-in_var(--motion-duration-slow)_var(--motion-ease-enter)]",
            WIDTH[size],
            className,
          )}
        >
          <div className="flex items-start gap-2 border-b border-border px-5 py-3">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title asChild={headingTitle} className="m-0 type-h3 font-semibold">
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
          </div>
          <div
            ref={bodyRef}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4"
          >
            {children}
          </div>
          {footer ? (
            <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
