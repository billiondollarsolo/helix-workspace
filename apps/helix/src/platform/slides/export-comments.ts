import type { DriveCommentListItem } from "../drive/types.js";

export interface SlidesExportCommentThread {
  readonly root: DriveCommentListItem;
  readonly replies: readonly DriveCommentListItem[];
  readonly slideId: string;
  readonly shapeLabel: string | null;
}

export function slidesExportCommentThreads(
  comments: readonly DriveCommentListItem[],
): readonly SlidesExportCommentThread[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const repliesByParent = new Map<string, DriveCommentListItem[]>();
  for (const comment of comments) {
    const parentCommentId = comment.parentCommentId;
    if (parentCommentId === null || !byId.has(parentCommentId)) {
      continue;
    }
    repliesByParent.set(parentCommentId, [
      ...(repliesByParent.get(parentCommentId) ?? []),
      comment,
    ]);
  }

  return comments.flatMap((root): readonly SlidesExportCommentThread[] => {
    if (root.parentCommentId !== null && byId.has(root.parentCommentId)) {
      return [];
    }
    const slideId = stringValue(root.anchor.slideId);
    if (slideId === null) {
      return [];
    }
    return [
      {
        root,
        replies: repliesByParent.get(root.id) ?? [],
        slideId,
        shapeLabel: stringValue(root.anchor.shapeLabel),
      },
    ];
  });
}

export function slidesExportCommentThreadsForSlide(
  comments: readonly DriveCommentListItem[],
  slideId: string,
): readonly SlidesExportCommentThread[] {
  return slidesExportCommentThreads(comments).filter((thread) => thread.slideId === slideId);
}

export function formatSlidesExportCommentLines(
  threads: readonly SlidesExportCommentThread[],
  input: { readonly maxLines?: number; readonly maxBodyLength?: number } = {},
): readonly string[] {
  if (threads.length === 0) {
    return [];
  }
  const maxLines = input.maxLines ?? 5;
  const maxBodyLength = input.maxBodyLength ?? 96;
  const lines = ["Review comments:"];
  for (const thread of threads) {
    lines.push(formatCommentLine(thread.root, thread.shapeLabel, maxBodyLength));
    for (const reply of thread.replies) {
      lines.push(
        `Reply: ${commentAuthorLabel(reply)}: ${truncateCommentBody(reply.body, maxBodyLength)}`,
      );
    }
  }
  return lines.slice(0, maxLines);
}

export function slidesExportCommentCountForSlide(
  comments: readonly DriveCommentListItem[],
  slideId: string,
): number {
  return slidesExportCommentThreadsForSlide(comments, slideId).reduce(
    (count, thread) => count + 1 + thread.replies.length,
    0,
  );
}

function formatCommentLine(
  comment: DriveCommentListItem,
  shapeLabel: string | null,
  maxBodyLength: number,
): string {
  const anchor = shapeLabel === null ? "" : ` (${shapeLabel})`;
  return `[${comment.status}] ${commentAuthorLabel(comment)}${anchor}: ${truncateCommentBody(
    comment.body,
    maxBodyLength,
  )}`;
}

function commentAuthorLabel(comment: DriveCommentListItem): string {
  return comment.author?.displayName ?? comment.author?.email ?? comment.actorId ?? "Unknown";
}

function truncateCommentBody(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
