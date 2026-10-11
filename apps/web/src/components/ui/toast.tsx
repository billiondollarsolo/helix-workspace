/* Toast — short confirmations in the bottom-left corner, with an optional
   action such as Undo.

   `AppToaster` is the single mounted sonner Toaster (main.tsx); `notify()`
   is how features talk to it. The toaster region is a labelled live region,
   so messages are announced without moving focus, and Alt+T jumps to it.

   const id = notify({
     message: "Conversation archived",
     action: { label: "Undo", onAction: () => unarchive(threadId) },
     onClose: (reason) => { if (reason !== "action") commitArchive(); },
   }); */

import { toast, Toaster } from "sonner";

import { useResolvedTheme } from "@/components/settings-store";

type NotifyTone = "default" | "success" | "error";

/** Why a toast went away: its action ran, its timer ran out, or it was closed. */
export type NotifyCloseReason = "action" | "timeout" | "dismissed";

export interface NotifyOptions {
  /** One short sentence, e.g. "Conversation archived". */
  message: string;
  /** Optional second line. */
  description?: string;
  /** Default is neutral; "error" also gets a longer default duration. */
  tone?: NotifyTone;
  /** A single inline action. Undo is the common one. */
  action?: { label: string; onAction: () => void };
  /** Milliseconds on screen. Defaults: 4s, 8s with an action, 10s for errors. */
  duration?: number;
  /** Reuse an id to replace a toast in place instead of stacking another. */
  id?: string | number;
  /** Called once when the toast closes, with the reason. */
  onClose?: (reason: NotifyCloseReason) => void;
}

const SHOW = {
  default: toast.message,
  success: toast.success,
  error: toast.error,
} as const;

function defaultDuration({ tone, action }: Pick<NotifyOptions, "tone" | "action">): number {
  if (tone === "error") return 10_000;
  return action ? 8_000 : 4_000;
}

/** Show a toast; returns its id for `dismissNotification`. */
export function notify(options: NotifyOptions): string | number {
  const { message, description, tone = "default", action, id, onClose } = options;
  let closed = false;
  const close = (reason: NotifyCloseReason) => {
    if (closed) return;
    closed = true;
    onClose?.(reason);
  };
  return SHOW[tone](message, {
    id,
    description,
    duration: options.duration ?? defaultDuration(options),
    action: action
      ? {
          label: action.label,
          onClick: () => {
            close("action");
            action.onAction();
          },
        }
      : undefined,
    onAutoClose: () => close("timeout"),
    onDismiss: () => close("dismissed"),
  });
}

/** Close a toast early, e.g. when the action it offered no longer applies. */
export function dismissNotification(id: string | number): void {
  toast.dismiss(id);
}

/** The app's one toaster: snackbar colours from the `--snackbar-*` tokens,
 *  which invert against the page in both themes. */
export function AppToaster() {
  const theme = useResolvedTheme();
  return (
    <Toaster
      theme={theme}
      position="bottom-left"
      closeButton
      visibleToasts={3}
      containerAriaLabel="Notifications"
      toastOptions={{
        closeButtonAriaLabel: "Dismiss",
        classNames: {
          toast:
            "type-body-sm rounded-[var(--radius)]! border-none! bg-[var(--snackbar-bg)]! pr-11! text-[var(--snackbar-fg)]! shadow-[var(--shadow-lg)]!",
          description: "text-[var(--snackbar-fg)]! opacity-80",
          actionButton:
            "bg-transparent! text-[var(--snackbar-accent)]! font-semibold! type-body-sm! hover:underline focus-visible:outline-2 focus-visible:outline-current",
          closeButton:
            "top-1/2! right-2! left-auto! translate-x-0! -translate-y-1/2! border-none! bg-transparent! text-[var(--snackbar-fg)]! hover:bg-[color-mix(in_srgb,var(--snackbar-fg)_12%,transparent)]!",
        },
      }}
    />
  );
}
