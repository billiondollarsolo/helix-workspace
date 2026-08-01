import { useCallback, type ReactNode } from "react";
import { useBlocker } from "@tanstack/react-router";
import { Dialog } from "@/components/ui/helix-dialog";

export const UNSAVED_CHANGES_WARNING =
  "Your changes are safe on this device, but leaving now will discard the local draft.";

interface UnsavedChangesWarningOptions {
  readonly message?: string;
  readonly stayLabel?: string;
  readonly leaveLabel?: string;
}

/**
 * Block navigation while an editor has a local draft. In-app navigation gets
 * an accessible Helix dialog; reloads and tab closes use the router's
 * before-unload integration.
 */
export function useUnsavedChangesWarning(
  enabled: boolean,
  editorName = "editor",
  options: UnsavedChangesWarningOptions = {},
): ReactNode {
  const shouldBlockFn = useCallback(() => enabled, [enabled]);
  const blocker = useBlocker({
    shouldBlockFn,
    enableBeforeUnload: enabled,
    disabled: !enabled,
    withResolver: true,
  });

  if (blocker.status !== "blocked") {
    return null;
  }

  return (
    <Dialog
      title={`Leave ${editorName}?`}
      onClose={blocker.reset}
      footer={
        <>
          <button type="button" className="btn" onClick={blocker.reset}>
            {options.stayLabel ?? "Stay and keep editing"}
          </button>
          <button type="button" className="btn danger" onClick={blocker.proceed}>
            {options.leaveLabel ?? "Discard draft and leave"}
          </button>
        </>
      }
    >
      <p>{options.message ?? UNSAVED_CHANGES_WARNING}</p>
    </Dialog>
  );
}
