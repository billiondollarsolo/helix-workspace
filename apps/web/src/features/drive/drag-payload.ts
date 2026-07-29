export const HELIX_DRIVE_ITEM_DRAG_MIME = "application/x-helix-drive-item";

export interface HelixDriveItemDragPayload {
  readonly id: string;
  readonly name: string;
  readonly href: string;
  readonly mimeType?: string | undefined;
  readonly app?: string | null | undefined;
}

export function setHelixDriveItemDragData(
  dataTransfer: Pick<DataTransfer, "setData"> & {
    dropEffect?: DataTransfer["dropEffect"];
    effectAllowed?: DataTransfer["effectAllowed"];
  },
  payload: HelixDriveItemDragPayload,
): void {
  const href = absoluteHelixDragHref(payload.href);
  const serialized = JSON.stringify({ ...payload, href });
  setDragData(dataTransfer, HELIX_DRIVE_ITEM_DRAG_MIME, serialized);
  setDragData(dataTransfer, "text/uri-list", href);
  setDragData(dataTransfer, "text/plain", payload.name);
  setDragData(
    dataTransfer,
    "text/html",
    `<a href="${escapeHtmlAttribute(href)}">${escapeHtml(payload.name)}</a>`,
  );
  dataTransfer.dropEffect = "copy";
  dataTransfer.effectAllowed = "copyLink";
}

function setDragData(
  dataTransfer: Pick<DataTransfer, "setData">,
  type: string,
  value: string,
): void {
  try {
    dataTransfer.setData(type, value);
  } catch {
    // Some browser surfaces reject custom MIME types; standards-based text
    // payloads still make the drag useful.
  }
}

export function parseHelixDriveItemDragData(
  dataTransfer: Pick<DataTransfer, "getData">,
): HelixDriveItemDragPayload | null {
  let raw: string;
  try {
    raw = dataTransfer.getData(HELIX_DRIVE_ITEM_DRAG_MIME);
  } catch {
    return null;
  }
  if (raw.trim().length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const candidate = parsed as Partial<HelixDriveItemDragPayload>;
  if (
    typeof candidate.id !== "string" ||
    candidate.id.trim().length === 0 ||
    typeof candidate.name !== "string" ||
    candidate.name.trim().length === 0 ||
    typeof candidate.href !== "string" ||
    candidate.href.trim().length === 0
  ) {
    return null;
  }
  return {
    id: candidate.id.trim(),
    name: candidate.name.trim(),
    href: candidate.href.trim(),
    ...(typeof candidate.mimeType === "string" && candidate.mimeType.trim().length > 0
      ? { mimeType: candidate.mimeType.trim() }
      : {}),
    ...(typeof candidate.app === "string" && candidate.app.trim().length > 0
      ? { app: candidate.app.trim() }
      : {}),
  };
}

export function helixDriveOpenHref(objectId: string): string {
  return `/open/${encodeURIComponent(objectId)}`;
}

function absoluteHelixDragHref(href: string): string {
  if (typeof window === "undefined") {
    return href;
  }
  try {
    return new URL(href, window.location.origin).href;
  } catch {
    return href;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}
