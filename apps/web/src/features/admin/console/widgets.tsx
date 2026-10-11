/* Small display and control pieces shared by every admin page: relative
 * times, copy-to-clipboard, on/off switches and the row ⋮ menu. */

import { Check, Copy, MoreVertical } from "lucide-react";
import { createContext, useContext, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger, type MenuItemProps } from "@/components/ui/menu";
import { notify } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { formatAbsoluteTime, formatRelativeTime } from "./format";

/** "3 hours ago", with the exact date and time on hover. */
export function RelativeTime({
  value,
  fallback = "—",
}: {
  readonly value: string | null | undefined;
  readonly fallback?: string;
}) {
  if (value === null || value === undefined || value.length === 0) {
    return <span className="text-[var(--text-3)]">{fallback}</span>;
  }
  const absolute = formatAbsoluteTime(value);
  return (
    <time dateTime={value} title={absolute}>
      {formatRelativeTime(value)}
    </time>
  );
}

/** Copies a value and confirms with a snackbar. */
export function CopyButton({
  value,
  label,
  children,
  className,
}: {
  readonly value: string;
  /** Accessible name, e.g. "Copy organization ID". */
  readonly label: string;
  /** Visible text; icon-only when omitted. */
  readonly children?: ReactNode;
  readonly className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        notify({ message: "Copied to clipboard", duration: 2000 });
      })
      .catch(() => {
        notify({
          message: "Couldn't copy",
          description:
            "Your browser blocked clipboard access. Select the text and copy it instead.",
          tone: "error",
        });
      });
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size={children === undefined ? "icon-xs" : "xs"}
      aria-label={children === undefined ? label : undefined}
      title={label}
      className={className}
      onClick={copy}
      onBlur={() => setCopied(false)}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {children}
    </Button>
  );
}

/** A value people rarely need, such as an ID, shown short with a copy button. */
export function CopyableId({ value, label }: { readonly value: string; readonly label: string }) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1">
      <code className="mono truncate text-[var(--text-2)] type-caption" title={value}>
        {value}
      </code>
      <CopyButton value={value} label={`Copy ${label}`} />
    </span>
  );
}

/** A bare on/off switch. Give it a visible label through `labelledBy` or an `aria-label`. */
export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  label,
  labelledBy,
  describedBy,
}: {
  readonly checked: boolean;
  readonly onCheckedChange: (next: boolean) => void;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly labelledBy?: string;
  readonly describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      data-state={checked ? "on" : "off"}
      className="admin-switch focus-ring"
      onClick={() => {
        onCheckedChange(!checked);
      }}
    >
      <span className="admin-switch-thumb" aria-hidden="true" />
    </button>
  );
}

/** One boolean setting: label, optional description, and a switch on the right. */
export function SettingToggle({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  className,
}: {
  readonly label: string;
  readonly description?: ReactNode;
  readonly checked: boolean;
  readonly onCheckedChange: (next: boolean) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("admin-setting", className)}>
      <div className="admin-setting-text">
        <span id={`${id}-label`} className="admin-setting-label">
          {label}
        </span>
        {description === undefined ? null : (
          <span id={`${id}-description`} className="admin-setting-description">
            {description}
          </span>
        )}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        labelledBy={`${id}-label`}
        describedBy={description === undefined ? undefined : `${id}-description`}
      />
    </div>
  );
}

/* A row menu runs the chosen item's action only after the menu has closed and
   focus is back on the ⋮ button, so a dialog the action opens returns focus
   there when it closes. */
const RowMenuContext = createContext<((run: () => void) => void) | null>(null);

/** An item in a `RowMenu`. Same props as `MenuItem`. */
export function RowMenuItem({
  onSelect,
  ...props
}: Omit<MenuItemProps, "onSelect"> & { readonly onSelect: () => void }) {
  const defer = useContext(RowMenuContext);
  return (
    <MenuItem
      {...props}
      onSelect={() => {
        if (defer === null) onSelect();
        else defer(onSelect);
      }}
    />
  );
}

/** The row ⋮ menu. Children are `RowMenuItem`s and separators. */
export function RowMenu({
  label,
  children,
  tabIndex,
}: {
  /** Accessible name, e.g. "Actions for Riley Chen". */
  readonly label: string;
  readonly children: ReactNode;
  /** Roving tab index from a SelectableList row. */
  readonly tabIndex?: 0 | -1;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const pending = useRef<(() => void) | null>(null);
  return (
    <RowMenuContext.Provider
      value={(run) => {
        pending.current = run;
      }}
    >
      <Menu>
        <MenuTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            tabIndex={tabIndex}
          >
            <MoreVertical aria-hidden="true" />
          </Button>
        </MenuTrigger>
        {/* The menu is portalled, but React still bubbles its clicks to the row;
            stop them so choosing an item never also opens the row. */}
        <MenuContent
          align="end"
          onClick={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
            const run = pending.current;
            pending.current = null;
            run?.();
          }}
        >
          {children}
        </MenuContent>
      </Menu>
    </RowMenuContext.Provider>
  );
}

/** A permission list kept to one line: the first few scopes, then "+N more"
 *  with the rest on hover. */
export function ScopeChips({
  scopes,
  max = 3,
}: {
  readonly scopes: readonly string[];
  readonly max?: number;
}) {
  const shown = scopes.slice(0, max);
  const rest = scopes.slice(max);
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((scope) => (
        <span key={scope} className="chip mono">
          {scope}
        </span>
      ))}
      {rest.length === 0 ? null : (
        <span className="chip" title={rest.join(", ")}>
          +{rest.length} more
        </span>
      )}
    </span>
  );
}
