import type { ComponentProps } from "react";

/** A button for a Radix `…Trigger asChild`, which supplies its ref and handlers. */
export function TriggerButton(props: ComponentProps<"button">) {
  return <button type="button" {...props} />;
}
