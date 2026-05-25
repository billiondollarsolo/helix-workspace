import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, type FormEvent, useMemo, useState } from "react";
import {
  createDocsComment,
  deleteDocsComment,
  reopenDocsComment,
  resolveDocsComment,
  updateDocsComment,
  type DocsComment,
  type DocsCommentStatusFilter,
} from "./api";
import { docsCommentsQueryOptions, docsQueryKeys } from "./queries";
import {
  dispatchNativeDocumentAnchorSelection,
  nativeDocumentAnchor,
  nativeDocumentSelectionFromAnchor,
  type NativeDocumentSelectionAnchor,
} from "./native-document-anchors";

export interface NativeDocumentCommentsRailProps {
  readonly documentId: string;
  readonly formatVersion: number;
  readonly selectionAnchor?: NativeDocumentSelectionAnchor | null;
}

export function NativeDocumentCommentsRail({
  documentId,
  formatVersion,
  selectionAnchor = null,
}: NativeDocumentCommentsRailProps) {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<DocsCommentStatusFilter>("open");
  const commentsQuery = useQuery(docsCommentsQueryOptions(documentId, statusFilter));
  const [draft, setDraft] = useState("");
  const [activeReplyId, setActiveReplyId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const trimmedDraft = draft.trim();
  const mentionsText = useMemo(() => extractMentionText(trimmedDraft), [trimmedDraft]);
  const trimmedReplyDraft = replyDraft.trim();
  const trimmedEditDraft = editDraft.trim();

  const createMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (input: {
      readonly body: string;
      readonly anchor: Record<string, unknown>;
      readonly metadata: Record<string, unknown>;
      readonly replyToCommentId?: string | undefined;
    }) =>
      createDocsComment({
        docId: documentId,
        ...(input.replyToCommentId === undefined
          ? {}
          : { parentCommentId: input.replyToCommentId }),
        body: input.body,
        anchor: input.anchor,
        metadata: input.metadata,
      }),
    onSuccess: (_comment, input) => {
      if (input.replyToCommentId === undefined) {
        setDraft("");
      } else {
        setReplyDraft("");
        setActiveReplyId(null);
      }
      void queryClient.invalidateQueries({ queryKey: docsQueryKeys.comments(documentId) });
    },
  });
  const resolveMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (commentId: string) => resolveDocsComment({ commentId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: docsQueryKeys.comments(documentId) });
    },
  });
  const reopenMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (commentId: string) => reopenDocsComment({ commentId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: docsQueryKeys.comments(documentId) });
    },
  });
  const updateMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (input: { readonly commentId: string; readonly body: string }) =>
      updateDocsComment(input),
    onSuccess: () => {
      setEditingCommentId(null);
      setEditDraft("");
      void queryClient.invalidateQueries({ queryKey: docsQueryKeys.comments(documentId) });
    },
  });
  const deleteMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (commentId: string) => deleteDocsComment({ commentId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: docsQueryKeys.comments(documentId) });
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (trimmedDraft.length === 0 || createMutation.isPending) {
      return;
    }
    createMutation.mutate({
      body: trimmedDraft,
      anchor: nativeDocumentAnchor({
        documentId,
        formatVersion,
        selection: selectionAnchor,
      }),
      metadata: {
        source: "web.native-document.comments-rail",
        ...(mentionsText.length === 0 ? {} : { mentionsText }),
      },
    });
  };

  const onReply = (comment: DocsComment) => {
    if (trimmedReplyDraft.length === 0 || createMutation.isPending) {
      return;
    }
    const replyMentionsText = extractMentionText(trimmedReplyDraft);
    createMutation.mutate({
      body: trimmedReplyDraft,
      anchor: comment.anchor,
      metadata: {
        source: "web.native-document.comments-rail.reply",
        parentCommentId: comment.id,
        ...(replyMentionsText.length === 0 ? {} : { mentionsText: replyMentionsText }),
      },
      replyToCommentId: comment.id,
    });
  };

  const startEditingComment = (comment: DocsComment) => {
    setEditingCommentId(comment.id);
    setEditDraft(comment.body);
  };

  const saveCommentEdit = (comment: DocsComment) => {
    if (trimmedEditDraft.length === 0 || updateMutation.isPending) {
      return;
    }
    updateMutation.mutate({ commentId: comment.id, body: trimmedEditDraft });
  };

  const comments = commentsQuery.data ?? [];
  const commentThreads = nativeDocumentCommentThreads(comments);

  return (
    <aside
      id="native-document-comments-panel"
      style={RAIL_STYLE}
      aria-label="Document comments"
      tabIndex={-1}
    >
      <div style={RAIL_HEADER_STYLE}>
        <h2 style={RAIL_TITLE_STYLE}>Comments</h2>
        <span style={COUNT_STYLE}>{comments.length}</span>
      </div>
      <div style={FILTER_ROW_STYLE} aria-label="Comment status filter">
        {COMMENT_STATUS_FILTERS.map((status) => (
          <button
            key={status}
            type="button"
            className={statusFilter === status ? "btn primary sm" : "btn sm"}
            aria-pressed={statusFilter === status}
            onClick={() => {
              setStatusFilter(status);
            }}
          >
            {COMMENT_STATUS_LABELS[status]}
          </button>
        ))}
      </div>
      {commentsQuery.isLoading ? <p style={HELP_TEXT_STYLE}>Loading comments</p> : null}
      {commentsQuery.isError ? <p style={ERROR_TEXT_STYLE}>Could not load comments.</p> : null}
      {!commentsQuery.isLoading && !commentsQuery.isError && comments.length === 0 ? (
        <p style={HELP_TEXT_STYLE}>{COMMENT_EMPTY_LABELS[statusFilter]}</p>
      ) : null}
      {comments.length > 0 ? (
        <ol style={COMMENT_LIST_STYLE}>
          {commentThreads.map(({ comment, replies }) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              replies={replies}
              documentId={documentId}
              activeReplyId={activeReplyId}
              replyDraft={activeReplyId === comment.id ? replyDraft : ""}
              creating={createMutation.isPending}
              resolving={resolveMutation.isPending}
              reopening={reopenMutation.isPending}
              updating={updateMutation.isPending}
              deleting={deleteMutation.isPending}
              editingCommentId={editingCommentId}
              editDraft={editDraft}
              onStartReply={() => {
                setActiveReplyId((current) => (current === comment.id ? null : comment.id));
                setReplyDraft("");
              }}
              onReplyDraftChange={setReplyDraft}
              onReply={() => {
                onReply(comment);
              }}
              onResolve={() => {
                resolveMutation.mutate(comment.id);
              }}
              onReopen={() => {
                reopenMutation.mutate(comment.id);
              }}
              onStartEdit={startEditingComment}
              onEditDraftChange={setEditDraft}
              onSaveEdit={saveCommentEdit}
              onCancelEdit={() => {
                setEditingCommentId(null);
                setEditDraft("");
              }}
              onDelete={(targetComment) => {
                deleteMutation.mutate(targetComment.id);
              }}
            />
          ))}
        </ol>
      ) : null}
      <form style={COMPOSER_STYLE} onSubmit={onSubmit}>
        <label style={COMPOSER_LABEL_STYLE} htmlFor="native-document-comment">
          Add comment
        </label>
        {selectionAnchor !== null ? (
          <div style={SELECTION_NOTE_STYLE}>Selected: {selectionAnchor.text}</div>
        ) : null}
        <textarea
          id="native-document-comment"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          rows={4}
          style={TEXTAREA_STYLE}
        />
        {createMutation.isError ? <p style={ERROR_TEXT_STYLE}>Could not add comment.</p> : null}
        {resolveMutation.isError ? (
          <p style={ERROR_TEXT_STYLE}>Could not resolve comment.</p>
        ) : null}
        {reopenMutation.isError ? <p style={ERROR_TEXT_STYLE}>Could not reopen comment.</p> : null}
        {updateMutation.isError ? <p style={ERROR_TEXT_STYLE}>Could not update comment.</p> : null}
        {deleteMutation.isError ? <p style={ERROR_TEXT_STYLE}>Could not delete comment.</p> : null}
        <button
          className="btn primary sm"
          type="submit"
          disabled={trimmedDraft.length === 0 || createMutation.isPending}
        >
          {createMutation.isPending ? "Adding..." : "Add"}
        </button>
      </form>
    </aside>
  );
}

function CommentItem({
  comment,
  replies,
  documentId,
  activeReplyId,
  replyDraft,
  creating,
  resolving,
  reopening,
  updating,
  deleting,
  editingCommentId,
  editDraft,
  onStartReply,
  onReplyDraftChange,
  onReply,
  onResolve,
  onReopen,
  onStartEdit,
  onEditDraftChange,
  onSaveEdit,
  onCancelEdit,
  onDelete,
}: {
  readonly comment: DocsComment;
  readonly replies: readonly DocsComment[];
  readonly documentId: string;
  readonly activeReplyId: string | null;
  readonly replyDraft: string;
  readonly creating: boolean;
  readonly resolving: boolean;
  readonly reopening: boolean;
  readonly updating: boolean;
  readonly deleting: boolean;
  readonly editingCommentId: string | null;
  readonly editDraft: string;
  readonly onStartReply: () => void;
  readonly onReplyDraftChange: (value: string) => void;
  readonly onReply: () => void;
  readonly onResolve: () => void;
  readonly onReopen: () => void;
  readonly onStartEdit: (comment: DocsComment) => void;
  readonly onEditDraftChange: (value: string) => void;
  readonly onSaveEdit: (comment: DocsComment) => void;
  readonly onCancelEdit: () => void;
  readonly onDelete: (comment: DocsComment) => void;
}) {
  const selection = nativeDocumentSelectionFromAnchor(comment.anchor);
  const trimmedReplyDraft = replyDraft.trim();
  const isEditing = editingCommentId === comment.id;
  const trimmedEditDraft = editDraft.trim();
  return (
    <li style={COMMENT_ITEM_STYLE}>
      <div style={COMMENT_HEADER_STYLE}>
        <div style={COMMENT_META_STYLE}>{commentAuthorLabel(comment)}</div>
        <div style={COMMENT_ACTION_ROW_STYLE}>
          {selection !== null ? (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                dispatchNativeDocumentAnchorSelection({ documentId, selection });
              }}
            >
              Show
            </button>
          ) : null}
          <button type="button" className="btn sm" onClick={onStartReply}>
            Reply
          </button>
          <button type="button" className="btn sm" onClick={() => onStartEdit(comment)}>
            Edit
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={deleting}
            onClick={() => onDelete(comment)}
          >
            Delete
          </button>
          {comment.status === "open" ? (
            <button type="button" className="btn sm" disabled={resolving} onClick={onResolve}>
              Resolve
            </button>
          ) : (
            <>
              <span style={RESOLVED_STYLE}>Resolved</span>
              <button type="button" className="btn sm" disabled={reopening} onClick={onReopen}>
                Reopen
              </button>
            </>
          )}
        </div>
      </div>
      {isEditing ? (
        <form
          style={REPLY_FORM_STYLE}
          onSubmit={(event) => {
            event.preventDefault();
            onSaveEdit(comment);
          }}
        >
          <label style={COMPOSER_LABEL_STYLE} htmlFor={`native-document-edit-${comment.id}`}>
            Edit comment
          </label>
          <textarea
            id={`native-document-edit-${comment.id}`}
            value={editDraft}
            onChange={(event) => {
              onEditDraftChange(event.target.value);
            }}
            rows={3}
            style={TEXTAREA_STYLE}
          />
          <div style={COMMENT_ACTION_ROW_STYLE}>
            <button
              type="submit"
              className="btn primary sm"
              disabled={trimmedEditDraft.length === 0 || updating}
            >
              {updating ? "Saving..." : "Save"}
            </button>
            <button type="button" className="btn sm" onClick={onCancelEdit}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p style={COMMENT_BODY_STYLE}>{comment.body}</p>
      )}
      {replies.length > 0 ? (
        <ol style={REPLY_LIST_STYLE} aria-label={`Replies to ${commentAuthorLabel(comment)}`}>
          {replies.map((reply) => (
            <li key={reply.id} style={REPLY_ITEM_STYLE}>
              <div style={COMMENT_HEADER_STYLE}>
                <div style={COMMENT_META_STYLE}>{commentAuthorLabel(reply)}</div>
                <div style={COMMENT_ACTION_ROW_STYLE}>
                  <button type="button" className="btn sm" onClick={() => onStartEdit(reply)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={deleting}
                    onClick={() => onDelete(reply)}
                  >
                    Delete
                  </button>
                </div>
              </div>
              {editingCommentId === reply.id ? (
                <form
                  style={REPLY_FORM_STYLE}
                  onSubmit={(event) => {
                    event.preventDefault();
                    onSaveEdit(reply);
                  }}
                >
                  <label style={COMPOSER_LABEL_STYLE} htmlFor={`native-document-edit-${reply.id}`}>
                    Edit comment
                  </label>
                  <textarea
                    id={`native-document-edit-${reply.id}`}
                    value={editDraft}
                    onChange={(event) => {
                      onEditDraftChange(event.target.value);
                    }}
                    rows={3}
                    style={TEXTAREA_STYLE}
                  />
                  <div style={COMMENT_ACTION_ROW_STYLE}>
                    <button
                      type="submit"
                      className="btn primary sm"
                      disabled={trimmedEditDraft.length === 0 || updating}
                    >
                      {updating ? "Saving..." : "Save"}
                    </button>
                    <button type="button" className="btn sm" onClick={onCancelEdit}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <p style={COMMENT_BODY_STYLE}>{reply.body}</p>
              )}
            </li>
          ))}
        </ol>
      ) : null}
      {activeReplyId === comment.id ? (
        <form
          style={REPLY_FORM_STYLE}
          onSubmit={(event) => {
            event.preventDefault();
            onReply();
          }}
        >
          <label style={COMPOSER_LABEL_STYLE} htmlFor={`native-document-reply-${comment.id}`}>
            Reply
          </label>
          <textarea
            id={`native-document-reply-${comment.id}`}
            value={replyDraft}
            onChange={(event) => {
              onReplyDraftChange(event.target.value);
            }}
            rows={3}
            style={TEXTAREA_STYLE}
          />
          <button
            type="submit"
            className="btn primary sm"
            disabled={trimmedReplyDraft.length === 0 || creating}
          >
            {creating ? "Replying..." : "Send"}
          </button>
        </form>
      ) : null}
    </li>
  );
}

function commentAuthorLabel(comment: {
  readonly actorId: string | null;
  readonly author?: { readonly displayName?: string; readonly email?: string } | undefined;
}): string {
  return comment.author?.displayName ?? comment.author?.email ?? comment.actorId ?? "Unknown";
}

export function extractMentionText(value: string): readonly string[] {
  const mentions = new Set<string>();
  for (const match of value.matchAll(/(^|\s)@([\p{L}\p{N}](?:[\p{L}\p{N}._-]*[\p{L}\p{N}])?)/gu)) {
    const mention = match[2]?.trim();
    if (mention !== undefined && mention.length > 0) {
      mentions.add(mention);
    }
  }
  return [...mentions];
}

export interface NativeDocumentCommentThread {
  readonly comment: DocsComment;
  readonly replies: readonly DocsComment[];
}

export function nativeDocumentCommentThreads(
  comments: readonly DocsComment[],
): readonly NativeDocumentCommentThread[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const repliesByParent = new Map<string, DocsComment[]>();
  const roots: DocsComment[] = [];
  for (const comment of comments) {
    const parentCommentId = parentCommentIdFromComment(comment);
    if (parentCommentId !== null && byId.has(parentCommentId)) {
      const replies = repliesByParent.get(parentCommentId) ?? [];
      replies.push(comment);
      repliesByParent.set(parentCommentId, replies);
      continue;
    }
    roots.push(comment);
  }
  return roots.map((comment) => ({
    comment,
    replies: repliesByParent.get(comment.id) ?? [],
  }));
}

function parentCommentIdFromComment(comment: DocsComment): string | null {
  const parentCommentId = comment.parentCommentId ?? comment.metadata.parentCommentId;
  return typeof parentCommentId === "string" && parentCommentId.length > 0 ? parentCommentId : null;
}

const COMMENT_STATUS_FILTERS = ["open", "resolved", "all"] as const;
const COMMENT_STATUS_LABELS: Record<DocsCommentStatusFilter, string> = {
  open: "Open",
  resolved: "Resolved",
  all: "All",
};
const COMMENT_EMPTY_LABELS: Record<DocsCommentStatusFilter, string> = {
  open: "No open comments",
  resolved: "No resolved comments",
  all: "No comments",
};

const RAIL_STYLE = {
  display: "grid",
  gap: 12,
  padding: 14,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface)",
} satisfies CSSProperties;

const RAIL_HEADER_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
} satisfies CSSProperties;

const FILTER_ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
} satisfies CSSProperties;

const RAIL_TITLE_STYLE = {
  margin: 0,
  fontSize: "var(--text-body-sm)",
  fontWeight: 700,
  color: "var(--text-1)",
} satisfies CSSProperties;

const COUNT_STYLE = {
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const HELP_TEXT_STYLE = {
  margin: 0,
  fontSize: "var(--text-body-sm)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const ERROR_TEXT_STYLE = {
  margin: 0,
  fontSize: "var(--text-body-sm)",
  color: "var(--danger, #b91c1c)",
} satisfies CSSProperties;

const COMMENT_LIST_STYLE = {
  display: "grid",
  gap: 10,
  margin: 0,
  padding: 0,
  listStyle: "none",
} satisfies CSSProperties;

const COMMENT_ITEM_STYLE = {
  display: "grid",
  gap: 4,
  paddingBottom: 10,
  borderBottom: "1px solid var(--border)",
} satisfies CSSProperties;

const REPLY_LIST_STYLE = {
  display: "grid",
  gap: 8,
  margin: "2px 0 0 12px",
  padding: "0 0 0 10px",
  borderLeft: "2px solid var(--border)",
  listStyle: "none",
} satisfies CSSProperties;

const REPLY_ITEM_STYLE = {
  display: "grid",
  gap: 3,
} satisfies CSSProperties;

const REPLY_FORM_STYLE = {
  display: "grid",
  gap: 6,
  margin: "4px 0 0 12px",
  paddingLeft: 10,
  borderLeft: "2px solid var(--border)",
} satisfies CSSProperties;

const COMMENT_HEADER_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
} satisfies CSSProperties;

const COMMENT_ACTION_ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 6,
} satisfies CSSProperties;

const COMMENT_META_STYLE = {
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const RESOLVED_STYLE = {
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const COMMENT_BODY_STYLE = {
  margin: 0,
  fontSize: "var(--text-body-sm)",
  lineHeight: 1.45,
  color: "var(--text-2)",
  overflowWrap: "anywhere",
} satisfies CSSProperties;

const COMPOSER_STYLE = {
  display: "grid",
  gap: 8,
} satisfies CSSProperties;

const COMPOSER_LABEL_STYLE = {
  fontSize: "var(--text-caption)",
  fontWeight: 600,
  color: "var(--text-2)",
} satisfies CSSProperties;

const SELECTION_NOTE_STYLE = {
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "6px 8px",
  background: "var(--surface-2)",
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
  overflowWrap: "anywhere",
} satisfies CSSProperties;

const TEXTAREA_STYLE = {
  width: "100%",
  minHeight: 84,
  resize: "vertical",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: 10,
  background: "var(--surface-2)",
  color: "var(--text-1)",
  font: "inherit",
  lineHeight: 1.45,
} satisfies CSSProperties;
