import { useEnabledApps } from "./use-enabled-apps";

/** Tooltip shown on every editor-creating control while the editors alpha is off. */
export const EDITORS_ALPHA_DISABLED_TITLE =
  "Editors alpha is disabled by an admin. Import and preview files from Drive.";

export interface EditorsAlphaState {
  readonly enabled: boolean;
  readonly isLoading: boolean;
}

export function useEditorsAlpha(): EditorsAlphaState {
  const enabledApps = useEnabledApps();
  return {
    enabled: enabledApps.isEnabled("editors"),
    isLoading: enabledApps.isLoading,
  };
}

export function EditorsAlphaBadge() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        border: "1px solid var(--warning, #f59e0b)",
        borderRadius: 4,
        color: "var(--warning, #f59e0b)",
        fontSize: "var(--text-caption)",
        fontWeight: 700,
        lineHeight: 1,
        padding: "3px 6px",
        textTransform: "uppercase",
      }}
    >
      Alpha
    </span>
  );
}

export function EditorsAlphaDisabledNotice({
  surface,
}: {
  readonly surface: "Docs" | "Sheets" | "Slides" | "Editors";
}) {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        marginBottom: 16,
        fontSize: "var(--text-meta)",
        color: "var(--text-2)",
        background: "var(--warning-soft)",
        borderRadius: 6,
      }}
    >
      <EditorsAlphaBadge />
      <span>
        {surface} editing is disabled. Files remain available in Drive for preview, download, and
        sharing.
      </span>
    </div>
  );
}
