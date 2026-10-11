import type { ComponentProps } from "react";

/** A menu trigger: `MenuTrigger asChild` supplies the open handlers, ARIA state and ref. */
export function DriveMenuButton(props: ComponentProps<"button">) {
  return <button type="button" {...props} />;
}
