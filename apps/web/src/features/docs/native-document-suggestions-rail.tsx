import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, type FormEvent, useEffect, useRef, useState } from "react";
import { Icons } from "@/components/icons";
import {
  createDocsSuggestion,
  generateDocsSuggestionDraft,
  resolveDocsSuggestion,
  resolveDocsSuggestions,
  type DocsSuggestion,
  type DocsSuggestionSlotId,
  type DocsSuggestionStatus,
} from "./api";
import { docsQueryKeys, docsSuggestionsQueryOptions } from "./queries";
import {
  dispatchNativeDocumentAnchorSelection,
  nativeDocumentAnchor,
  nativeDocumentSelectionFromAnchor,
  type NativeDocumentSelectionAnchor,
} from "./native-document-anchors";

interface SuggestionAnalytics {
  readonly total: number;
  readonly pending: number;
  readonly stalePending: number;
  readonly oldestPendingAgeDays: number | null;
  readonly accepted: number;
  readonly rejected: number;
  readonly reviewed: number;
  readonly acceptanceRate: number | null;
  readonly manual: number;
  readonly aiAssisted: number;
  readonly anchored: number;
  readonly documentLevel: number;
  readonly selectionOverlap: number;
}

export interface NativeDocumentSuggestionsRailProps {
  readonly documentId: string;
  readonly formatVersion: number;
  readonly selectionAnchor?: NativeDocumentSelectionAnchor | null;
}

export function NativeDocumentSuggestionsRail({
  documentId,
  formatVersion,
  selectionAnchor = null,
}: NativeDocumentSuggestionsRailProps) {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<SuggestionStatusFilter>("pending");
  const suggestionsQuery = useQuery(
    docsSuggestionsQueryOptions(documentId, statusFilter === "all" ? undefined : statusFilter),
  );
  const analyticsQuery = useQuery(docsSuggestionsQueryOptions(documentId));
  const [beforeText, setBeforeText] = useState("");
  const [afterText, setAfterText] = useState("");
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiDraftMetadata, setAiDraftMetadata] = useState<Record<string, unknown> | null>(null);
  const [reason, setReason] = useState("");
  const [authorReviewKey, setAuthorReviewKey] = useState("");
  const [typeReviewKey, setTypeReviewKey] = useState<SuggestionTypeKey>("manual");
  const seededSelectionTextRef = useRef("");

  useEffect(() => {
    const nextSelectionText = selectionAnchor?.text.trim() ?? "";
    if (nextSelectionText.length === 0 || nextSelectionText === seededSelectionTextRef.current) {
      return;
    }
    setBeforeText((current) => {
      if (current.trim().length === 0 || current === seededSelectionTextRef.current) {
        seededSelectionTextRef.current = nextSelectionText;
        return nextSelectionText;
      }
      seededSelectionTextRef.current = nextSelectionText;
      return current;
    });
  }, [selectionAnchor?.text]);

  const invalidateSuggestions = () => {
    void queryClient.invalidateQueries({ queryKey: docsQueryKeys.suggestions(documentId) });
  };
  const invalidateNativeSession = () => {
    void queryClient.invalidateQueries({ queryKey: docsQueryKeys.nativeSession(documentId) });
  };

  const createMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: () =>
      createDocsSuggestion({
        docId: documentId,
        beforeText: beforeText.trim(),
        afterText: afterText.trim(),
        ...(reason.trim().length === 0 ? {} : { reason: reason.trim() }),
        anchor: nativeDocumentAnchor({
          documentId,
          formatVersion,
          selection: selectionAnchor,
        }),
        metadata: {
          source: "web.native-document.suggestions-rail",
          ...(aiDraftMetadata === null ? {} : { aiDraft: aiDraftMetadata }),
        },
      }),
    onSuccess: () => {
      setBeforeText("");
      setAfterText("");
      setAiInstruction("");
      setAiDraftMetadata(null);
      setReason("");
      seededSelectionTextRef.current = "";
      invalidateSuggestions();
    },
  });

  const resolveMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (input: {
      readonly suggestionId: string;
      readonly status: "accepted" | "rejected";
    }) => resolveDocsSuggestion(input),
    onSuccess: (suggestion) => {
      invalidateSuggestions();
      if (suggestion.status === "accepted") {
        invalidateNativeSession();
      }
    },
  });

  const bulkResolveMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: async (input: {
      readonly status: "accepted" | "rejected";
      readonly suggestions: readonly DocsSuggestion[];
    }) => {
      if (input.suggestions.length === 0) {
        return [];
      }
      const resolved = await resolveDocsSuggestions({
        docId: documentId,
        suggestionIds: input.suggestions.map((suggestion) => suggestion.id),
        status: input.status,
      });
      return [...resolved.suggestions];
    },
    onSuccess: (resolved) => {
      invalidateSuggestions();
      if (resolved.some((suggestion) => suggestion.status === "accepted")) {
        invalidateNativeSession();
      }
    },
  });

  const generateMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (slotId: DocsSuggestionSlotId) => {
      const sourceText = beforeText.trim() || selectionAnchor?.text.trim() || "";
      const instruction = aiInstruction.trim();
      return generateDocsSuggestionDraft({
        docId: documentId,
        slotId,
        selection: sourceText,
        ...(slotId === "docs.translate"
          ? { targetLanguage: instruction }
          : instruction.length === 0
            ? {}
            : { prompt: instruction }),
      });
    },
    onSuccess: (draft) => {
      setAfterText(draft.text.trim());
      setAiDraftMetadata({
        slotId: draft.slotId,
        ...draft.metadata,
      });
      setReason((current) =>
        current.trim().length === 0 ? AI_ASSIST_REASON[draft.slotId] : current,
      );
    },
  });

  const onCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      beforeText.trim().length === 0 ||
      afterText.trim().length === 0 ||
      createMutation.isPending
    ) {
      return;
    }
    createMutation.mutate();
  };

  const suggestions = suggestionsQuery.data ?? [];
  const pendingSuggestions = suggestions.filter((suggestion) => suggestion.status === "pending");
  const analyticsSuggestions = analyticsQuery.data ?? suggestions;
  const suggestionAnalyticsSummary = suggestionAnalytics(
    analyticsSuggestions,
    selectionAnchor,
    Date.now(),
  );
  const authorReviewOptions = suggestionAuthorOptions(pendingSuggestions);
  const selectedAuthorReviewKey = authorReviewOptions.some(
    (option) => option.key === authorReviewKey,
  )
    ? authorReviewKey
    : (authorReviewOptions[0]?.key ?? "");
  const authorPendingSuggestions =
    selectedAuthorReviewKey.length === 0
      ? []
      : pendingSuggestions.filter(
          (suggestion) => suggestionAuthorKey(suggestion) === selectedAuthorReviewKey,
        );
  const typeReviewOptions = suggestionTypeOptions(pendingSuggestions);
  const selectedTypeReviewKey = typeReviewOptions.some((option) => option.key === typeReviewKey)
    ? typeReviewKey
    : (typeReviewOptions[0]?.key ?? "manual");
  const typePendingSuggestions = pendingSuggestions.filter(
    (suggestion) => suggestionTypeKey(suggestion) === selectedTypeReviewKey,
  );
  const authorReviewRows = suggestionReviewRows(
    authorReviewOptions,
    pendingSuggestions,
    suggestionAuthorKey,
  );
  const typeReviewRows = suggestionReviewRows(
    typeReviewOptions,
    pendingSuggestions,
    suggestionTypeKey,
  );
  const selectionPendingSuggestions =
    selectionAnchor === null
      ? []
      : pendingSuggestions.filter((suggestion) =>
          suggestionOverlapsSelection(suggestion, selectionAnchor),
        );
  const resolvingSuggestions = resolveMutation.isPending || bulkResolveMutation.isPending;

  return (
    <aside
      id="native-document-suggestions-panel"
      style={RAIL_STYLE}
      aria-label="Document suggestions"
      tabIndex={-1}
    >
      <div style={RAIL_HEADER_STYLE}>
        <h2 style={RAIL_TITLE_STYLE}>Suggestions</h2>
        <span style={COUNT_STYLE}>{suggestions.length}</span>
      </div>
      <div style={FILTER_ROW_STYLE} aria-label="Suggestion status filter">
        {SUGGESTION_STATUS_FILTERS.map((status) => (
          <button
            key={status}
            type="button"
            className={statusFilter === status ? "btn primary sm" : "btn sm"}
            aria-pressed={statusFilter === status}
            onClick={() => {
              setStatusFilter(status);
            }}
          >
            {SUGGESTION_STATUS_LABELS[status]}
          </button>
        ))}
      </div>
      {analyticsSuggestions.length > 0 ? (
        <section style={REVIEW_DASHBOARD_STYLE} aria-label="Suggestion review dashboard">
          <h3 style={REVIEW_DASHBOARD_TITLE_STYLE}>Review dashboard</h3>
          <div style={REVIEW_DASHBOARD_ROW_STYLE}>
            <span style={REVIEW_DASHBOARD_CHIP_STYLE}>
              Pending {suggestionAnalyticsSummary.pending}
            </span>
            <span style={REVIEW_DASHBOARD_CHIP_STYLE}>
              Accepted {suggestionAnalyticsSummary.accepted}
            </span>
            <span style={REVIEW_DASHBOARD_CHIP_STYLE}>
              Rejected {suggestionAnalyticsSummary.rejected}
            </span>
          </div>
          <div style={REVIEW_DASHBOARD_ROW_STYLE} aria-label="Suggestion review analytics">
            <span style={REVIEW_DASHBOARD_CHIP_STYLE}>
              Reviewed {suggestionAnalyticsSummary.reviewed}/{suggestionAnalyticsSummary.total}
            </span>
            <span style={REVIEW_DASHBOARD_CHIP_STYLE}>
              Acceptance {formatAcceptanceRate(suggestionAnalyticsSummary.acceptanceRate)}
            </span>
            <span style={REVIEW_DASHBOARD_CHIP_STYLE}>
              AI-assisted {suggestionAnalyticsSummary.aiAssisted}
            </span>
            <span style={REVIEW_DASHBOARD_CHIP_STYLE}>
              Manual {suggestionAnalyticsSummary.manual}
            </span>
            <span style={REVIEW_DASHBOARD_CHIP_STYLE}>
              Anchored {suggestionAnalyticsSummary.anchored}
            </span>
            <span style={REVIEW_DASHBOARD_CHIP_STYLE}>
              Document-level {suggestionAnalyticsSummary.documentLevel}
            </span>
            {selectionAnchor === null ? null : (
              <span style={REVIEW_DASHBOARD_CHIP_STYLE}>
                In selection {suggestionAnalyticsSummary.selectionOverlap}
              </span>
            )}
          </div>
          <section
            style={TRACKED_CHANGE_ANALYTICS_STYLE}
            aria-label="Tracked-change analytics dashboard"
          >
            <div style={REVIEW_DASHBOARD_ROW_STYLE}>
              <span style={REVIEW_DASHBOARD_CHIP_STYLE}>
                Stale pending {suggestionAnalyticsSummary.stalePending}
              </span>
              <span style={REVIEW_DASHBOARD_CHIP_STYLE}>
                Oldest pending {formatPendingAge(suggestionAnalyticsSummary.oldestPendingAgeDays)}
              </span>
              <span style={REVIEW_DASHBOARD_CHIP_STYLE}>
                Anchor coverage{" "}
                {formatCoverage(
                  suggestionAnalyticsSummary.anchored,
                  suggestionAnalyticsSummary.total,
                )}
              </span>
              <span style={REVIEW_DASHBOARD_CHIP_STYLE}>
                AI share{" "}
                {formatCoverage(
                  suggestionAnalyticsSummary.aiAssisted,
                  suggestionAnalyticsSummary.total,
                )}
              </span>
            </div>
          </section>
          {authorReviewRows.length > 1 ? (
            <div style={REVIEW_DASHBOARD_ROW_STYLE} aria-label="Pending suggestions by author">
              {authorReviewRows.map((row) => (
                <span key={row.key} style={REVIEW_DASHBOARD_CHIP_STYLE}>
                  {row.label} {row.count}
                </span>
              ))}
            </div>
          ) : null}
          {typeReviewRows.length > 1 ? (
            <div style={REVIEW_DASHBOARD_ROW_STYLE} aria-label="Pending suggestions by type">
              {typeReviewRows.map((row) => (
                <span key={row.key} style={REVIEW_DASHBOARD_CHIP_STYLE}>
                  {row.label} {row.count}
                </span>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
      {pendingSuggestions.length > 1 ? (
        <div style={BULK_ACTION_ROW_STYLE} aria-label="Suggestion bulk actions">
          <button
            className="btn sm"
            type="button"
            disabled={resolvingSuggestions}
            onClick={() => {
              bulkResolveMutation.mutate({ status: "rejected", suggestions: pendingSuggestions });
            }}
          >
            Reject all
          </button>
          <button
            className="btn primary sm"
            type="button"
            disabled={resolvingSuggestions}
            onClick={() => {
              bulkResolveMutation.mutate({ status: "accepted", suggestions: pendingSuggestions });
            }}
          >
            Accept all
          </button>
        </div>
      ) : null}
      {authorReviewOptions.length > 1 ? (
        <div style={SCOPED_REVIEW_STYLE} aria-label="Author-scoped suggestion actions">
          <label style={SCOPED_REVIEW_LABEL_STYLE}>
            Author
            <select
              aria-label="Suggestion review author"
              value={selectedAuthorReviewKey}
              disabled={resolvingSuggestions}
              onChange={(event) => setAuthorReviewKey(event.target.value)}
              style={SCOPED_REVIEW_SELECT_STYLE}
            >
              {authorReviewOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div style={BULK_ACTION_ROW_STYLE}>
            <button
              className="btn sm"
              type="button"
              disabled={resolvingSuggestions || authorPendingSuggestions.length === 0}
              onClick={() => {
                bulkResolveMutation.mutate({
                  status: "rejected",
                  suggestions: authorPendingSuggestions,
                });
              }}
            >
              Reject author
            </button>
            <button
              className="btn primary sm"
              type="button"
              disabled={resolvingSuggestions || authorPendingSuggestions.length === 0}
              onClick={() => {
                bulkResolveMutation.mutate({
                  status: "accepted",
                  suggestions: authorPendingSuggestions,
                });
              }}
            >
              Accept author
            </button>
          </div>
        </div>
      ) : null}
      {typeReviewOptions.length > 1 ? (
        <div style={SCOPED_REVIEW_STYLE} aria-label="Type-scoped suggestion actions">
          <label style={SCOPED_REVIEW_LABEL_STYLE}>
            Type
            <select
              aria-label="Suggestion review type"
              value={selectedTypeReviewKey}
              disabled={resolvingSuggestions}
              onChange={(event) => setTypeReviewKey(event.target.value as SuggestionTypeKey)}
              style={SCOPED_REVIEW_SELECT_STYLE}
            >
              {typeReviewOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div style={BULK_ACTION_ROW_STYLE}>
            <button
              className="btn sm"
              type="button"
              disabled={resolvingSuggestions || typePendingSuggestions.length === 0}
              onClick={() => {
                bulkResolveMutation.mutate({
                  status: "rejected",
                  suggestions: typePendingSuggestions,
                });
              }}
            >
              Reject type
            </button>
            <button
              className="btn primary sm"
              type="button"
              disabled={resolvingSuggestions || typePendingSuggestions.length === 0}
              onClick={() => {
                bulkResolveMutation.mutate({
                  status: "accepted",
                  suggestions: typePendingSuggestions,
                });
              }}
            >
              Accept type
            </button>
          </div>
        </div>
      ) : null}
      {selectionPendingSuggestions.length > 0 ? (
        <div style={BULK_ACTION_ROW_STYLE} aria-label="Selected-range suggestion actions">
          <button
            className="btn sm"
            type="button"
            disabled={resolvingSuggestions}
            onClick={() => {
              bulkResolveMutation.mutate({
                status: "rejected",
                suggestions: selectionPendingSuggestions,
              });
            }}
          >
            Reject selection
          </button>
          <button
            className="btn primary sm"
            type="button"
            disabled={resolvingSuggestions}
            onClick={() => {
              bulkResolveMutation.mutate({
                status: "accepted",
                suggestions: selectionPendingSuggestions,
              });
            }}
          >
            Accept selection
          </button>
        </div>
      ) : null}
      {suggestionsQuery.isLoading ? <p style={HELP_TEXT_STYLE}>Loading suggestions</p> : null}
      {suggestionsQuery.isError ? (
        <p style={ERROR_TEXT_STYLE}>Could not load suggestions.</p>
      ) : null}
      {!suggestionsQuery.isLoading && !suggestionsQuery.isError && suggestions.length === 0 ? (
        <p style={HELP_TEXT_STYLE}>
          {statusFilter === "all"
            ? "No suggestions"
            : `No ${SUGGESTION_STATUS_EMPTY_LABELS[statusFilter]} suggestions`}
        </p>
      ) : null}
      {suggestions.length > 0 ? (
        <ol style={SUGGESTION_LIST_STYLE}>
          {suggestions.map((suggestion) => (
            <SuggestionItem
              key={suggestion.id}
              suggestion={suggestion}
              documentId={documentId}
              resolving={resolvingSuggestions}
              onResolve={(status) => {
                resolveMutation.mutate({ suggestionId: suggestion.id, status });
              }}
            />
          ))}
        </ol>
      ) : null}
      <form style={COMPOSER_STYLE} onSubmit={onCreate}>
        <label style={COMPOSER_LABEL_STYLE} htmlFor="native-document-suggestion-before">
          Replace
        </label>
        {selectionAnchor !== null ? (
          <div style={SELECTION_NOTE_STYLE}>Selected: {selectionAnchor.text}</div>
        ) : null}
        <input
          id="native-document-suggestion-before"
          value={beforeText}
          onChange={(event) => {
            setBeforeText(event.target.value);
          }}
          style={INPUT_STYLE}
        />
        <label style={COMPOSER_LABEL_STYLE} htmlFor="native-document-suggestion-after">
          With
        </label>
        <input
          id="native-document-suggestion-after"
          value={afterText}
          onChange={(event) => {
            setAfterText(event.target.value);
            setAiDraftMetadata(null);
          }}
          style={INPUT_STYLE}
        />
        <label style={COMPOSER_LABEL_STYLE} htmlFor="native-document-suggestion-ai-instruction">
          AI instruction
        </label>
        <textarea
          id="native-document-suggestion-ai-instruction"
          value={aiInstruction}
          onChange={(event) => {
            setAiInstruction(event.target.value);
          }}
          rows={2}
          style={TEXTAREA_STYLE}
        />
        <div style={AI_ACTION_ROW_STYLE} aria-label="Suggestion AI assists">
          {AI_ASSIST_SLOTS.map((slot) => {
            const disabled =
              generateMutation.isPending ||
              beforeText.trim().length === 0 ||
              (slot.id === "docs.translate" && aiInstruction.trim().length === 0);
            return (
              <button
                key={slot.id}
                className="btn sm"
                type="button"
                disabled={disabled}
                onClick={() => {
                  generateMutation.mutate(slot.id);
                }}
              >
                <Icons.Sparkles /> {generateMutation.isPending ? "Drafting..." : slot.label}
              </button>
            );
          })}
        </div>
        <label style={COMPOSER_LABEL_STYLE} htmlFor="native-document-suggestion-reason">
          Reason
        </label>
        <textarea
          id="native-document-suggestion-reason"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          rows={3}
          style={TEXTAREA_STYLE}
        />
        {createMutation.isError ? <p style={ERROR_TEXT_STYLE}>Could not add suggestion.</p> : null}
        {generateMutation.isError ? (
          <p style={ERROR_TEXT_STYLE}>Could not generate suggestion.</p>
        ) : null}
        {resolveMutation.isError ? (
          <p style={ERROR_TEXT_STYLE}>Could not resolve suggestion.</p>
        ) : null}
        {bulkResolveMutation.isError ? (
          <p style={ERROR_TEXT_STYLE}>Could not resolve pending suggestions.</p>
        ) : null}
        <button
          className="btn primary sm"
          type="submit"
          disabled={
            beforeText.trim().length === 0 ||
            afterText.trim().length === 0 ||
            createMutation.isPending
          }
        >
          {createMutation.isPending ? "Adding..." : "Suggest"}
        </button>
      </form>
    </aside>
  );
}

function SuggestionItem({
  suggestion,
  documentId,
  resolving,
  onResolve,
}: {
  readonly suggestion: DocsSuggestion;
  readonly documentId: string;
  readonly resolving: boolean;
  readonly onResolve: (status: "accepted" | "rejected") => void;
}) {
  const selection = nativeDocumentSelectionFromAnchor(suggestion.anchor);
  return (
    <li style={SUGGESTION_ITEM_STYLE}>
      <div style={DIFF_STYLE}>
        <span style={BEFORE_STYLE}>{suggestion.beforeText}</span>
        <span style={AFTER_STYLE}>{suggestion.afterText}</span>
      </div>
      {suggestion.reason.length > 0 ? <p style={REASON_STYLE}>{suggestion.reason}</p> : null}
      <div style={ACTION_ROW_STYLE}>
        {selection !== null ? (
          <button
            className="btn sm"
            type="button"
            onClick={() => {
              dispatchNativeDocumentAnchorSelection({ documentId, selection });
            }}
          >
            Show
          </button>
        ) : null}
        {suggestion.status === "pending" ? (
          <>
            <button
              className="btn sm"
              type="button"
              disabled={resolving}
              onClick={() => {
                onResolve("rejected");
              }}
            >
              Reject
            </button>
            <button
              className="btn primary sm"
              type="button"
              disabled={resolving}
              onClick={() => {
                onResolve("accepted");
              }}
            >
              Accept
            </button>
          </>
        ) : (
          <span style={STATUS_STYLE}>{SUGGESTION_STATUS_LABELS[suggestion.status]}</span>
        )}
      </div>
    </li>
  );
}

function suggestionOverlapsSelection(
  suggestion: DocsSuggestion,
  selection: NativeDocumentSelectionAnchor,
): boolean {
  const suggestionSelection = nativeDocumentSelectionFromAnchor(suggestion.anchor);
  if (suggestionSelection === null) {
    return false;
  }
  return rangesOverlap(
    suggestionSelection.from,
    suggestionSelection.to,
    selection.from,
    selection.to,
  );
}

function suggestionAnalytics(
  suggestions: readonly DocsSuggestion[],
  selection: NativeDocumentSelectionAnchor | null,
  now: number,
): SuggestionAnalytics {
  const counts = countSuggestionsByStatus(suggestions);
  let manual = 0;
  let aiAssisted = 0;
  let anchored = 0;
  let selectionOverlap = 0;
  let stalePending = 0;
  let oldestPendingAgeDays: number | null = null;

  for (const suggestion of suggestions) {
    if (suggestionTypeKey(suggestion) === "manual") {
      manual += 1;
    } else {
      aiAssisted += 1;
    }
    if (nativeDocumentSelectionFromAnchor(suggestion.anchor) !== null) {
      anchored += 1;
    }
    if (selection !== null && suggestionOverlapsSelection(suggestion, selection)) {
      selectionOverlap += 1;
    }
    if (suggestion.status === "pending") {
      const ageDays = suggestionAgeDays(suggestion, now);
      if (ageDays !== null) {
        oldestPendingAgeDays =
          oldestPendingAgeDays === null ? ageDays : Math.max(oldestPendingAgeDays, ageDays);
        if (ageDays >= STALE_SUGGESTION_DAYS) {
          stalePending += 1;
        }
      }
    }
  }

  const reviewed = counts.accepted + counts.rejected;
  return {
    total: suggestions.length,
    pending: counts.pending,
    stalePending,
    oldestPendingAgeDays,
    accepted: counts.accepted,
    rejected: counts.rejected,
    reviewed,
    acceptanceRate: reviewed === 0 ? null : counts.accepted / reviewed,
    manual,
    aiAssisted,
    anchored,
    documentLevel: suggestions.length - anchored,
    selectionOverlap,
  };
}

function suggestionAgeDays(suggestion: DocsSuggestion, now: number): number | null {
  const createdAt = new Date(suggestion.createdAt).getTime();
  if (Number.isNaN(createdAt)) {
    return null;
  }
  return Math.max(0, Math.floor((now - createdAt) / DAY_MS));
}

function rangesOverlap(firstFrom: number, firstTo: number, secondFrom: number, secondTo: number) {
  const normalizedFirstFrom = Math.min(firstFrom, firstTo);
  const normalizedFirstTo = Math.max(firstFrom, firstTo);
  const normalizedSecondFrom = Math.min(secondFrom, secondTo);
  const normalizedSecondTo = Math.max(secondFrom, secondTo);
  return normalizedFirstFrom < normalizedSecondTo && normalizedSecondFrom < normalizedFirstTo;
}

function suggestionAuthorOptions(
  suggestions: readonly DocsSuggestion[],
): readonly { readonly key: string; readonly label: string }[] {
  const labels = new Map<string, string>();
  for (const suggestion of suggestions) {
    const key = suggestionAuthorKey(suggestion);
    if (!labels.has(key)) {
      labels.set(key, suggestionAuthorLabel(suggestion));
    }
  }
  return [...labels.entries()].map(([key, label]) => ({ key, label }));
}

function suggestionAuthorKey(suggestion: DocsSuggestion): string {
  return suggestion.actorId ?? "unknown";
}

function suggestionAuthorLabel(suggestion: DocsSuggestion): string {
  return suggestion.actorId ?? "Unknown author";
}

function suggestionTypeOptions(
  suggestions: readonly DocsSuggestion[],
): readonly { readonly key: SuggestionTypeKey; readonly label: string }[] {
  const keys = new Set(suggestions.map(suggestionTypeKey));
  return SUGGESTION_TYPE_OPTIONS.filter((option) => keys.has(option.key));
}

function countSuggestionsByStatus(
  suggestions: readonly DocsSuggestion[],
): Record<DocsSuggestionStatus, number> {
  const counts: Record<DocsSuggestionStatus, number> = {
    pending: 0,
    accepted: 0,
    rejected: 0,
  };
  for (const suggestion of suggestions) {
    counts[suggestion.status] += 1;
  }
  return counts;
}

function formatAcceptanceRate(value: number | null): string {
  return value === null ? "n/a" : `${String(Math.round(value * 100))}%`;
}

function formatPendingAge(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return `${String(value)}d`;
}

function formatCoverage(value: number, total: number): string {
  if (total === 0) {
    return "n/a";
  }
  return `${String(value)}/${String(total)} (${formatAcceptanceRate(value / total)})`;
}

function suggestionReviewRows<Key extends string>(
  options: readonly { readonly key: Key; readonly label: string }[],
  suggestions: readonly DocsSuggestion[],
  keyForSuggestion: (suggestion: DocsSuggestion) => Key,
): readonly { readonly key: Key; readonly label: string; readonly count: number }[] {
  return options.map((option) => ({
    ...option,
    count: suggestions.filter((suggestion) => keyForSuggestion(suggestion) === option.key).length,
  }));
}

function suggestionTypeKey(suggestion: DocsSuggestion): SuggestionTypeKey {
  const aiDraft = suggestion.metadata.aiDraft;
  if (typeof aiDraft === "object" && aiDraft !== null && !Array.isArray(aiDraft)) {
    const slotId = (aiDraft as Record<string, unknown>).slotId;
    if (isDocsSuggestionSlotId(slotId)) {
      return slotId;
    }
  }
  return "manual";
}

function isDocsSuggestionSlotId(value: unknown): value is DocsSuggestionSlotId {
  return (
    value === "docs.smart-write" ||
    value === "docs.summarize" ||
    value === "docs.translate" ||
    value === "docs.ask-document"
  );
}

type SuggestionStatusFilter = DocsSuggestionStatus | "all";
type SuggestionTypeKey = DocsSuggestionSlotId | "manual";

const SUGGESTION_STATUS_FILTERS = ["pending", "accepted", "rejected", "all"] as const;
const SUGGESTION_STATUS_LABELS: Record<SuggestionStatusFilter, string> = {
  pending: "Pending",
  accepted: "Accepted",
  rejected: "Rejected",
  all: "All",
};
const SUGGESTION_STATUS_EMPTY_LABELS: Record<SuggestionStatusFilter, string> = {
  pending: "pending",
  accepted: "accepted",
  rejected: "rejected",
  all: "",
};
const AI_ASSIST_SLOTS = [
  { id: "docs.smart-write", label: "Smart write" },
  { id: "docs.summarize", label: "Summarize" },
  { id: "docs.translate", label: "Translate" },
] as const satisfies readonly { readonly id: DocsSuggestionSlotId; readonly label: string }[];
const SUGGESTION_TYPE_OPTIONS = [
  { key: "manual", label: "Manual" },
  { key: "docs.smart-write", label: "Smart write" },
  { key: "docs.summarize", label: "Summarize" },
  { key: "docs.translate", label: "Translate" },
  { key: "docs.ask-document", label: "Ask" },
] as const satisfies readonly { readonly key: SuggestionTypeKey; readonly label: string }[];
const AI_ASSIST_REASON: Record<DocsSuggestionSlotId, string> = {
  "docs.smart-write": "AI-assisted rewrite",
  "docs.summarize": "AI-assisted summary",
  "docs.translate": "AI-assisted translation",
  "docs.ask-document": "AI-assisted document answer",
};
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_SUGGESTION_DAYS = 7;

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

const AI_ACTION_ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
} satisfies CSSProperties;

const BULK_ACTION_ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
} satisfies CSSProperties;

const REVIEW_DASHBOARD_STYLE = {
  display: "grid",
  gap: 6,
  padding: 8,
  border: "1px solid var(--border)",
  background: "var(--surface-2)",
} satisfies CSSProperties;

const REVIEW_DASHBOARD_TITLE_STYLE = {
  margin: 0,
  color: "var(--text-2)",
  fontSize: "var(--text-caption)",
  fontWeight: 700,
} satisfies CSSProperties;

const REVIEW_DASHBOARD_ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
} satisfies CSSProperties;

const REVIEW_DASHBOARD_CHIP_STYLE = {
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text-2)",
  fontSize: "var(--text-caption)",
  padding: "2px 6px",
} satisfies CSSProperties;

const TRACKED_CHANGE_ANALYTICS_STYLE = {
  display: "grid",
  gap: 6,
} satisfies CSSProperties;

const SCOPED_REVIEW_STYLE = {
  display: "grid",
  gap: 6,
  padding: 8,
  border: "1px solid var(--border)",
  background: "var(--surface-2)",
} satisfies CSSProperties;

const SCOPED_REVIEW_LABEL_STYLE = {
  display: "grid",
  gap: 4,
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const SCOPED_REVIEW_SELECT_STYLE = {
  height: 32,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  font: "inherit",
  padding: "0 8px",
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

const SUGGESTION_LIST_STYLE = {
  display: "grid",
  gap: 10,
  margin: 0,
  padding: 0,
  listStyle: "none",
} satisfies CSSProperties;

const SUGGESTION_ITEM_STYLE = {
  display: "grid",
  gap: 8,
  paddingBottom: 10,
  borderBottom: "1px solid var(--border)",
} satisfies CSSProperties;

const DIFF_STYLE = {
  display: "grid",
  gap: 4,
  fontSize: "var(--text-body-sm)",
  lineHeight: 1.4,
} satisfies CSSProperties;

const BEFORE_STYLE = {
  color: "var(--danger, #b91c1c)",
  textDecoration: "line-through",
  overflowWrap: "anywhere",
} satisfies CSSProperties;

const AFTER_STYLE = {
  color: "var(--success, #047857)",
  overflowWrap: "anywhere",
} satisfies CSSProperties;

const REASON_STYLE = {
  margin: 0,
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const STATUS_STYLE = {
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const ACTION_ROW_STYLE = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
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

const INPUT_STYLE = {
  width: "100%",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: 8,
  background: "var(--surface-2)",
  color: "var(--text-1)",
  font: "inherit",
} satisfies CSSProperties;

const TEXTAREA_STYLE = {
  ...INPUT_STYLE,
  minHeight: 72,
  resize: "vertical",
  lineHeight: 1.45,
} satisfies CSSProperties;
