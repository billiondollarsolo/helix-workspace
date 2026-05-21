import type { DocsOutlineItem } from "../types.js";

export function enrichDocsOutlineFromText(text: string): readonly DocsOutlineItem[] {
  const markdownHeadings = headingsFromMarkdown(text);
  if (markdownHeadings.length > 0) {
    return markdownHeadings;
  }
  return headingsFromPlainText(text);
}

function headingsFromMarkdown(text: string): readonly DocsOutlineItem[] {
  const items: DocsOutlineItem[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line.trim());
    if (match === null) {
      continue;
    }
    const marker = match[1] ?? "#";
    const title = (match[2] ?? "").trim();
    if (title.length === 0) {
      continue;
    }
    items.push(outlineItem(items.length + 1, marker.length, title));
  }
  return items;
}

function headingsFromPlainText(text: string): readonly DocsOutlineItem[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.length <= 96)
    .filter((line) => /^[A-Z0-9][\w\s:,-]+$/u.test(line))
    .slice(0, 12)
    .map((title, index) => outlineItem(index + 1, 1, title));
}

function outlineItem(index: number, level: number, title: string): DocsOutlineItem {
  return {
    id: `h${String(index)}`,
    level,
    title,
    anchor: slug(title),
  };
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "") || "section";
}
