import type { ReactNode } from "react";
import { SideSheet } from "./side-sheet";

/** A draft stays open while the person uses the surrounding workspace. */
export function FormPanel({
  title,
  children,
  footer,
  onClose,
}: {
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly onClose: () => void;
}) {
  return (
    <SideSheet
      open
      modal={false}
      className="form-panel"
      title={title}
      size="lg"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={footer}
    >
      {children}
    </SideSheet>
  );
}
