export interface NativeDocumentSelectionAnchor {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

export interface NativeDocumentAnchorSelectionDetail {
  readonly documentId: string;
  readonly selection: NativeDocumentSelectionAnchor;
}

export type NativeDocumentAnchorDecorationKind = "comment" | "suggestion";

export interface NativeDocumentAnchorDecoration {
  readonly id: string;
  readonly kind: NativeDocumentAnchorDecorationKind;
  readonly selection: NativeDocumentSelectionAnchor;
}

export const NATIVE_DOCUMENT_SELECT_ANCHOR_EVENT = "helix:native-document:select-anchor";

export function nativeDocumentAnchor(input: {
  readonly documentId: string;
  readonly formatVersion: number;
  readonly selection?: NativeDocumentSelectionAnchor | null | undefined;
}): Record<string, unknown> {
  const selection =
    input.selection !== null &&
    input.selection !== undefined &&
    input.selection.text.trim().length > 0 &&
    input.selection.to > input.selection.from
      ? {
          from: input.selection.from,
          to: input.selection.to,
          text: input.selection.text,
        }
      : null;
  return {
    kind: "native-document",
    target: selection === null ? "document" : "selection",
    documentId: input.documentId,
    formatVersion: input.formatVersion,
    ...(selection === null ? {} : { selection, quote: selection.text }),
  };
}

export function nativeDocumentSelectionFromAnchor(
  anchor: Record<string, unknown>,
): NativeDocumentSelectionAnchor | null {
  if (anchor.kind !== "native-document" || anchor.target !== "selection") {
    return null;
  }
  const selection = anchor.selection;
  if (selection === null || typeof selection !== "object" || Array.isArray(selection)) {
    return null;
  }
  const rawSelection = selection as Record<string, unknown>;
  const { from, to, text } = rawSelection;
  if (
    typeof from !== "number" ||
    typeof to !== "number" ||
    typeof text !== "string" ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    to <= from ||
    text.trim().length === 0
  ) {
    return null;
  }
  return { from, to, text };
}

export function dispatchNativeDocumentAnchorSelection(
  detail: NativeDocumentAnchorSelectionDetail,
): void {
  window.dispatchEvent(
    new CustomEvent<NativeDocumentAnchorSelectionDetail>(NATIVE_DOCUMENT_SELECT_ANCHOR_EVENT, {
      detail,
    }),
  );
}

export function nativeDocumentAnchorDecorationFromRecord(input: {
  readonly id: string;
  readonly kind: NativeDocumentAnchorDecorationKind;
  readonly anchor: Record<string, unknown>;
}): NativeDocumentAnchorDecoration | null {
  const selection = nativeDocumentSelectionFromAnchor(input.anchor);
  return selection === null ? null : { id: input.id, kind: input.kind, selection };
}
