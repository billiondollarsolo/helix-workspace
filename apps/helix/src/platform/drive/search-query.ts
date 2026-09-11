export interface DriveSearchParsed {
  readonly text: string;
  readonly mimeContains: string | null;
  readonly nameSuffix: string | null;
  readonly ownerMe: boolean;
  readonly foldersOnly: boolean;
  readonly includeFolders: boolean;
}

const TYPE_TOKEN = /\btype:([a-z0-9.+-]+)/giu;

export function parseDriveSearchQuery(raw: string): DriveSearchParsed {
  const typeTokens = [...raw.matchAll(TYPE_TOKEN)].map((match) => match[1]?.toLowerCase() ?? "");
  const mapped = typeTokens.map((token) => mapTypeToken(token));
  const foldersOnly = mapped.some((item) => item.kind === "folder");
  const fileType = mapped.find((item) => item.kind === "file");
  const ownerMe = /\b(?:owner|from):me\b/iu.test(raw);
  const text = raw
    .replaceAll(TYPE_TOKEN, " ")
    .replace(/\b(?:owner|from):me\b/giu, " ")
    .replaceAll('"', " ")
    .replace(/\s+/gu, " ")
    .trim();
  const fileTypeFilter = fileType !== undefined;
  return {
    text,
    mimeContains: fileType?.mimeContains ?? null,
    nameSuffix: fileType?.nameSuffix ?? null,
    ownerMe,
    foldersOnly,
    includeFolders: foldersOnly || (!fileTypeFilter && text.length > 0),
  };
}

function mapTypeToken(token: string): {
  readonly kind: "folder" | "file";
  readonly mimeContains: string | null;
  readonly nameSuffix: string | null;
} {
  if (token === "folder" || token === "folders") {
    return { kind: "folder", mimeContains: null, nameSuffix: null };
  }
  if (token === "pdf") {
    return { kind: "file", mimeContains: "%pdf%", nameSuffix: "%.pdf" };
  }
  if (["image", "img", "photo", "png", "jpg", "jpeg", "gif", "webp"].includes(token)) {
    return { kind: "file", mimeContains: "image/%", nameSuffix: null };
  }
  if (["video", "mp4", "mov", "webm"].includes(token)) {
    return { kind: "file", mimeContains: "video/%", nameSuffix: null };
  }
  if (["doc", "document", "docx"].includes(token)) {
    return { kind: "file", mimeContains: "%word%", nameSuffix: "%.doc%" };
  }
  if (["sheet", "xls", "xlsx", "csv"].includes(token)) {
    return { kind: "file", mimeContains: "%sheet%", nameSuffix: "%.xls%" };
  }
  if (["md", "markdown", "txt"].includes(token)) {
    return { kind: "file", mimeContains: "text/%", nameSuffix: "%.md" };
  }
  return { kind: "file", mimeContains: `%${token}%`, nameSuffix: `%.${token}` };
}
