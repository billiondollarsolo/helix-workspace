/* EmptyState — what a list or pane shows when there is nothing in it: a
   quiet icon, a heading, one helpful sentence, and an optional next step.

   <EmptyState
     icon={<Inbox />}
     title="No conversations here"
     body="Messages you archive will show up in All mail."
     action={<Button onClick={compose}>Compose</Button>}
   /> */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  /** Decorative icon, typically a lucide icon element. */
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  /** Primary next step, usually a Button. */
  action?: ReactNode;
  /** Heading level that fits the surrounding outline. Defaults to 2. */
  headingLevel?: 2 | 3 | 4;
  /** "inline" fits inside panels and menus. */
  size?: "page" | "inline";
  className?: string;
}

export function EmptyState({
  icon,
  title,
  body,
  action,
  headingLevel = 2,
  size = "page",
  className,
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center text-center",
        size === "page" ? "gap-3 px-6 py-16" : "gap-2 px-4 py-8",
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className={cn(
            "grid place-items-center rounded-full bg-muted text-muted-foreground",
            size === "page" ? "size-16 [&_svg]:size-8" : "size-10 [&_svg]:size-5",
          )}
        >
          {icon}
        </span>
      ) : null}
      <Heading
        className={cn(
          "m-0 font-semibold text-foreground",
          size === "page" ? "type-h3" : "type-body",
        )}
      >
        {title}
      </Heading>
      {body ? <p className="m-0 max-w-sm type-body-sm text-muted-foreground">{body}</p> : null}
      {action ? <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
