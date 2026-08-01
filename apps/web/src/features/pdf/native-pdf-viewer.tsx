import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { useWebPlatformHost } from "@helix/sdk-web";
import { degrees, PDFDocument, rgb, type Color } from "pdf-lib";
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Icons } from "@/components/icons";
import { authenticatedFetch } from "@/lib/auth";
import {
  clearPdfFormState,
  createPdfComment,
  deletePdfComment,
  getPdfFormState,
  listPdfComments,
  reopenPdfComment,
  resolvePdfComment,
  savePdfFormState,
  savePdfCopyToDrive,
  updatePdfComment,
  type PdfCommentStatus,
  type PdfDriveComment,
  type PdfFormStateFieldValue,
} from "./api";

export interface NativePdfViewerProps {
  readonly objectId: string;
  readonly routeState?: NativePdfViewRouteState;
  readonly onRouteStateChange?: (state: NativePdfViewRouteState) => void;
}

export interface NativePdfViewRouteState {
  readonly page: number;
  readonly zoom: number;
  readonly commentId: string | null;
  readonly sourceFolderId: string | null;
}

interface PdfPageThumbnail {
  readonly pageNumber: number;
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

interface PdfRenderedPage {
  readonly pageNumber: number;
  readonly zoom: number;
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly textItems: readonly PdfTextLayerItem[];
}

interface PdfPageTextIndex {
  readonly pageNumber: number;
  readonly textItems: readonly PdfTextLayerItem[];
}

interface PdfTextSearchMatch extends PdfTextLayerItem {
  readonly pageNumber: number;
}

interface PdfTextLayerItem {
  readonly id: string;
  readonly text: string;
  readonly left: number;
  readonly top: number;
  readonly width: number | null;
  readonly height: number;
}

interface PdfTextAnchorRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface PdfTextAnchor {
  readonly text: string;
  readonly rects: readonly PdfTextAnchorRect[];
}

interface PdfSelectedTextRange {
  readonly text: string;
  readonly items: readonly PdfTextLayerItem[];
}

interface PdfOutlineItem {
  readonly id: string;
  readonly title: string;
  readonly pageNumber: number;
  readonly depth: number;
  readonly zoom?: number | undefined;
}

type PdfDriveSaveStatus =
  | "idle"
  | "saving-filled"
  | "saving-redacted"
  | "saving-stamped"
  | "saving-page-copy"
  | "saved"
  | "error";
type PdfFormStateStatus =
  | "idle"
  | "restored"
  | "restored-stale"
  | "saving"
  | "saved"
  | "clearing"
  | "cleared"
  | "defaulted"
  | "error";

interface PdfJsModule {
  readonly GlobalWorkerOptions?: {
    workerSrc: string;
  };
  readonly getDocument: (source: { readonly data: Uint8Array }) => {
    readonly promise: Promise<PdfJsDocument>;
  };
}

interface PdfJsDocument {
  readonly numPages: number;
  readonly getPage: (pageNumber: number) => Promise<PdfJsPage>;
  readonly getOutline: () => Promise<readonly PdfJsOutlineSource[] | null>;
  readonly getDestination: (destination: string) => Promise<readonly unknown[] | null>;
  readonly getPageIndex: (pageRef: unknown) => Promise<number>;
  readonly destroy?: () => Promise<void> | void;
}

interface PdfJsPage {
  readonly getViewport: (options: { readonly scale: number }) => PdfJsViewport;
  readonly getTextContent: () => Promise<PdfJsTextContent>;
  readonly render: (params: {
    readonly canvasContext: CanvasRenderingContext2D;
    readonly viewport: PdfJsViewport;
  }) => {
    readonly promise: Promise<void>;
  };
}

interface PdfJsViewport {
  readonly width: number;
  readonly height: number;
}

interface PdfJsOutlineSource {
  readonly title?: string;
  readonly dest?: unknown;
  readonly items?: readonly PdfJsOutlineSource[];
}

interface PdfJsTextContent {
  readonly items: readonly PdfJsTextItemSource[];
}

interface PdfJsTextItemSource {
  readonly str?: string;
  readonly transform?: readonly number[];
  readonly width?: number;
  readonly height?: number;
}

type PdfMergePlacement = "append" | "prepend" | "after-current-page";

export function NativePdfViewer({
  objectId,
  routeState = DEFAULT_PDF_VIEW_STATE,
  onRouteStateChange,
}: NativePdfViewerProps) {
  const platformHost = useWebPlatformHost();
  const commentRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const [page, setPage] = useState(routeState.page);
  const [zoom, setZoom] = useState(routeState.zoom);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(routeState.commentId);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [renderedPage, setRenderedPage] = useState<PdfRenderedPage | null>(null);
  const [renderedPageStatus, setRenderedPageStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [textIndex, setTextIndex] = useState<readonly PdfPageTextIndex[]>([]);
  const [textIndexStatus, setTextIndexStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  const [thumbnails, setThumbnails] = useState<readonly PdfPageThumbnail[]>([]);
  const [pageOrder, setPageOrder] = useState<readonly number[]>([]);
  const [draggedPageNumber, setDraggedPageNumber] = useState<number | null>(null);
  const [outline, setOutline] = useState<readonly PdfOutlineItem[]>([]);
  const [navigationStatus, setNavigationStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  const [fields, setFields] = useState<readonly PdfFieldDraft[]>([]);
  const [comments, setComments] = useState<readonly PdfDriveComment[]>([]);
  const [commentsStatus, setCommentsStatus] = useState<"loading" | "ready" | "error">("loading");
  const [commentStatusFilter, setCommentStatusFilter] = useState<PdfCommentStatus>(
    routeState.commentId === null ? "open" : "all",
  );
  const saveTargetFolderId = routeState.sourceFolderId ?? null;
  const [textSearchQuery, setTextSearchQuery] = useState("");
  const [activeTextMatchIndex, setActiveTextMatchIndex] = useState(0);
  const [textSelectionMode, setTextSelectionMode] = useState(false);
  const [textSelectionStartId, setTextSelectionStartId] = useState<string | null>(null);
  const [textSelectionEndId, setTextSelectionEndId] = useState<string | null>(null);
  const [textSelectionCopyStatus, setTextSelectionCopyStatus] = useState<
    "idle" | "copied" | "error"
  >("idle");
  const [commentDraft, setCommentDraft] = useState("");
  const [pendingCommentPoint, setPendingCommentPoint] = useState<PdfCommentPoint | null>(null);
  const [isPlacingComment, setPlacingComment] = useState(false);
  const [stampKind, setStampKind] = useState<PdfStampKind>("approved");
  const [isPlacingStamp, setPlacingStamp] = useState(false);
  const [isDrawingFreehand, setDrawingFreehand] = useState(false);
  const [freehandDraft, setFreehandDraft] = useState<readonly PdfCommentPoint[]>([]);
  const freehandDraftRef = useRef<readonly PdfCommentPoint[]>([]);
  const [pendingRedactions, setPendingRedactions] = useState<readonly PdfPendingRedaction[]>([]);
  const [redactionDraft, setRedactionDraft] = useState<PdfRedactionRect | null>(null);
  const [isPlacingRedaction, setPlacingRedaction] = useState(false);
  const [redactionDragStart, setRedactionDragStart] = useState<PdfCommentPoint | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editCommentDraft, setEditCommentDraft] = useState("");
  const [formStatus, setFormStatus] = useState<"loading" | "ready" | "error">("loading");
  const [formError, setFormError] = useState<string | null>(null);
  const [formStateStatus, setFormStateStatus] = useState<PdfFormStateStatus>("idle");
  const [pdfDefaultFields, setPdfDefaultFields] = useState<readonly PdfFieldDraft[]>([]);
  const staleFormFieldConflicts = useMemo(
    () =>
      formStateStatus === "restored-stale" ? pdfFormFieldConflicts(pdfDefaultFields, fields) : [],
    [fields, formStateStatus, pdfDefaultFields],
  );
  const requiredFormErrors = useMemo(() => validatePdfFormFields(fields), [fields]);
  const [isPreparingDownload, setPreparingDownload] = useState(false);
  const [isPreparingPageCopy, setPreparingPageCopy] = useState(false);
  const [driveSaveStatus, setDriveSaveStatus] = useState<PdfDriveSaveStatus>("idle");
  const [mergePlacement, setMergePlacement] = useState<PdfMergePlacement>("append");
  const contentUrl = `/api/drive/objects/${encodeURIComponent(objectId)}/content`;

  useEffect(() => {
    let cancelled = false;

    async function loadFormFields() {
      setFormStatus("loading");
      setFormError(null);
      try {
        const response = await authenticatedFetch(contentUrl);
        if (!response.ok) {
          throw new Error(`PDF failed to load with status ${String(response.status)}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const document = await PDFDocument.load(bytes);
        const form = document.getForm();
        const nextFields = form.getFields().map(fieldDraftFromPdfField);
        const serverState = await getPdfFormState({ objectId }).catch(() => null);
        const serverFields =
          serverState === null
            ? nextFields
            : restorePdfFormStateValues(nextFields, serverState.fieldValues);
        const savedFields =
          serverState === null ? restoreSavedPdfFormState(objectId, nextFields) : serverFields;
        const nextPageCount = document.getPageCount();
        if (!cancelled) {
          setPdfBytes(bytes);
          setPdfDefaultFields(nextFields);
          setFields(savedFields);
          setPageCount(nextPageCount);
          setPage((current) => Math.min(Math.max(current, 1), Math.max(nextPageCount, 1)));
          setFormStateStatus(
            savedFields === nextFields
              ? "idle"
              : serverState?.sourceChanged === true
                ? "restored-stale"
                : "restored",
          );
          setFormStatus("ready");
        }
      } catch (error) {
        if (!cancelled) {
          setPdfBytes(null);
          setPdfDefaultFields([]);
          setFields([]);
          setPageCount(null);
          setFormStatus("error");
          setFormError(error instanceof Error ? error.message : String(error));
        }
      }
    }

    void loadFormFields();

    return () => {
      cancelled = true;
    };
  }, [contentUrl]);

  useEffect(() => {
    let cancelled = false;

    async function renderCurrentPage() {
      if (pdfBytes === null) {
        setRenderedPageStatus("idle");
        setRenderedPage(null);
        return;
      }

      setRenderedPageStatus("loading");
      try {
        const pdfjs = loadPdfJs();
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes) }).promise;
        try {
          const nextPage = await renderPdfPageWithText(pdf, page, Math.max(0.5, zoom / 100));
          if (!cancelled) {
            setRenderedPage({
              ...nextPage,
              pageNumber: page,
              zoom,
            });
            setRenderedPageStatus("ready");
          }
        } finally {
          await pdf.destroy?.();
        }
      } catch {
        if (!cancelled) {
          setRenderedPage(null);
          setRenderedPageStatus("error");
        }
      }
    }

    void renderCurrentPage();

    return () => {
      cancelled = true;
    };
  }, [page, pdfBytes, zoom]);

  useEffect(() => {
    let cancelled = false;

    async function loadTextIndex() {
      if (pdfBytes === null) {
        setTextIndex([]);
        setTextIndexStatus("idle");
        return;
      }

      setTextIndexStatus("loading");
      try {
        const pdfjs = loadPdfJs();
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes) }).promise;
        try {
          const nextTextIndex = await loadPdfTextIndex(pdf);
          if (!cancelled) {
            setTextIndex(nextTextIndex);
            setTextIndexStatus("ready");
          }
        } finally {
          await pdf.destroy?.();
        }
      } catch {
        if (!cancelled) {
          setTextIndex([]);
          setTextIndexStatus("error");
        }
      }
    }

    void loadTextIndex();

    return () => {
      cancelled = true;
    };
  }, [pdfBytes]);

  useEffect(() => {
    let cancelled = false;

    async function loadNavigation() {
      if (pdfBytes === null) {
        setNavigationStatus("idle");
        setThumbnails([]);
        setOutline([]);
        return;
      }

      setNavigationStatus("loading");
      try {
        const pdfjs = loadPdfJs();
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes) }).promise;
        try {
          const [nextThumbnails, nextOutline] = await Promise.all([
            renderPdfThumbnails(pdf),
            loadPdfOutline(pdf),
          ]);
          if (!cancelled) {
            setThumbnails(nextThumbnails);
            setOutline(nextOutline);
            setNavigationStatus("ready");
          }
        } finally {
          await pdf.destroy?.();
        }
      } catch {
        if (!cancelled) {
          setThumbnails([]);
          setOutline([]);
          setNavigationStatus("error");
        }
      }
    }

    void loadNavigation();

    return () => {
      cancelled = true;
    };
  }, [pdfBytes]);

  useEffect(() => {
    let cancelled = false;

    async function loadComments() {
      setCommentsStatus("loading");
      setCommentDraft("");
      try {
        const nextComments = await listPdfComments({ objectId, status: commentStatusFilter });
        if (!cancelled) {
          setComments(nextComments);
          setCommentsStatus("ready");
        }
      } catch {
        if (!cancelled) {
          setComments([]);
          setCommentsStatus("error");
        }
      }
    }

    void loadComments();

    return () => {
      cancelled = true;
    };
  }, [commentStatusFilter, objectId]);

  useEffect(() => {
    setPendingCommentPoint(null);
    setPlacingComment(false);
    setPlacingStamp(false);
    setDrawingFreehand(false);
    setFreehandDraft([]);
    freehandDraftRef.current = [];
    setPendingRedactions([]);
    setRedactionDraft(null);
    setPlacingRedaction(false);
    setRedactionDragStart(null);
    setPlacingStamp(false);
    setTextSelectionMode(false);
    setTextSelectionStartId(null);
    setTextSelectionEndId(null);
  }, [objectId]);

  useEffect(() => {
    setRedactionDraft(null);
    setPlacingRedaction(false);
    setRedactionDragStart(null);
    setDrawingFreehand(false);
    setFreehandDraft([]);
    freehandDraftRef.current = [];
    setTextSelectionMode(false);
    setTextSelectionStartId(null);
    setTextSelectionEndId(null);
  }, [page]);

  const openComments = comments.filter((comment) => comment.status === "open");
  const activeStampAnnotations = comments
    .filter(
      (comment) =>
        comment.status === "open" &&
        (comment.parentCommentId === null || comment.parentCommentId === undefined),
    )
    .map((comment) => stampFromPdfComment(comment))
    .filter((stamp): stamp is PdfStampAnnotation => stamp !== null);
  const currentPagePins = comments.filter(
    (comment) =>
      (comment.parentCommentId === null || comment.parentCommentId === undefined) &&
      pageFromPdfComment(comment) === page &&
      pointFromPdfComment(comment) !== null &&
      redactionFromPdfComment(comment) === null &&
      stampFromPdfComment(comment) === null &&
      freehandFromPdfComment(comment) === null,
  );
  const currentPageStampAnnotations = comments
    .filter(
      (comment) =>
        (comment.parentCommentId === null || comment.parentCommentId === undefined) &&
        pageFromPdfComment(comment) === page,
    )
    .map((comment) => ({ comment, stamp: stampFromPdfComment(comment) }))
    .filter(
      (entry): entry is { readonly comment: PdfDriveComment; readonly stamp: PdfStampAnnotation } =>
        entry.stamp !== null,
    );
  const currentPageRedactionAnnotations = comments
    .filter(
      (comment) =>
        (comment.parentCommentId === null || comment.parentCommentId === undefined) &&
        pageFromPdfComment(comment) === page,
    )
    .map((comment) => ({ comment, redaction: redactionFromPdfComment(comment) }))
    .filter(
      (
        entry,
      ): entry is { readonly comment: PdfDriveComment; readonly redaction: PdfPendingRedaction } =>
        entry.redaction !== null,
    );
  const currentPageFreehandAnnotations = comments
    .filter(
      (comment) =>
        (comment.parentCommentId === null || comment.parentCommentId === undefined) &&
        pageFromPdfComment(comment) === page,
    )
    .map((comment) => ({ comment, stroke: freehandFromPdfComment(comment) }))
    .filter(
      (
        entry,
      ): entry is { readonly comment: PdfDriveComment; readonly stroke: PdfFreehandAnnotation } =>
        entry.stroke !== null,
    );
  const currentPageTextAnchors = comments
    .filter(
      (comment) =>
        (comment.parentCommentId === null || comment.parentCommentId === undefined) &&
        pageFromPdfComment(comment) === page,
    )
    .map((comment) => ({ comment, anchor: textAnchorFromPdfComment(comment) }))
    .filter(
      (entry): entry is { readonly comment: PdfDriveComment; readonly anchor: PdfTextAnchor } =>
        entry.anchor !== null,
    );
  const commentThreads = pdfCommentThreads(comments);
  const selectedComment = comments.find((comment) => comment.id === selectedCommentId) ?? null;
  const selectedThreadId = selectedCommentThreadId(commentThreads, selectedCommentId);
  const linkedCommentUnavailable =
    commentsStatus === "ready" &&
    routeState.commentId !== null &&
    selectedCommentId === routeState.commentId &&
    selectedComment === null;
  const textSearchMatches = useMemo(
    () => textMatchesForQuery(textIndex, textSearchQuery),
    [textIndex, textSearchQuery],
  );
  const currentPageTextSearchMatches = useMemo(
    () =>
      textMatchesForQuery(
        renderedPage === null
          ? []
          : [{ pageNumber: renderedPage.pageNumber, textItems: renderedPage.textItems }],
        textSearchQuery,
      ),
    [renderedPage, textSearchQuery],
  );
  const activeTextSearchMatch = textSearchMatches[activeTextMatchIndex] ?? null;
  const activeTextSearchMatchPage = activeTextSearchMatch?.pageNumber ?? null;
  const activeTextMatch =
    activeTextSearchMatch === null || activeTextSearchMatch.pageNumber !== page
      ? null
      : (currentPageTextSearchMatches.find((match) => match.id === activeTextSearchMatch.id) ??
        null);
  const selectedTextRange = useMemo(
    () =>
      renderedPage === null
        ? null
        : selectedTextRangeFromIds(
            renderedPage.textItems,
            textSelectionStartId,
            textSelectionEndId,
          ),
    [renderedPage, textSelectionEndId, textSelectionStartId],
  );
  const currentPageRedactions = pendingRedactions.filter(
    (redaction) => redaction.pageNumber === page,
  );
  const effectivePageOrder = pageOrderForPageCount(pageOrder, pageCount);
  const hasReorderedPages = pageOrderChanged(effectivePageOrder);

  useEffect(() => {
    setPage(routeState.page);
    setZoom(routeState.zoom);
    setSelectedCommentId(routeState.commentId);
    if (routeState.commentId !== null) {
      setCommentStatusFilter("all");
    }
  }, [routeState.commentId, routeState.page, routeState.zoom]);

  useEffect(() => {
    setPageOrder(defaultPageOrder(pageCount));
    setDraggedPageNumber(null);
  }, [pageCount]);

  useEffect(() => {
    if (
      page === routeState.page &&
      zoom === routeState.zoom &&
      selectedCommentId === routeState.commentId
    ) {
      return;
    }
    onRouteStateChange?.({
      page,
      zoom,
      commentId: selectedCommentId,
      sourceFolderId: routeState.sourceFolderId,
    });
  }, [
    onRouteStateChange,
    page,
    routeState.commentId,
    routeState.page,
    routeState.sourceFolderId,
    routeState.zoom,
    selectedCommentId,
    zoom,
  ]);

  useEffect(() => {
    if (selectedComment === null) {
      return;
    }
    setBoundedPage(pageFromPdfComment(selectedComment));
  }, [selectedComment]);

  useEffect(() => {
    if (selectedThreadId === null) {
      return;
    }
    commentRefs.current[selectedThreadId]?.scrollIntoView?.({
      block: "nearest",
    });
  }, [selectedThreadId]);

  useEffect(() => {
    setActiveTextMatchIndex(0);
  }, [textSearchQuery]);

  useEffect(() => {
    if (activeTextMatchIndex >= textSearchMatches.length) {
      setActiveTextMatchIndex(Math.max(0, textSearchMatches.length - 1));
    }
  }, [activeTextMatchIndex, textSearchMatches.length]);

  useEffect(() => {
    if (activeTextSearchMatchPage !== null) {
      setBoundedPage(activeTextSearchMatchPage);
    }
  }, [activeTextSearchMatchPage]);

  function stepZoom(delta: number) {
    setZoom((current) => Math.min(200, Math.max(50, current + delta)));
  }

  function setBoundedPage(nextPage: number) {
    setPage(Math.min(Math.max(nextPage, 1), pageCount ?? nextPage));
  }

  function applyOutlineDestination(item: PdfOutlineItem) {
    setBoundedPage(item.pageNumber);
    if (item.zoom !== undefined) {
      setZoom(item.zoom);
    }
  }

  function stepTextMatch(delta: number) {
    if (textSearchMatches.length === 0) {
      return;
    }
    setActiveTextMatchIndex((current) => {
      const nextIndex = (current + delta + textSearchMatches.length) % textSearchMatches.length;
      const nextMatch = textSearchMatches[nextIndex];
      if (nextMatch !== undefined) {
        setBoundedPage(nextMatch.pageNumber);
      }
      return nextIndex;
    });
  }

  function selectComment(comment: PdfDriveComment) {
    setSelectedCommentId(comment.id);
    setBoundedPage(pageFromPdfComment(comment));
  }

  function clearLinkedComment() {
    setSelectedCommentId(null);
  }

  function updateField(name: string, value: string | boolean) {
    setFormStateStatus("idle");
    setFormError(null);
    setFields((current) =>
      current.map((field) => (field.name === name ? { ...field, value } : field)),
    );
  }

  async function saveFormStateDraft() {
    setFormStateStatus("saving");
    try {
      await savePdfFormState({
        objectId,
        fields: fields.map(pdfFormStateFieldValue),
      });
      clearSavedPdfFormState(objectId);
      setFormStateStatus("saved");
    } catch {
      setFormStateStatus("error");
    }
  }

  async function clearFormStateDraft() {
    setFormStateStatus("clearing");
    try {
      await clearPdfFormState({ objectId });
      clearSavedPdfFormState(objectId);
      setFormStateStatus("cleared");
    } catch {
      setFormStateStatus("error");
    }
  }

  async function useCurrentPdfDefaults() {
    setFormStateStatus("clearing");
    try {
      await clearPdfFormState({ objectId });
      clearSavedPdfFormState(objectId);
      setFields(pdfDefaultFields);
      setFormStateStatus("defaulted");
    } catch {
      setFormStateStatus("error");
    }
  }

  function setCommentPointFromEvent(event: MouseEvent<HTMLElement>) {
    if (!isPlacingComment) {
      return;
    }
    const point = pointFromPdfStageEvent(event);
    if (point === null) {
      return;
    }
    setPendingCommentPoint(point);
    setPlacingComment(false);
  }

  function addStampFromEvent(event: MouseEvent<HTMLElement>) {
    if (!isPlacingStamp) {
      return;
    }
    const point = pointFromPdfStageEvent(event);
    if (point === null) {
      return;
    }
    void addStampAnnotation(point);
  }

  function startRedactionPlacement(event: PointerEvent<HTMLElement>) {
    if (!isPlacingRedaction) {
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = pointFromPdfStageEvent(event);
    if (point === null) {
      return;
    }
    setRedactionDragStart(point);
    setRedactionDraft(null);
  }

  function updateRedactionPlacement(event: PointerEvent<HTMLElement>) {
    if (!isPlacingRedaction || redactionDragStart === null) {
      return;
    }
    const point = pointFromPdfStageEvent(event);
    if (point === null) {
      return;
    }
    setRedactionDraft(redactionRectFromPoints(redactionDragStart, point));
  }

  function finishRedactionPlacement(event: PointerEvent<HTMLElement>) {
    if (!isPlacingRedaction || redactionDragStart === null) {
      return;
    }
    const point = pointFromPdfStageEvent(event);
    setRedactionDragStart(null);
    if (point === null) {
      return;
    }
    const nextRedaction = redactionRectFromPoints(redactionDragStart, point);
    const finalizedRedaction =
      nextRedaction.width < 1 || nextRedaction.height < 1
        ? centeredRedactionRect(point.x, point.y)
        : nextRedaction;
    setPendingRedactions((current) => [...current, { pageNumber: page, ...finalizedRedaction }]);
    setRedactionDraft(null);
    setPlacingRedaction(false);
  }

  function startFreehandAnnotation(event: PointerEvent<HTMLElement>) {
    if (!isDrawingFreehand) {
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = pointFromPdfStageEvent(event);
    if (point === null) {
      return;
    }
    freehandDraftRef.current = [point];
    setFreehandDraft([point]);
  }

  function updateFreehandAnnotation(event: PointerEvent<HTMLElement>) {
    if (!isDrawingFreehand || freehandDraftRef.current.length === 0) {
      return;
    }
    const point = pointFromPdfStageEvent(event);
    if (point === null) {
      return;
    }
    const lastPoint = freehandDraftRef.current.at(-1);
    if (lastPoint !== undefined && distanceBetweenPoints(lastPoint, point) < 0.8) {
      return;
    }
    const nextPoints = [...freehandDraftRef.current, point];
    freehandDraftRef.current = nextPoints;
    setFreehandDraft(nextPoints);
  }

  function finishFreehandAnnotation(event: PointerEvent<HTMLElement>) {
    if (!isDrawingFreehand || freehandDraftRef.current.length === 0) {
      return;
    }
    const point = pointFromPdfStageEvent(event);
    const nextPoints =
      point === null || distanceBetweenPoints(freehandDraftRef.current.at(-1) ?? point, point) < 0.1
        ? freehandDraftRef.current
        : [...freehandDraftRef.current, point];
    freehandDraftRef.current = [];
    setFreehandDraft([]);
    setDrawingFreehand(false);
    if (nextPoints.length < 2) {
      return;
    }
    void addFreehandAnnotation(nextPoints);
  }

  async function addPageComment() {
    const body = commentDraft.trim();
    if (body.length === 0) {
      return;
    }
    const comment = await createPdfComment({
      objectId,
      body,
      anchor: pdfCommentAnchor({
        objectId,
        page,
        pageCount,
        point: pendingCommentPoint,
      }),
      metadata: {
        source:
          pendingCommentPoint === null
            ? "web.native-pdf-viewer.comments"
            : "web.native-pdf-viewer.comments.pin",
      },
    });
    setComments((current) => [...current, comment]);
    setCommentDraft("");
    setPendingCommentPoint(null);
    setPlacingComment(false);
    setSelectedCommentId(comment.id);
  }

  async function addStampAnnotation(point: PdfCommentPoint) {
    const descriptor = pdfStampDescriptor(stampKind);
    const comment = await createPdfComment({
      objectId,
      body: `${descriptor.label} review stamp`,
      anchor: pdfStampCommentAnchor({
        objectId,
        page,
        pageCount,
        point,
        stamp: descriptor,
      }),
      metadata: {
        source: "web.native-pdf-viewer.stamps",
        reviewOnly: true,
        stamp: descriptor.kind,
      },
    });
    setComments((current) => [...current, comment]);
    setPlacingStamp(false);
    setSelectedCommentId(comment.id);
  }

  async function addFreehandAnnotation(points: readonly PdfCommentPoint[]) {
    const body = commentDraft.trim() || `Freehand annotation on page ${String(page)}`;
    const comment = await createPdfComment({
      objectId,
      body,
      anchor: pdfFreehandCommentAnchor({
        objectId,
        page,
        pageCount,
        points,
      }),
      metadata: {
        source: "web.native-pdf-viewer.freehand",
        reviewOnly: true,
      },
    });
    setComments((current) => [...current, comment]);
    setCommentDraft("");
    setSelectedCommentId(comment.id);
  }

  async function addTextMatchComment() {
    const body = commentDraft.trim();
    if (body.length === 0 || activeTextMatch === null || renderedPage === null) {
      return;
    }
    const comment = await createPdfComment({
      objectId,
      body,
      anchor: pdfTextCommentAnchor({
        objectId,
        page,
        pageCount,
        match: activeTextMatch,
        renderedPage,
      }),
      metadata: {
        source: "web.native-pdf-viewer.comments.text-match",
      },
    });
    setComments((current) => [...current, comment]);
    setCommentDraft("");
    setSelectedCommentId(comment.id);
  }

  async function addTextSelectionComment() {
    const body = commentDraft.trim();
    if (body.length === 0 || selectedTextRange === null || renderedPage === null) {
      return;
    }
    const comment = await createPdfComment({
      objectId,
      body,
      anchor: pdfTextSelectionCommentAnchor({
        objectId,
        page,
        pageCount,
        selection: selectedTextRange,
        renderedPage,
      }),
      metadata: {
        source: "web.native-pdf-viewer.comments.text-selection",
      },
    });
    setComments((current) => [...current, comment]);
    setCommentDraft("");
    setSelectedCommentId(comment.id);
    clearTextSelection();
  }

  function useBrowserTextSelection() {
    if (renderedPage === null) {
      return;
    }
    const range = browserSelectedTextRange(renderedPage.textItems);
    if (range === null) {
      return;
    }
    setPlacingComment(false);
    setPlacingRedaction(false);
    setDrawingFreehand(false);
    setFreehandDraft([]);
    freehandDraftRef.current = [];
    setTextSelectionMode(false);
    setTextSelectionStartId(range.items[0]?.id ?? null);
    setTextSelectionEndId(range.items.at(-1)?.id ?? null);
    setTextSelectionCopyStatus("idle");
  }

  function selectTextItem(itemId: string) {
    if (!textSelectionMode) {
      return;
    }
    setTextSelectionCopyStatus("idle");
    setTextSelectionStartId((startId) => {
      if (startId === null || selectedTextRange !== null) {
        setTextSelectionEndId(null);
        return itemId;
      }
      setTextSelectionEndId(itemId);
      return startId;
    });
  }

  function clearTextSelection() {
    setTextSelectionMode(false);
    setTextSelectionStartId(null);
    setTextSelectionEndId(null);
    setTextSelectionCopyStatus("idle");
  }

  async function copySelectedTextRange() {
    if (selectedTextRange === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(selectedTextRange.text);
      setTextSelectionCopyStatus("copied");
    } catch {
      setTextSelectionCopyStatus("error");
    }
  }

  async function addReply(parent: PdfDriveComment) {
    const body = (replyDrafts[parent.id] ?? "").trim();
    if (body.length === 0) {
      return;
    }
    const comment = await createPdfComment({
      objectId,
      parentCommentId: parent.id,
      body,
      anchor: parent.anchor,
      metadata: {
        source: "web.native-pdf-viewer.comments.reply",
        parentCommentId: parent.id,
      },
    });
    setComments((current) =>
      commentStatusFilter === "resolved" ? current : [...current, comment],
    );
    setReplyDrafts((current) => ({ ...current, [parent.id]: "" }));
  }

  async function resolveComment(commentId: string) {
    const comment = await resolvePdfComment({ commentId });
    applyResolvedComments([comment]);
  }

  async function reopenComment(commentId: string) {
    const comment = await reopenPdfComment({ commentId });
    setComments((current) => {
      if (commentStatusFilter === "resolved") {
        return current.filter(
          (candidate) => candidate.id !== comment.id && candidate.parentCommentId !== comment.id,
        );
      }
      return current.map((candidate) => (candidate.id === comment.id ? comment : candidate));
    });
  }

  function startEditingComment(comment: PdfDriveComment) {
    setEditingCommentId(comment.id);
    setEditCommentDraft(comment.body);
  }

  async function saveCommentEdit(comment: PdfDriveComment) {
    const body = editCommentDraft.trim();
    if (body.length === 0) {
      return;
    }
    const updated = await updatePdfComment({ commentId: comment.id, body });
    setComments((current) =>
      current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
    );
    setEditingCommentId(null);
    setEditCommentDraft("");
  }

  async function deleteComment(comment: PdfDriveComment) {
    const deleted = await deletePdfComment({ commentId: comment.id });
    const deletedCommentIds = new Set(
      comments
        .filter(
          (candidate) => candidate.id === deleted.id || candidate.parentCommentId === deleted.id,
        )
        .map((candidate) => candidate.id),
    );
    deletedCommentIds.add(deleted.id);
    setComments((current) =>
      current.filter(
        (candidate) => candidate.id !== deleted.id && candidate.parentCommentId !== deleted.id,
      ),
    );
    if (selectedCommentId !== null && deletedCommentIds.has(selectedCommentId)) {
      setSelectedCommentId(null);
    }
    if (editingCommentId !== null && deletedCommentIds.has(editingCommentId)) {
      setEditingCommentId(null);
      setEditCommentDraft("");
    }
    setReplyDrafts((current) => {
      if (current[deleted.id] === undefined) {
        return current;
      }
      const next = { ...current };
      delete next[deleted.id];
      return next;
    });
  }

  async function resolveCommentThread(
    comment: PdfDriveComment,
    replies: readonly PdfDriveComment[],
  ) {
    const openThreadComments = [comment, ...replies].filter(
      (threadComment) => threadComment.status === "open",
    );
    if (openThreadComments.length === 0) {
      return;
    }
    const resolvedComments = await Promise.all(
      openThreadComments.map((threadComment) => resolvePdfComment({ commentId: threadComment.id })),
    );
    applyResolvedComments(resolvedComments);
  }

  function applyResolvedComments(resolvedComments: readonly PdfDriveComment[]) {
    const resolvedById = new Map(resolvedComments.map((comment) => [comment.id, comment]));
    const resolvedIds = new Set(resolvedById.keys());
    setComments((current) => {
      if (commentStatusFilter === "open") {
        return current.filter((candidate) => !resolvedIds.has(candidate.id));
      }
      return current.map((candidate) => resolvedById.get(candidate.id) ?? candidate);
    });
    if (
      commentStatusFilter === "open" &&
      selectedCommentId !== null &&
      resolvedIds.has(selectedCommentId)
    ) {
      setSelectedCommentId(null);
    }
  }

  async function filledCopyBlob() {
    if (pdfBytes === null) {
      throw new Error("PDF bytes are not loaded.");
    }
    const document = await PDFDocument.load(pdfBytes);
    const form = document.getForm();
    for (const field of fields) {
      applyFieldDraft(form.getField(field.name), field);
    }
    drawPdfSignatureAppearances(document, fields);
    return pdfBytesToBlob(await document.save());
  }

  async function downloadFilledCopy() {
    if (pdfBytes === null || isPreparingDownload) {
      return;
    }
    if (!validateRequiredPdfFormFields()) {
      return;
    }
    setPreparingDownload(true);
    setFormError(null);
    try {
      downloadBlob(filledCopyFilename(objectId), await filledCopyBlob());
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingDownload(false);
    }
  }

  async function saveFilledCopyToDrive() {
    if (pdfBytes === null || isPreparingDownload || driveSaveStatus === "saving-filled") {
      return;
    }
    if (!validateRequiredPdfFormFields()) {
      return;
    }
    setPreparingDownload(true);
    setDriveSaveStatus("saving-filled");
    setFormError(null);
    try {
      await savePdfCopyToDrive({
        filename: filledCopyFilename(objectId),
        blob: await filledCopyBlob(),
        folderId: saveTargetFolderId,
      });
      setDriveSaveStatus("saved");
    } catch (error) {
      setDriveSaveStatus("error");
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingDownload(false);
    }
  }

  function validateRequiredPdfFormFields(): boolean {
    const errors = validatePdfFormFields(fields);
    if (errors.length === 0) {
      return true;
    }
    setDriveSaveStatus("idle");
    setFormError(requiredPdfFormError(errors));
    return false;
  }

  async function downloadRotatedPageCopy(direction: "left" | "right") {
    if (pdfBytes === null || isPreparingPageCopy) {
      return;
    }
    setPreparingPageCopy(true);
    setFormError(null);
    try {
      downloadBlob(
        rotatedPageCopyFilename(objectId, page, direction),
        await rotatedPageCopyBlob(direction),
      );
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingPageCopy(false);
    }
  }

  async function saveRotatedPageCopyToDrive(direction: "left" | "right") {
    if (pdfBytes === null || isPreparingPageCopy || driveSaveStatus === "saving-page-copy") {
      return;
    }
    setPreparingPageCopy(true);
    setDriveSaveStatus("saving-page-copy");
    setFormError(null);
    try {
      await savePdfCopyToDrive({
        filename: rotatedPageCopyFilename(objectId, page, direction),
        blob: await rotatedPageCopyBlob(direction),
        folderId: saveTargetFolderId,
      });
      setDriveSaveStatus("saved");
    } catch (error) {
      setDriveSaveStatus("error");
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingPageCopy(false);
    }
  }

  async function rotatedPageCopyBlob(direction: "left" | "right") {
    if (pdfBytes === null) {
      throw new Error("PDF page rotation is not ready.");
    }
    const pdfDocument = await PDFDocument.load(pdfBytes);
    const targetPage = pdfDocument.getPage(page - 1);
    const currentRotation = targetPage.getRotation().angle;
    const rotationDelta = direction === "left" ? -90 : 90;
    targetPage.setRotation(degrees(normalizePdfRotation(currentRotation + rotationDelta)));
    return pdfBytesToBlob(await pdfDocument.save());
  }

  function canMoveCurrentPage(direction: "earlier" | "later"): boolean {
    if (pageCount === null || pageCount <= 1) {
      return false;
    }
    const targetPageIndex = page - 1;
    return !(
      targetPageIndex < 0 ||
      targetPageIndex >= pageCount ||
      (direction === "earlier" && targetPageIndex === 0) ||
      (direction === "later" && targetPageIndex === pageCount - 1)
    );
  }

  function reorderPages(draggedPage: number, targetPage: number) {
    if (
      pageCount === null ||
      pageCount <= 1 ||
      draggedPage === targetPage ||
      isPreparingPageCopy ||
      driveSaveStatus === "saving-page-copy"
    ) {
      return;
    }
    setPageOrder((current) =>
      reorderPageOrder(pageOrderForPageCount(current, pageCount), draggedPage, targetPage),
    );
    setBoundedPage(draggedPage);
  }

  async function movedPageCopyBlob(direction: "earlier" | "later") {
    if (pdfBytes === null || pageCount === null || pageCount <= 1) {
      throw new Error("PDF page move is not ready.");
    }
    if (!canMoveCurrentPage(direction)) {
      throw new Error("Selected PDF page cannot move in that direction.");
    }
    const targetPageIndex = page - 1;
    const pdfDocument = await PDFDocument.load(pdfBytes);
    const movedPage = pdfDocument.getPage(targetPageIndex);
    pdfDocument.removePage(targetPageIndex);
    pdfDocument.insertPage(
      direction === "earlier" ? targetPageIndex - 1 : targetPageIndex + 1,
      movedPage,
    );
    return pdfBytesToBlob(await pdfDocument.save());
  }

  async function downloadMovedPageCopy(direction: "earlier" | "later") {
    if (pdfBytes === null || isPreparingPageCopy || !canMoveCurrentPage(direction)) {
      return;
    }
    setPreparingPageCopy(true);
    setFormError(null);
    try {
      downloadBlob(
        movedPageCopyFilename(objectId, page, direction),
        await movedPageCopyBlob(direction),
      );
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingPageCopy(false);
    }
  }

  async function saveMovedPageCopyToDrive(direction: "earlier" | "later") {
    if (
      pdfBytes === null ||
      isPreparingPageCopy ||
      !canMoveCurrentPage(direction) ||
      driveSaveStatus === "saving-page-copy"
    ) {
      return;
    }
    setPreparingPageCopy(true);
    setDriveSaveStatus("saving-page-copy");
    setFormError(null);
    try {
      await savePdfCopyToDrive({
        filename: movedPageCopyFilename(objectId, page, direction),
        blob: await movedPageCopyBlob(direction),
        folderId: saveTargetFolderId,
      });
      setDriveSaveStatus("saved");
    } catch (error) {
      setDriveSaveStatus("error");
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingPageCopy(false);
    }
  }

  async function reorderedPageCopyBlob() {
    if (pdfBytes === null || pageCount === null || pageCount <= 1 || !hasReorderedPages) {
      throw new Error("PDF page reorder is not ready.");
    }
    const pdfDocument = await PDFDocument.load(pdfBytes);
    applyPageOrderToPdfDocument(pdfDocument, effectivePageOrder);
    return pdfBytesToBlob(await pdfDocument.save());
  }

  async function downloadReorderedPageCopy() {
    if (pdfBytes === null || isPreparingPageCopy || !hasReorderedPages) {
      return;
    }
    setPreparingPageCopy(true);
    setFormError(null);
    try {
      downloadBlob(reorderedPageCopyFilename(objectId), await reorderedPageCopyBlob());
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingPageCopy(false);
    }
  }

  async function saveReorderedPageCopyToDrive() {
    if (
      pdfBytes === null ||
      isPreparingPageCopy ||
      !hasReorderedPages ||
      driveSaveStatus === "saving-page-copy"
    ) {
      return;
    }
    setPreparingPageCopy(true);
    setDriveSaveStatus("saving-page-copy");
    setFormError(null);
    try {
      await savePdfCopyToDrive({
        filename: reorderedPageCopyFilename(objectId),
        blob: await reorderedPageCopyBlob(),
        folderId: saveTargetFolderId,
      });
      setDriveSaveStatus("saved");
    } catch (error) {
      setDriveSaveStatus("error");
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingPageCopy(false);
    }
  }

  async function withoutCurrentPageCopyBlob() {
    if (pdfBytes === null || pageCount === null || pageCount <= 1) {
      throw new Error("PDF page deletion is not ready.");
    }
    const pdfDocument = await PDFDocument.load(pdfBytes);
    const targetPageIndex = page - 1;
    if (targetPageIndex < 0 || targetPageIndex >= pageCount) {
      throw new Error("Selected PDF page is out of range.");
    }
    pdfDocument.removePage(targetPageIndex);
    return pdfBytesToBlob(await pdfDocument.save());
  }

  async function downloadWithoutCurrentPageCopy() {
    if (pdfBytes === null || isPreparingPageCopy || pageCount === null || pageCount <= 1) {
      return;
    }
    setPreparingPageCopy(true);
    setFormError(null);
    try {
      downloadBlob(
        withoutCurrentPageCopyFilename(objectId, page),
        await withoutCurrentPageCopyBlob(),
      );
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingPageCopy(false);
    }
  }

  async function saveWithoutCurrentPageCopyToDrive() {
    if (
      pdfBytes === null ||
      isPreparingPageCopy ||
      pageCount === null ||
      pageCount <= 1 ||
      driveSaveStatus === "saving-page-copy"
    ) {
      return;
    }
    setPreparingPageCopy(true);
    setDriveSaveStatus("saving-page-copy");
    setFormError(null);
    try {
      await savePdfCopyToDrive({
        filename: withoutCurrentPageCopyFilename(objectId, page),
        blob: await withoutCurrentPageCopyBlob(),
        folderId: saveTargetFolderId,
      });
      setDriveSaveStatus("saved");
    } catch (error) {
      setDriveSaveStatus("error");
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingPageCopy(false);
    }
  }

  async function currentPageCopyBlob() {
    if (pdfBytes === null || pageCount === null) {
      throw new Error("PDF page extraction is not ready.");
    }
    const targetPageIndex = page - 1;
    if (targetPageIndex < 0 || targetPageIndex >= pageCount) {
      throw new Error("Selected PDF page is out of range.");
    }
    const sourceDocument = await PDFDocument.load(pdfBytes);
    const extractedDocument = await PDFDocument.create();
    const [copiedPage] = await extractedDocument.copyPages(sourceDocument, [targetPageIndex]);
    if (copiedPage === undefined) {
      throw new Error("Could not copy the selected page.");
    }
    extractedDocument.addPage(copiedPage);
    return pdfBytesToBlob(await extractedDocument.save());
  }

  async function downloadCurrentPageCopy() {
    if (pdfBytes === null || isPreparingPageCopy || pageCount === null) {
      return;
    }
    setPreparingPageCopy(true);
    setFormError(null);
    try {
      downloadBlob(currentPageCopyFilename(objectId, page), await currentPageCopyBlob());
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingPageCopy(false);
    }
  }

  async function saveCurrentPageCopyToDrive() {
    if (
      pdfBytes === null ||
      isPreparingPageCopy ||
      pageCount === null ||
      driveSaveStatus === "saving-page-copy"
    ) {
      return;
    }
    setPreparingPageCopy(true);
    setDriveSaveStatus("saving-page-copy");
    setFormError(null);
    try {
      await savePdfCopyToDrive({
        filename: currentPageCopyFilename(objectId, page),
        blob: await currentPageCopyBlob(),
        folderId: saveTargetFolderId,
      });
      setDriveSaveStatus("saved");
    } catch (error) {
      setDriveSaveStatus("error");
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingPageCopy(false);
    }
  }

  async function downloadSplitPageCopies() {
    if (pdfBytes === null || isPreparingPageCopy || pageCount === null || pageCount < 1) {
      return;
    }
    setPreparingPageCopy(true);
    setFormError(null);
    try {
      downloadBlob(splitPagesZipFilename(objectId), await splitPagesZipBlob());
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingPageCopy(false);
    }
  }

  async function saveSplitPageCopiesToDrive() {
    if (
      pdfBytes === null ||
      isPreparingPageCopy ||
      pageCount === null ||
      pageCount < 1 ||
      driveSaveStatus === "saving-page-copy"
    ) {
      return;
    }
    setPreparingPageCopy(true);
    setDriveSaveStatus("saving-page-copy");
    setFormError(null);
    try {
      await savePdfCopyToDrive({
        filename: splitPagesZipFilename(objectId),
        blob: await splitPagesZipBlob(),
        folderId: saveTargetFolderId,
      });
      setDriveSaveStatus("saved");
    } catch (error) {
      setDriveSaveStatus("error");
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingPageCopy(false);
    }
  }

  async function splitPagesZipBlob() {
    if (pdfBytes === null || pageCount === null || pageCount < 1) {
      throw new Error("PDF split is not ready.");
    }
    const sourceDocument = await PDFDocument.load(pdfBytes);
    const fileStem = pdfDownloadFileStem(objectId);
    const splitEntries: PdfZipEntry[] = [];
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const splitDocument = await PDFDocument.create();
      const [copiedPage] = await splitDocument.copyPages(sourceDocument, [pageIndex]);
      if (copiedPage === undefined) {
        throw new Error(`Could not copy page ${String(pageIndex + 1)}.`);
      }
      splitDocument.addPage(copiedPage);
      const splitBytes = await splitDocument.save();
      splitEntries.push({
        name: `${fileStem}-page-${String(pageIndex + 1).padStart(3, "0")}.pdf`,
        data: new Uint8Array(splitBytes),
      });
    }
    const zipBytes = zipStorePdfEntries(splitEntries);
    const zipBuffer = new ArrayBuffer(zipBytes.byteLength);
    new Uint8Array(zipBuffer).set(zipBytes);
    return new Blob([zipBuffer], { type: "application/zip" });
  }

  async function downloadMergedPdfCopy(file: File | undefined, placement: PdfMergePlacement) {
    if (file === undefined || pdfBytes === null || isPreparingPageCopy) {
      return;
    }
    setPreparingPageCopy(true);
    setFormError(null);
    try {
      downloadBlob(mergedPdfCopyFilename(objectId), await mergedPdfCopyBlob(file, placement));
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingPageCopy(false);
    }
  }

  async function saveMergedPdfCopyToDrive(file: File | undefined, placement: PdfMergePlacement) {
    if (
      file === undefined ||
      pdfBytes === null ||
      isPreparingPageCopy ||
      driveSaveStatus === "saving-page-copy"
    ) {
      return;
    }
    setPreparingPageCopy(true);
    setDriveSaveStatus("saving-page-copy");
    setFormError(null);
    try {
      await savePdfCopyToDrive({
        filename: mergedPdfCopyFilename(objectId),
        blob: await mergedPdfCopyBlob(file, placement),
        folderId: saveTargetFolderId,
      });
      setDriveSaveStatus("saved");
    } catch (error) {
      setDriveSaveStatus("error");
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingPageCopy(false);
    }
  }

  async function mergedPdfCopyBlob(file: File, placement: PdfMergePlacement) {
    if (pdfBytes === null) {
      throw new Error("PDF merge is not ready.");
    }
    const [sourceDocument, mergeDocument] = await Promise.all([
      PDFDocument.load(pdfBytes),
      file.arrayBuffer().then((buffer) => PDFDocument.load(new Uint8Array(buffer))),
    ]);
    const mergePageCount = mergeDocument.getPageCount();
    if (mergePageCount < 1) {
      throw new Error("Selected PDF has no pages to merge.");
    }
    const copiedPages = await sourceDocument.copyPages(
      mergeDocument,
      Array.from({ length: mergePageCount }, (_, index) => index),
    );
    for (const [index, copiedPage] of copiedPages.entries()) {
      if (placement === "append") {
        sourceDocument.addPage(copiedPage);
      } else if (placement === "prepend") {
        sourceDocument.insertPage(index, copiedPage);
      } else {
        sourceDocument.insertPage(page + index, copiedPage);
      }
    }
    return pdfBytesToBlob(await sourceDocument.save());
  }

  async function redactedCopyBlob() {
    if (pdfBytes === null || pageCount === null || pendingRedactions.length === 0) {
      throw new Error("PDF redactions are not ready.");
    }
    const redactionsByPage = redactionsGroupedByPage(pendingRedactions, pageCount);
    if (redactionsByPage.size === 0) {
      throw new Error("PDF redactions are not ready.");
    }
    const sourceDocument = await PDFDocument.load(pdfBytes);
    const redactedDocument = await PDFDocument.create();
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const pageNumber = pageIndex + 1;
      const pageRedactions = redactionsByPage.get(pageNumber);
      if (pageRedactions !== undefined && pageRedactions.length > 0) {
        const targetPage = sourceDocument.getPage(pageIndex);
        const pageWidth = targetPage.getWidth();
        const pageHeight = targetPage.getHeight();
        const redactedPageImage = await renderRedactedPdfPageImage(
          pdfBytes,
          pageNumber,
          pageRedactions,
        );
        const embeddedPage = await redactedDocument.embedPng(redactedPageImage.dataUrl);
        const redactedPage = redactedDocument.addPage([pageWidth, pageHeight]);
        redactedPage.drawImage(embeddedPage, {
          x: 0,
          y: 0,
          width: pageWidth,
          height: pageHeight,
        });
        continue;
      }
      const [copiedPage] = await redactedDocument.copyPages(sourceDocument, [pageIndex]);
      if (copiedPage !== undefined) {
        redactedDocument.addPage(copiedPage);
      }
    }
    return pdfBytesToBlob(await redactedDocument.save());
  }

  async function stampedCopyBlob() {
    if (pdfBytes === null || pageCount === null || activeStampAnnotations.length === 0) {
      throw new Error("PDF stamps are not ready.");
    }
    const stampsByPage = stampAnnotationsGroupedByPage(activeStampAnnotations, pageCount);
    if (stampsByPage.size === 0) {
      throw new Error("PDF stamps are not ready.");
    }
    const document = await PDFDocument.load(pdfBytes);
    for (const [pageNumber, stamps] of stampsByPage) {
      const targetPage = document.getPage(pageNumber - 1);
      const pageWidth = targetPage.getWidth();
      const pageHeight = targetPage.getHeight();
      const rotation = targetPage.getRotation().angle;
      for (const stamp of stamps) {
        const center = stampPointToPdfCoordinates(stamp, pageWidth, pageHeight, rotation);
        const bounds = pdfStampBounds(stamp.label, center, pageWidth, pageHeight);
        targetPage.drawRectangle({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          color: rgb(1, 1, 1),
          borderColor: rgb(0.06, 0.09, 0.16),
          borderWidth: 1.5,
          opacity: 0.9,
        });
        targetPage.drawText(stamp.label.toUpperCase(), {
          x: bounds.x + PDF_STAMP_PDF_PADDING_X,
          y: bounds.y + PDF_STAMP_PDF_PADDING_Y,
          size: PDF_STAMP_PDF_FONT_SIZE,
          color: rgb(0.06, 0.09, 0.16),
        });
      }
    }
    return pdfBytesToBlob(await document.save());
  }

  async function downloadRedactedCopy() {
    if (
      pdfBytes === null ||
      isPreparingPageCopy ||
      pageCount === null ||
      pendingRedactions.length === 0
    ) {
      return;
    }
    setPreparingPageCopy(true);
    setFormError(null);
    try {
      downloadBlob(redactedCopyFilename(objectId), await redactedCopyBlob());
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingPageCopy(false);
    }
  }

  async function saveRedactedCopyToDrive() {
    if (
      pdfBytes === null ||
      isPreparingPageCopy ||
      pageCount === null ||
      pendingRedactions.length === 0 ||
      driveSaveStatus === "saving-redacted"
    ) {
      return;
    }
    setPreparingPageCopy(true);
    setDriveSaveStatus("saving-redacted");
    setFormError(null);
    try {
      await savePdfCopyToDrive({
        filename: redactedCopyFilename(objectId),
        blob: await redactedCopyBlob(),
        folderId: saveTargetFolderId,
      });
      setDriveSaveStatus("saved");
    } catch (error) {
      setDriveSaveStatus("error");
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingPageCopy(false);
    }
  }

  async function downloadStampedCopy() {
    if (
      pdfBytes === null ||
      isPreparingPageCopy ||
      pageCount === null ||
      activeStampAnnotations.length === 0
    ) {
      return;
    }
    setPreparingPageCopy(true);
    setFormError(null);
    try {
      downloadBlob(stampedCopyFilename(objectId), await stampedCopyBlob());
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingPageCopy(false);
    }
  }

  async function saveStampedCopyToDrive() {
    if (
      pdfBytes === null ||
      isPreparingPageCopy ||
      pageCount === null ||
      activeStampAnnotations.length === 0 ||
      driveSaveStatus === "saving-stamped"
    ) {
      return;
    }
    setPreparingPageCopy(true);
    setDriveSaveStatus("saving-stamped");
    setFormError(null);
    try {
      await savePdfCopyToDrive({
        filename: stampedCopyFilename(objectId),
        blob: await stampedCopyBlob(),
        folderId: saveTargetFolderId,
      });
      setDriveSaveStatus("saved");
    } catch (error) {
      setDriveSaveStatus("error");
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingPageCopy(false);
    }
  }

  async function saveRedactionAnnotations() {
    if (pendingRedactions.length === 0 || commentsStatus === "loading") {
      return;
    }
    setFormError(null);
    try {
      const createdComments = await Promise.all(
        pendingRedactions.map((redaction, index) =>
          createPdfComment({
            objectId,
            body: `Redaction on page ${String(redaction.pageNumber)}`,
            anchor: pdfRedactionCommentAnchor({
              objectId,
              pageCount,
              redaction,
            }),
            metadata: {
              source: "web.native-pdf-viewer.redactions",
              redactionIndex: index + 1,
            },
          }),
        ),
      );
      setComments((current) => [...current, ...createdComments]);
      setPendingRedactions([]);
      setSelectedCommentId(createdComments[0]?.id ?? null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  }

  async function copyPageLink() {
    await writeClipboardText(
      buildPdfViewLink({ page, zoom, commentId: null, sourceFolderId: saveTargetFolderId }),
    );
  }

  async function copyCommentLink(comment: PdfDriveComment) {
    await writeClipboardText(
      buildPdfViewLink({
        page: pageFromPdfComment(comment),
        zoom,
        commentId: comment.id,
        sourceFolderId: saveTargetFolderId,
      }),
    );
  }

  async function copyAnnotationLink(comment: PdfDriveComment) {
    await writeClipboardText(
      buildPdfViewLink({
        page: pageFromPdfComment(comment),
        zoom,
        commentId: null,
        annotationId: comment.id,
        sourceFolderId: saveTargetFolderId,
      }),
    );
  }

  useEffect(() => {
    return platformHost.registerCommandPaletteItems([
      {
        id: `pdf:${objectId}:find`,
        pluginId: "com.helix.pdf",
        label: "Find in PDF",
        group: "PDF",
        keywords: ["find", "search", objectId],
        shortcut: "⌘F",
        order: 210,
        run: () => focusPdfControl("native-pdf-find"),
      },
      {
        id: `pdf:${objectId}:page:previous`,
        pluginId: "com.helix.pdf",
        label: "Previous PDF page",
        group: "PDF",
        keywords: ["previous", "page", objectId],
        order: 220,
        run: () => setPage((current) => Math.max(1, current - 1)),
      },
      {
        id: `pdf:${objectId}:page:next`,
        pluginId: "com.helix.pdf",
        label: "Next PDF page",
        group: "PDF",
        keywords: ["next", "page", objectId],
        order: 221,
        run: () => setBoundedPage(page + 1),
      },
      {
        id: `pdf:${objectId}:zoom:in`,
        pluginId: "com.helix.pdf",
        label: "Zoom in PDF",
        group: "PDF",
        keywords: ["zoom", "increase", objectId],
        order: 230,
        run: () => stepZoom(10),
      },
      {
        id: `pdf:${objectId}:zoom:out`,
        pluginId: "com.helix.pdf",
        label: "Zoom out PDF",
        group: "PDF",
        keywords: ["zoom", "decrease", objectId],
        order: 231,
        run: () => stepZoom(-10),
      },
      {
        id: `pdf:${objectId}:copy-page-link`,
        pluginId: "com.helix.pdf",
        label: "Copy PDF page link",
        group: "PDF",
        keywords: ["copy", "link", "page", objectId],
        order: 240,
        run: () => copyPageLink(),
      },
      {
        id: `pdf:${objectId}:download-filled-copy`,
        pluginId: "com.helix.pdf",
        label: "Download filled PDF copy",
        group: "PDF",
        keywords: ["download", "filled", "form", objectId],
        order: 250,
        run: () => downloadFilledCopy(),
      },
      {
        id: `pdf:${objectId}:save-filled-copy`,
        pluginId: "com.helix.pdf",
        label: "Save filled PDF copy to Drive",
        group: "PDF",
        keywords: ["save", "drive", "filled", "form", objectId],
        order: 251,
        run: () => saveFilledCopyToDrive(),
      },
    ]);
  }, [
    objectId,
    page,
    pageCount,
    platformHost,
    saveTargetFolderId,
    zoom,
    pdfBytes,
    isPreparingDownload,
    driveSaveStatus,
    fields,
  ]);

  return (
    <div style={PDF_SHELL_STYLE}>
      <div style={TOOLBAR_STYLE}>
        {/* eslint-disable-next-line helix/internal-link -- NativePdfViewer is tested outside router context. */}
        <a href="/drive" className="icon-btn" aria-label="Back to Drive">
          <Icons.ArrowLeft />
        </a>
        <div style={{ minWidth: 0 }}>
          <div style={TITLE_STYLE}>PDF viewer</div>
          <div style={META_STYLE}>Drive object {objectId}</div>
        </div>
        <div style={PAGER_STYLE} aria-label="PDF page controls">
          <button
            type="button"
            className="icon-btn"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            <Icons.ChevronLeft />
          </button>
          <label style={PAGE_FIELD_STYLE}>
            <span>Page</span>
            <input
              aria-label="Page number"
              value={page}
              inputMode="numeric"
              onChange={(event) => {
                const next = Number.parseInt(event.target.value, 10);
                setBoundedPage(Number.isFinite(next) && next > 0 ? next : 1);
              }}
            />
          </label>
          {pageCount !== null ? <span style={PAGE_COUNT_STYLE}>/ {pageCount}</span> : null}
          <button
            type="button"
            className="icon-btn"
            aria-label="Next page"
            disabled={pageCount !== null && page >= pageCount}
            onClick={() => setBoundedPage(page + 1)}
          >
            <Icons.ChevronRight />
          </button>
        </div>
        <div style={ZOOM_STYLE} aria-label="PDF zoom controls">
          <button
            type="button"
            className="icon-btn"
            aria-label="Zoom out"
            disabled={zoom <= 50}
            onClick={() => stepZoom(-10)}
          >
            <Icons.Minus />
          </button>
          <span style={ZOOM_VALUE_STYLE}>{zoom}%</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Zoom in"
            disabled={zoom >= 200}
            onClick={() => stepZoom(10)}
          >
            <Icons.Plus />
          </button>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="Copy page link"
          onClick={() => void copyPageLink()}
        >
          <Icons.Link />
        </button>
        <div style={PDF_FIND_STYLE} aria-label="PDF find controls">
          <input
            id="native-pdf-find"
            aria-label="Find PDF text"
            value={textSearchQuery}
            onChange={(event) => setTextSearchQuery(event.currentTarget.value)}
            placeholder="Find"
            style={PDF_FIND_INPUT_STYLE}
          />
          <span style={PDF_FIND_COUNT_STYLE}>
            {textSearchQuery.trim().length === 0
              ? "0/0"
              : `${String(Math.min(activeTextMatchIndex + 1, textSearchMatches.length))}/${String(
                  textSearchMatches.length,
                )}${textIndexStatus === "loading" ? " indexing" : ""}`}
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Previous PDF text match"
            disabled={textSearchMatches.length === 0}
            onClick={() => stepTextMatch(-1)}
          >
            <Icons.ChevronLeft />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Next PDF text match"
            disabled={textSearchMatches.length === 0}
            onClick={() => stepTextMatch(1)}
          >
            <Icons.ChevronRight />
          </button>
        </div>
        <button
          type="button"
          className="btn sm"
          disabled={pdfBytes === null || isPreparingPageCopy}
          onClick={() => void downloadRotatedPageCopy("left")}
        >
          <Icons.Refresh /> {isPreparingPageCopy ? "Preparing..." : "Rotate left"}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={pdfBytes === null || isPreparingPageCopy}
          onClick={() => void saveRotatedPageCopyToDrive("left")}
        >
          <Icons.Upload />{" "}
          {driveSaveStatus === "saving-page-copy" ? "Saving..." : "Save rotated left"}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={pdfBytes === null || isPreparingPageCopy}
          onClick={() => void downloadRotatedPageCopy("right")}
        >
          <Icons.Refresh /> {isPreparingPageCopy ? "Preparing..." : "Rotate right"}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={pdfBytes === null || isPreparingPageCopy}
          onClick={() => void saveRotatedPageCopyToDrive("right")}
        >
          <Icons.Upload />{" "}
          {driveSaveStatus === "saving-page-copy" ? "Saving..." : "Save rotated right"}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={
            pdfBytes === null ||
            isPreparingPageCopy ||
            pageCount === null ||
            pageCount <= 1 ||
            page <= 1
          }
          onClick={() => void downloadMovedPageCopy("earlier")}
        >
          <Icons.ChevronLeft /> Move page earlier
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={pdfBytes === null || isPreparingPageCopy || !canMoveCurrentPage("earlier")}
          onClick={() => void saveMovedPageCopyToDrive("earlier")}
        >
          <Icons.Upload />{" "}
          {driveSaveStatus === "saving-page-copy" ? "Saving..." : "Save moved earlier"}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={
            pdfBytes === null ||
            isPreparingPageCopy ||
            pageCount === null ||
            pageCount <= 1 ||
            page >= pageCount
          }
          onClick={() => void downloadMovedPageCopy("later")}
        >
          <Icons.ChevronRight /> Move page later
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={pdfBytes === null || isPreparingPageCopy || !canMoveCurrentPage("later")}
          onClick={() => void saveMovedPageCopyToDrive("later")}
        >
          <Icons.Upload />{" "}
          {driveSaveStatus === "saving-page-copy" ? "Saving..." : "Save moved later"}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={pdfBytes === null || isPreparingPageCopy || !hasReorderedPages}
          onClick={() => void downloadReorderedPageCopy()}
        >
          <Icons.Download /> Download reordered PDF
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={pdfBytes === null || isPreparingPageCopy || !hasReorderedPages}
          onClick={() => void saveReorderedPageCopyToDrive()}
        >
          <Icons.Upload />{" "}
          {driveSaveStatus === "saving-page-copy" ? "Saving..." : "Save reordered PDF"}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={pdfBytes === null || isPreparingPageCopy || pageCount === null}
          onClick={() => void downloadCurrentPageCopy()}
        >
          <Icons.Download /> Extract page
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={pdfBytes === null || isPreparingPageCopy || pageCount === null}
          onClick={() => void saveCurrentPageCopyToDrive()}
        >
          <Icons.Upload />{" "}
          {driveSaveStatus === "saving-page-copy" ? "Saving..." : "Save extracted page"}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={pdfBytes === null || isPreparingPageCopy || pageCount === null || pageCount < 1}
          onClick={() => void downloadSplitPageCopies()}
        >
          <Icons.Download /> Split pages
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={pdfBytes === null || isPreparingPageCopy || pageCount === null || pageCount < 1}
          onClick={() => void saveSplitPageCopiesToDrive()}
        >
          <Icons.Upload />{" "}
          {driveSaveStatus === "saving-page-copy" ? "Saving..." : "Save split pages"}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={
            pdfBytes === null || isPreparingPageCopy || pageCount === null || pageCount <= 1
          }
          onClick={() => void downloadWithoutCurrentPageCopy()}
        >
          <Icons.Trash /> Delete page
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={
            pdfBytes === null || isPreparingPageCopy || pageCount === null || pageCount <= 1
          }
          onClick={() => void saveWithoutCurrentPageCopyToDrive()}
        >
          <Icons.Upload />{" "}
          {driveSaveStatus === "saving-page-copy" ? "Saving..." : "Save without page"}
        </button>
        <label style={MERGE_PLACEMENT_STYLE}>
          <span>Placement</span>
          <select
            aria-label="PDF merge placement"
            value={mergePlacement}
            onChange={(event) => {
              setMergePlacement(event.currentTarget.value as PdfMergePlacement);
            }}
            style={MERGE_PLACEMENT_SELECT_STYLE}
          >
            <option value="append">Append to end</option>
            <option value="prepend">Prepend before first page</option>
            <option value="after-current-page">Insert after current page</option>
          </select>
        </label>
        <label className="btn sm" style={MERGE_FILE_BUTTON_STYLE}>
          <Icons.Upload /> Merge PDF
          <input
            aria-label="Merge PDF file"
            type="file"
            accept="application/pdf"
            disabled={pdfBytes === null || isPreparingPageCopy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              void downloadMergedPdfCopy(file, mergePlacement);
            }}
            style={HIDDEN_FILE_INPUT_STYLE}
          />
        </label>
        <label className="btn sm" style={MERGE_FILE_BUTTON_STYLE}>
          <Icons.Upload />{" "}
          {driveSaveStatus === "saving-page-copy" ? "Saving..." : "Save merged PDF"}
          <input
            aria-label="Save merged PDF file"
            type="file"
            accept="application/pdf"
            disabled={pdfBytes === null || isPreparingPageCopy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              void saveMergedPdfCopyToDrive(file, mergePlacement);
            }}
            style={HIDDEN_FILE_INPUT_STYLE}
          />
        </label>
        <a
          className="btn sm"
          href={`${contentUrl}?download=1`}
          download
          style={{ marginLeft: "auto" }}
        >
          <Icons.Download /> Download
        </a>
      </div>
      <div style={VIEWER_GRID_STYLE}>
        <div style={PDF_STAGE_STYLE} aria-label="PDF page canvas">
          {renderedPageStatus === "error" ? (
            <div role="alert" style={PDF_RENDER_STATUS_STYLE}>
              Could not render this PDF page.
            </div>
          ) : renderedPage === null ? (
            <div role="status" style={PDF_RENDER_STATUS_STYLE}>
              Rendering page...
            </div>
          ) : (
            <div
              aria-label="PDF rendered page layer"
              style={{
                ...PDF_PAGE_LAYER_STYLE,
                width: renderedPage.width,
                height: renderedPage.height,
              }}
            >
              <img
                aria-label="Rendered PDF page"
                src={renderedPage.dataUrl}
                width={renderedPage.width}
                height={renderedPage.height}
                decoding="async"
                data-page={renderedPage.pageNumber}
                data-zoom={renderedPage.zoom}
                style={PDF_RENDERED_PAGE_STYLE}
              />
              <div aria-label="PDF text layer" style={PDF_TEXT_LAYER_STYLE}>
                {renderedPage.textItems.map((item) => {
                  const searchMatch = currentPageTextSearchMatches.some(
                    (match) => match.id === item.id,
                  );
                  const selected =
                    selectedTextRange?.items.some((selectedItem) => selectedItem.id === item.id) ??
                    textSelectionStartId === item.id;
                  return (
                    <span
                      key={item.id}
                      data-pdf-text-item-id={item.id}
                      role={textSelectionMode ? "button" : undefined}
                      tabIndex={textSelectionMode ? 0 : undefined}
                      aria-label={
                        textSelectionMode
                          ? `PDF selectable text: ${item.text}`
                          : searchMatch
                            ? `PDF text match: ${item.text}`
                            : undefined
                      }
                      onClick={() => selectTextItem(item.id)}
                      onKeyDown={(event) => {
                        if (textSelectionMode && (event.key === "Enter" || event.key === " ")) {
                          event.preventDefault();
                          selectTextItem(item.id);
                        }
                      }}
                      style={{
                        ...PDF_TEXT_ITEM_STYLE,
                        ...(textSelectionMode ? PDF_TEXT_SELECTABLE_STYLE : {}),
                        ...(searchMatch ? PDF_TEXT_MATCH_STYLE : {}),
                        ...(activeTextMatch?.id === item.id ? PDF_TEXT_ACTIVE_MATCH_STYLE : {}),
                        ...(selected ? PDF_TEXT_SELECTED_STYLE : {}),
                        left: item.left,
                        top: item.top,
                        height: item.height,
                        fontSize: item.height,
                        ...(item.width === null ? {} : { width: item.width }),
                      }}
                    >
                      {item.text}
                    </span>
                  );
                })}
              </div>
              {currentPageTextAnchors.map(({ comment, anchor }) =>
                anchor.rects.map((rect, index) => (
                  <button
                    key={`${comment.id}-${String(index)}`}
                    type="button"
                    aria-label={`PDF text anchor: ${comment.body}`}
                    title={`${anchor.text}: ${comment.body}`}
                    style={{
                      ...PDF_TEXT_ANCHOR_STYLE,
                      left: `${String(rect.left)}%`,
                      top: `${String(rect.top)}%`,
                      width: `${String(rect.width)}%`,
                      height: `${String(rect.height)}%`,
                      ...(comment.id === selectedCommentId ? PDF_TEXT_ANCHOR_SELECTED_STYLE : {}),
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      selectComment(comment);
                    }}
                  />
                )),
              )}
              {isPlacingComment || isPlacingRedaction || isPlacingStamp || isDrawingFreehand ? (
                <div
                  aria-label="PDF placement overlay"
                  style={PDF_PLACEMENT_OVERLAY_STYLE}
                  onClick={
                    isPlacingComment
                      ? setCommentPointFromEvent
                      : isPlacingStamp
                        ? addStampFromEvent
                        : undefined
                  }
                  onPointerDown={(event) => {
                    startRedactionPlacement(event);
                    startFreehandAnnotation(event);
                  }}
                  onPointerMove={(event) => {
                    updateRedactionPlacement(event);
                    updateFreehandAnnotation(event);
                  }}
                  onPointerUp={(event) => {
                    finishRedactionPlacement(event);
                    finishFreehandAnnotation(event);
                  }}
                  onPointerCancel={() => {
                    setRedactionDragStart(null);
                    setFreehandDraft([]);
                    freehandDraftRef.current = [];
                  }}
                />
              ) : null}
              {currentPagePins.map((comment) => {
                const point = pointFromPdfComment(comment);
                if (point === null) {
                  return null;
                }
                return (
                  <button
                    key={comment.id}
                    type="button"
                    aria-label={`PDF comment pin: ${comment.body}`}
                    title={comment.body}
                    style={{
                      ...PDF_COMMENT_PIN_STYLE,
                      left: `${String(point.x)}%`,
                      top: `${String(point.y)}%`,
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      selectComment(comment);
                    }}
                    aria-pressed={comment.id === selectedCommentId}
                    data-selected={comment.id === selectedCommentId ? "true" : undefined}
                  >
                    <Icons.Comment size={14} />
                  </button>
                );
              })}
              {pendingCommentPoint !== null ? (
                <span
                  aria-label="Pending PDF comment pin"
                  style={{
                    ...PDF_PENDING_PIN_STYLE,
                    left: `${String(pendingCommentPoint.x)}%`,
                    top: `${String(pendingCommentPoint.y)}%`,
                  }}
                />
              ) : null}
              {currentPageStampAnnotations.map(({ comment, stamp }) => (
                <button
                  key={comment.id}
                  type="button"
                  aria-label={`PDF stamp annotation: ${comment.body}`}
                  title={comment.body}
                  style={{
                    ...PDF_STAMP_STYLE,
                    ...(comment.id === selectedCommentId ? PDF_STAMP_SELECTED_STYLE : {}),
                    left: `${String(stamp.x)}%`,
                    top: `${String(stamp.y)}%`,
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    selectComment(comment);
                  }}
                  aria-pressed={comment.id === selectedCommentId}
                  data-selected={comment.id === selectedCommentId ? "true" : undefined}
                >
                  {stamp.label}
                </button>
              ))}
              {currentPageRedactionAnnotations.map(({ comment, redaction }) => (
                <button
                  key={comment.id}
                  type="button"
                  aria-label={`PDF redaction annotation: ${comment.body}`}
                  title={comment.body}
                  style={{
                    ...PDF_REDACTION_RECT_STYLE,
                    ...PDF_REDACTION_ANNOTATION_STYLE,
                    ...(comment.id === selectedCommentId ? PDF_REDACTION_SELECTED_STYLE : {}),
                    left: `${String(redaction.x)}%`,
                    top: `${String(redaction.y)}%`,
                    width: `${String(redaction.width)}%`,
                    height: `${String(redaction.height)}%`,
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    selectComment(comment);
                  }}
                  aria-pressed={comment.id === selectedCommentId}
                />
              ))}
              {currentPageFreehandAnnotations.length > 0 || freehandDraft.length > 1 ? (
                <svg
                  aria-label="PDF freehand annotations"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  style={PDF_FREEHAND_LAYER_STYLE}
                >
                  {currentPageFreehandAnnotations.map(({ comment, stroke }) => (
                    <polyline
                      key={comment.id}
                      aria-label={`PDF freehand annotation: ${comment.body}`}
                      role="button"
                      tabIndex={0}
                      points={freehandSvgPoints(stroke.points)}
                      fill="none"
                      stroke={stroke.strokeColor}
                      strokeWidth={stroke.strokeWidth}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                      style={{
                        ...PDF_FREEHAND_PATH_STYLE,
                        ...(comment.id === selectedCommentId ? PDF_FREEHAND_SELECTED_STYLE : {}),
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        selectComment(comment);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selectComment(comment);
                        }
                      }}
                    />
                  ))}
                  {freehandDraft.length > 1 ? (
                    <polyline
                      aria-label="Pending PDF freehand annotation"
                      points={freehandSvgPoints(freehandDraft)}
                      fill="none"
                      stroke={PDF_FREEHAND_DEFAULT_COLOR}
                      strokeWidth={PDF_FREEHAND_DEFAULT_STROKE_WIDTH}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                      style={PDF_FREEHAND_DRAFT_STYLE}
                    />
                  ) : null}
                </svg>
              ) : null}
              {[
                ...currentPageRedactions,
                ...(redactionDraft === null ? [] : [{ pageNumber: page, ...redactionDraft }]),
              ].map((redaction, index) => (
                <span
                  key={`${String(redaction.pageNumber)}-${String(index)}-${String(
                    redaction.x,
                  )}-${String(redaction.y)}`}
                  aria-label="Pending PDF redaction"
                  style={{
                    ...PDF_REDACTION_RECT_STYLE,
                    left: `${String(redaction.x)}%`,
                    top: `${String(redaction.y)}%`,
                    width: `${String(redaction.width)}%`,
                    height: `${String(redaction.height)}%`,
                  }}
                />
              ))}
            </div>
          )}
          {isPlacingComment ? (
            <div style={PDF_PLACEMENT_HINT_STYLE}>Click the page to place this comment</div>
          ) : null}
          {isPlacingStamp ? (
            <div style={PDF_PLACEMENT_HINT_STYLE}>Click the page to place this review stamp</div>
          ) : null}
          {isPlacingRedaction ? (
            <div style={PDF_PLACEMENT_HINT_STYLE}>Drag on the page to size a redaction box</div>
          ) : null}
          {isDrawingFreehand ? (
            <div style={PDF_PLACEMENT_HINT_STYLE}>Draw on the page to add an annotation</div>
          ) : null}
        </div>
        <aside style={FORMS_PANEL_STYLE} aria-label="PDF form fields">
          <div style={PANEL_TITLE_STYLE}>Pages</div>
          {pageCount === null ? (
            <div role="status" style={PANEL_NOTE_STYLE}>
              Loading pages...
            </div>
          ) : (
            <div style={PAGES_STYLE} aria-label="PDF pages">
              {effectivePageOrder.map((pageNumber) => (
                <PageNavigationButton
                  key={pageNumber}
                  pageNumber={pageNumber}
                  selected={pageNumber === page}
                  thumbnail={thumbnailForPage(thumbnails, pageNumber)}
                  commentCount={commentCountForPage(openComments, pageNumber)}
                  reorderEnabled={pageCount > 1}
                  dragActive={pageNumber === draggedPageNumber}
                  onDragStart={() => setDraggedPageNumber(pageNumber)}
                  onDragOver={(event) => {
                    if (draggedPageNumber !== null && draggedPageNumber !== pageNumber) {
                      event.preventDefault();
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (draggedPageNumber !== null) {
                      reorderPages(draggedPageNumber, pageNumber);
                    }
                    setDraggedPageNumber(null);
                  }}
                  onDragEnd={() => setDraggedPageNumber(null)}
                  onSelect={() => setBoundedPage(pageNumber)}
                />
              ))}
            </div>
          )}
          <div style={PANEL_TITLE_STYLE}>Outline</div>
          {navigationStatus === "loading" ? (
            <div role="status" style={PANEL_NOTE_STYLE}>
              Loading outline...
            </div>
          ) : navigationStatus === "error" ? (
            <div style={PANEL_ERROR_STYLE}>Could not load PDF navigation.</div>
          ) : outline.length === 0 ? (
            <div style={PANEL_NOTE_STYLE}>No document outline.</div>
          ) : (
            <ol aria-label="PDF outline" style={OUTLINE_STYLE}>
              {outline.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-label={`Outline ${item.title}`}
                    aria-current={item.pageNumber === page ? "page" : undefined}
                    onClick={() => applyOutlineDestination(item)}
                    style={{
                      ...OUTLINE_BUTTON_STYLE,
                      paddingLeft: 8 + item.depth * 12,
                      borderColor: item.pageNumber === page ? "var(--accent)" : "var(--border)",
                    }}
                  >
                    <span className="truncate">{item.title}</span>
                    <span style={OUTLINE_PAGE_STYLE}>
                      p. {item.pageNumber}
                      {item.zoom === undefined ? "" : ` · ${String(item.zoom)}%`}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div style={PANEL_TITLE_STYLE}>Comments</div>
          <div style={PANEL_NOTE_STYLE}>Page-anchored review notes</div>
          <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>Status</span>
            <select
              aria-label="PDF comment status"
              value={commentStatusFilter}
              onChange={(event) => setCommentStatusFilter(event.target.value as PdfCommentStatus)}
              style={INPUT_STYLE}
            >
              <option value="open">Open</option>
              <option value="resolved">Resolved</option>
              <option value="all">All</option>
            </select>
          </label>
          <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>Page {page} comment</span>
            <textarea
              aria-label="PDF comment"
              value={commentDraft}
              onChange={(event) => setCommentDraft(event.target.value)}
              rows={3}
              style={TEXTAREA_STYLE}
            />
          </label>
          <div style={COMMENT_PIN_ROW_STYLE}>
            <button
              type="button"
              className="btn sm"
              aria-pressed={isPlacingComment}
              disabled={commentDraft.trim().length === 0}
              onClick={() => {
                setPlacingStamp(false);
                setDrawingFreehand(false);
                setFreehandDraft([]);
                freehandDraftRef.current = [];
                setPlacingComment((current) => !current);
              }}
            >
              <Icons.Pin /> Place pin
            </button>
            {pendingCommentPoint !== null ? (
              <span style={PIN_META_STYLE}>
                {formatPercent(pendingCommentPoint.x)}, {formatPercent(pendingCommentPoint.y)}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="btn sm"
            disabled={commentDraft.trim().length === 0}
            onClick={() => void addPageComment()}
          >
            Add comment
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={
              commentDraft.trim().length === 0 || activeTextMatch === null || renderedPage === null
            }
            onClick={() => void addTextMatchComment()}
          >
            Comment on match
          </button>
          <div style={COMMENT_PIN_ROW_STYLE}>
            <button
              type="button"
              className="btn sm"
              aria-pressed={textSelectionMode}
              disabled={renderedPage === null || renderedPage.textItems.length === 0}
              onClick={() => {
                setPlacingComment(false);
                setPlacingRedaction(false);
                setPlacingStamp(false);
                setDrawingFreehand(false);
                setFreehandDraft([]);
                freehandDraftRef.current = [];
                setTextSelectionMode((current) => !current);
              }}
            >
              Select text
            </button>
            {selectedTextRange === null ? null : (
              <span style={PIN_META_STYLE}>
                {selectedTextRange.items.length} item
                {selectedTextRange.items.length === 1 ? "" : "s"} selected
              </span>
            )}
            <button
              type="button"
              className="btn sm"
              disabled={renderedPage === null || renderedPage.textItems.length === 0}
              onMouseDown={(event) => event.preventDefault()}
              onClick={useBrowserTextSelection}
            >
              Use browser selection
            </button>
          </div>
          {selectedTextRange === null ? null : (
            <div style={PANEL_NOTE_STYLE} aria-label="Selected PDF text range">
              {selectedTextRange.text}
            </div>
          )}
          <div style={COMMENT_PIN_ROW_STYLE}>
            <button
              type="button"
              className="btn sm"
              disabled={selectedTextRange === null}
              onClick={() => void copySelectedTextRange()}
            >
              Copy selection
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={
                commentDraft.trim().length === 0 ||
                selectedTextRange === null ||
                renderedPage === null
              }
              onClick={() => void addTextSelectionComment()}
            >
              Comment on selection
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={
                !textSelectionMode && textSelectionStartId === null && textSelectionEndId === null
              }
              onClick={clearTextSelection}
            >
              Clear selection
            </button>
          </div>
          {textSelectionCopyStatus === "copied" ? (
            <div role="status" style={PANEL_NOTE_STYLE}>
              Copied selected PDF text.
            </div>
          ) : null}
          {textSelectionCopyStatus === "error" ? (
            <div role="alert" style={PANEL_ERROR_STYLE}>
              Could not copy selected PDF text.
            </div>
          ) : null}
          <div style={PANEL_TITLE_STYLE}>Redaction</div>
          <div style={PANEL_NOTE_STYLE}>Local copy redaction across pages</div>
          <div style={COMMENT_PIN_ROW_STYLE}>
            <button
              type="button"
              className="btn sm"
              aria-pressed={isPlacingRedaction}
              disabled={pdfBytes === null || isPreparingPageCopy}
              onClick={() => {
                setPlacingComment(false);
                setPlacingStamp(false);
                setDrawingFreehand(false);
                setFreehandDraft([]);
                freehandDraftRef.current = [];
                setRedactionDragStart(null);
                setPlacingRedaction((current) => !current);
              }}
            >
              <Icons.Pin /> Place redaction
            </button>
            {pendingRedactions.length > 0 ? (
              <span style={PIN_META_STYLE}>
                {pendingRedactions.length} region{pendingRedactions.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          {pendingRedactions.length > 0 ? (
            <ol aria-label="Pending PDF redactions" style={COMMENTS_STYLE}>
              {pendingRedactions.map((redaction, index) => (
                <li
                  key={`${String(redaction.pageNumber)}-${String(index)}-${String(
                    redaction.x,
                  )}-${String(redaction.y)}`}
                >
                  <button
                    type="button"
                    className="btn sm"
                    aria-label={`Remove pending PDF redaction ${String(index + 1)}`}
                    onClick={() =>
                      setPendingRedactions((current) =>
                        current.filter((_candidate, candidateIndex) => candidateIndex !== index),
                      )
                    }
                  >
                    <Icons.Trash size={14} />
                    Page {redaction.pageNumber} · {formatPercent(redaction.x)},{" "}
                    {formatPercent(redaction.y)}
                  </button>
                </li>
              ))}
            </ol>
          ) : null}
          {pendingRedactions.length > 1 ? (
            <button
              type="button"
              className="btn sm"
              aria-label="Clear pending PDF redactions"
              onClick={() => setPendingRedactions([])}
            >
              <Icons.Trash /> Clear redactions
            </button>
          ) : null}
          <button
            type="button"
            className="btn sm"
            disabled={pendingRedactions.length === 0 || commentsStatus === "loading"}
            onClick={() => void saveRedactionAnnotations()}
          >
            <Icons.Upload /> Save redaction annotations
          </button>
          <div style={PANEL_TITLE_STYLE}>Draw</div>
          <div style={PANEL_NOTE_STYLE}>Freehand review annotations</div>
          <button
            type="button"
            className="btn sm"
            aria-pressed={isDrawingFreehand}
            disabled={commentsStatus === "loading"}
            onClick={() => {
              setPlacingComment(false);
              setPlacingRedaction(false);
              setPlacingStamp(false);
              setRedactionDragStart(null);
              setRedactionDraft(null);
              setTextSelectionMode(false);
              setDrawingFreehand((current) => !current);
            }}
          >
            <Icons.EditPen /> Draw annotation
          </button>
          <div style={PANEL_TITLE_STYLE}>Stamps</div>
          <div style={PANEL_NOTE_STYLE}>Review-only annotations</div>
          <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>Stamp</span>
            <select
              aria-label="PDF review stamp"
              value={stampKind}
              onChange={(event) => setStampKind(event.target.value as PdfStampKind)}
              style={INPUT_STYLE}
            >
              {PDF_STAMP_DESCRIPTORS.map((stamp) => (
                <option key={stamp.kind} value={stamp.kind}>
                  {stamp.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn sm"
            aria-pressed={isPlacingStamp}
            disabled={commentsStatus === "loading"}
            onClick={() => {
              setPlacingComment(false);
              setPlacingRedaction(false);
              setDrawingFreehand(false);
              setFreehandDraft([]);
              freehandDraftRef.current = [];
              setRedactionDragStart(null);
              setTextSelectionMode(false);
              setPlacingStamp((current) => !current);
            }}
          >
            <Icons.Tag /> Place stamp
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={
              pdfBytes === null || isPreparingPageCopy || activeStampAnnotations.length === 0
            }
            onClick={() => void downloadStampedCopy()}
          >
            <Icons.Download /> Download stamped copy
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={
              pdfBytes === null || isPreparingPageCopy || activeStampAnnotations.length === 0
            }
            onClick={() => void saveStampedCopyToDrive()}
          >
            <Icons.Upload />{" "}
            {driveSaveStatus === "saving-stamped" ? "Saving..." : "Save stamped copy to Drive"}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={pdfBytes === null || isPreparingPageCopy || pendingRedactions.length === 0}
            onClick={() => void downloadRedactedCopy()}
          >
            <Icons.Download /> Download redacted copy
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={pdfBytes === null || isPreparingPageCopy || pendingRedactions.length === 0}
            onClick={() => void saveRedactedCopyToDrive()}
          >
            <Icons.Upload />{" "}
            {driveSaveStatus === "saving-redacted" ? "Saving..." : "Save redacted copy to Drive"}
          </button>
          {driveSaveStatus === "saved" ? (
            <div role="status" style={PANEL_NOTE_STYLE}>
              Saved PDF copy to Drive.
            </div>
          ) : null}
          {driveSaveStatus === "error" ? (
            <div role="alert" style={PANEL_ERROR_STYLE}>
              Could not save PDF copy to Drive.
            </div>
          ) : null}
          {commentsStatus === "loading" ? (
            <div role="status" style={PANEL_NOTE_STYLE}>
              Loading comments...
            </div>
          ) : commentsStatus === "error" ? (
            <div role="alert" style={PANEL_ERROR_STYLE}>
              Could not load PDF comments.
            </div>
          ) : linkedCommentUnavailable ? (
            <div role="status" style={PANEL_NOTE_STYLE}>
              Linked PDF comment is unavailable or no longer visible.
              <button
                type="button"
                className="btn sm"
                style={INLINE_PANEL_BUTTON_STYLE}
                onClick={clearLinkedComment}
              >
                Clear link
              </button>
            </div>
          ) : commentThreads.length === 0 ? (
            <div style={PANEL_NOTE_STYLE}>{emptyCommentsLabel(commentStatusFilter)}</div>
          ) : (
            <ol style={COMMENTS_STYLE} aria-label="PDF comments">
              {commentThreads.map(({ comment, replies }) => {
                const openReplyCount = replies.filter((reply) => reply.status === "open").length;
                return (
                  <li
                    key={comment.id}
                    ref={(element) => {
                      commentRefs.current[comment.id] = element;
                    }}
                    aria-current={selectedThreadId === comment.id ? "true" : undefined}
                    style={{
                      ...COMMENT_STYLE,
                      ...(selectedThreadId === comment.id ? COMMENT_SELECTED_STYLE : {}),
                    }}
                  >
                    <div style={COMMENT_HEADER_STYLE}>
                      <button
                        type="button"
                        style={COMMENT_PAGE_BUTTON_STYLE}
                        onClick={() => selectComment(comment)}
                      >
                        {commentAnchorLabel(comment)}
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Copy comment link: ${comment.body}`}
                        onClick={() => void copyCommentLink(comment)}
                      >
                        <Icons.Link size={14} />
                      </button>
                      {pdfCommentHasAnnotationAnchor(comment) ? (
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Copy annotation link: ${comment.body}`}
                          onClick={() => void copyAnnotationLink(comment)}
                        >
                          <Icons.Link size={14} />
                        </button>
                      ) : null}
                    </div>
                    <div style={COMMENT_META_STYLE}>{commentAuthorLabel(comment)}</div>
                    {editingCommentId === comment.id ? (
                      <form
                        style={REPLY_FORM_STYLE}
                        onSubmit={(event) => {
                          event.preventDefault();
                          void saveCommentEdit(comment);
                        }}
                      >
                        <label style={LABEL_STYLE} htmlFor={`pdf-comment-edit-${comment.id}`}>
                          Edit comment
                        </label>
                        <textarea
                          id={`pdf-comment-edit-${comment.id}`}
                          aria-label={`Edit PDF comment: ${comment.body}`}
                          value={editCommentDraft}
                          onChange={(event) => setEditCommentDraft(event.target.value)}
                          rows={2}
                          style={TEXTAREA_STYLE}
                        />
                        <div style={COMMENT_ACTIONS_STYLE}>
                          <button
                            type="submit"
                            className="btn primary sm"
                            disabled={editCommentDraft.trim().length === 0}
                          >
                            Save comment
                          </button>
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() => {
                              setEditingCommentId(null);
                              setEditCommentDraft("");
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <p style={COMMENT_BODY_STYLE}>{comment.body}</p>
                    )}
                    {replies.length > 0 ? (
                      <ol style={REPLY_LIST_STYLE} aria-label={`Replies to ${comment.body}`}>
                        {replies.map((reply) => (
                          <li key={reply.id} style={REPLY_STYLE}>
                            <div style={REPLY_HEADER_STYLE}>
                              <div style={COMMENT_META_STYLE}>{commentAuthorLabel(reply)}</div>
                              <div style={COMMENT_ACTIONS_STYLE}>
                                <button
                                  type="button"
                                  className="btn sm"
                                  aria-label={`Edit reply: ${reply.body}`}
                                  onClick={() => startEditingComment(reply)}
                                >
                                  Edit reply
                                </button>
                                <button
                                  type="button"
                                  className="btn sm"
                                  aria-label={`Delete reply: ${reply.body}`}
                                  onClick={() => void deleteComment(reply)}
                                >
                                  Delete reply
                                </button>
                                {reply.status === "open" ? (
                                  <button
                                    type="button"
                                    className="btn sm"
                                    aria-label={`Resolve reply: ${reply.body}`}
                                    onClick={() => void resolveComment(reply.id)}
                                  >
                                    Resolve reply
                                  </button>
                                ) : (
                                  <>
                                    <span style={RESOLVED_STYLE}>Resolved</span>
                                    <button
                                      type="button"
                                      className="btn sm"
                                      aria-label={`Reopen reply: ${reply.body}`}
                                      onClick={() => void reopenComment(reply.id)}
                                    >
                                      Reopen reply
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                            {editingCommentId === reply.id ? (
                              <form
                                style={REPLY_FORM_STYLE}
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  void saveCommentEdit(reply);
                                }}
                              >
                                <label style={LABEL_STYLE} htmlFor={`pdf-comment-edit-${reply.id}`}>
                                  Edit reply
                                </label>
                                <textarea
                                  id={`pdf-comment-edit-${reply.id}`}
                                  aria-label={`Edit PDF reply: ${reply.body}`}
                                  value={editCommentDraft}
                                  onChange={(event) => setEditCommentDraft(event.target.value)}
                                  rows={2}
                                  style={TEXTAREA_STYLE}
                                />
                                <div style={COMMENT_ACTIONS_STYLE}>
                                  <button
                                    type="submit"
                                    className="btn primary sm"
                                    disabled={editCommentDraft.trim().length === 0}
                                  >
                                    Save comment
                                  </button>
                                  <button
                                    type="button"
                                    className="btn sm"
                                    onClick={() => {
                                      setEditingCommentId(null);
                                      setEditCommentDraft("");
                                    }}
                                  >
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
                    {comment.status === "open" ? (
                      <>
                        <label style={FIELD_STYLE}>
                          <span style={LABEL_STYLE}>Reply</span>
                          <textarea
                            aria-label={`Reply to ${comment.body}`}
                            value={replyDrafts[comment.id] ?? ""}
                            onChange={(event) =>
                              setReplyDrafts((current) => ({
                                ...current,
                                [comment.id]: event.target.value,
                              }))
                            }
                            rows={2}
                            style={TEXTAREA_STYLE}
                          />
                        </label>
                        <div style={COMMENT_ACTIONS_STYLE}>
                          <button
                            type="button"
                            className="btn sm"
                            disabled={(replyDrafts[comment.id] ?? "").trim().length === 0}
                            onClick={() => void addReply(comment)}
                          >
                            Reply
                          </button>
                          {openReplyCount > 0 ? (
                            <button
                              type="button"
                              className="btn sm"
                              onClick={() => void resolveCommentThread(comment, replies)}
                            >
                              Resolve thread
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="btn sm"
                            aria-label={`Edit comment: ${comment.body}`}
                            onClick={() => startEditingComment(comment)}
                          >
                            Edit comment
                          </button>
                          <button
                            type="button"
                            className="btn sm"
                            aria-label={`Delete comment: ${comment.body}`}
                            onClick={() => void deleteComment(comment)}
                          >
                            Delete comment
                          </button>
                          <button
                            type="button"
                            className="btn sm"
                            aria-label={`Resolve comment: ${comment.body}`}
                            onClick={() => void resolveComment(comment.id)}
                          >
                            Resolve
                          </button>
                        </div>
                      </>
                    ) : (
                      <div style={COMMENT_ACTIONS_STYLE}>
                        <span style={RESOLVED_STYLE}>Resolved</span>
                        <button
                          type="button"
                          className="btn sm"
                          aria-label={`Edit comment: ${comment.body}`}
                          onClick={() => startEditingComment(comment)}
                        >
                          Edit comment
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          aria-label={`Delete comment: ${comment.body}`}
                          onClick={() => void deleteComment(comment)}
                        >
                          Delete comment
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          aria-label={`Reopen comment: ${comment.body}`}
                          onClick={() => void reopenComment(comment.id)}
                        >
                          Reopen
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          <div style={PANEL_TITLE_STYLE}>Forms</div>
          {formStatus === "loading" ? (
            <div role="status" style={PANEL_NOTE_STYLE}>
              Loading fields...
            </div>
          ) : formStatus === "error" ? (
            <div role="alert" style={PANEL_ERROR_STYLE}>
              {formError ?? "Could not inspect PDF fields."}
            </div>
          ) : fields.length === 0 ? (
            <div style={PANEL_NOTE_STYLE}>No fillable fields detected.</div>
          ) : (
            <>
              <div style={FIELDS_STYLE}>
                {fields.map((field) => (
                  <PdfFormFieldControl
                    key={field.name}
                    field={field}
                    validationError={requiredFormErrors.find((error) => error.name === field.name)}
                    onChange={(value) => updateField(field.name, value)}
                  />
                ))}
              </div>
              {formError !== null ? (
                <div role="alert" style={PANEL_ERROR_STYLE}>
                  {formError}
                </div>
              ) : null}
              <button
                type="button"
                className="btn sm primary"
                disabled={pdfBytes === null || isPreparingDownload}
                onClick={() => void downloadFilledCopy()}
              >
                <Icons.Download /> {isPreparingDownload ? "Preparing..." : "Download filled copy"}
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={pdfBytes === null || isPreparingDownload}
                onClick={() => void saveFilledCopyToDrive()}
              >
                <Icons.Upload />{" "}
                {driveSaveStatus === "saving-filled" ? "Saving..." : "Save filled copy to Drive"}
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={fields.length === 0 || formStateStatus === "saving"}
                onClick={() => void saveFormStateDraft()}
              >
                {formStateStatus === "saving" ? "Saving draft..." : "Save draft"}
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={fields.length === 0 || formStateStatus === "clearing"}
                onClick={() => void clearFormStateDraft()}
              >
                {formStateStatus === "clearing" ? "Clearing draft..." : "Clear draft"}
              </button>
              {formStateStatus === "restored-stale" ? (
                <button
                  type="button"
                  className="btn sm"
                  disabled={pdfDefaultFields.length === 0}
                  onClick={() => void useCurrentPdfDefaults()}
                >
                  <Icons.Refresh /> Use PDF defaults
                </button>
              ) : null}
              {formStateStatus !== "idle" ? (
                <div
                  role={formStateStatus === "error" ? "alert" : "status"}
                  style={formStateStatus === "error" ? PANEL_ERROR_STYLE : PANEL_NOTE_STYLE}
                >
                  {pdfFormStateStatusMessage(formStateStatus)}
                </div>
              ) : null}
              {staleFormFieldConflicts.length > 0 ? (
                <div aria-label="PDF stale draft field conflicts" style={PDF_FIELD_CONFLICTS_STYLE}>
                  {staleFormFieldConflicts.map((conflict) => (
                    <div key={conflict.name} style={PDF_FIELD_CONFLICT_ROW_STYLE}>
                      <span style={{ fontWeight: 600 }}>{conflict.label}</span>
                      <span>PDF default: {conflict.defaultValue}</span>
                      <span>Saved draft: {conflict.draftValue}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {driveSaveStatus === "saved" ? (
                <div role="status" style={PANEL_NOTE_STYLE}>
                  Saved PDF copy to Drive.
                </div>
              ) : null}
              {driveSaveStatus === "error" ? (
                <div role="alert" style={PANEL_ERROR_STYLE}>
                  Could not save PDF copy to Drive.
                </div>
              ) : null}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

interface PdfFieldDraft {
  readonly name: string;
  readonly type: "text" | "checkbox" | "choice" | "signature" | "unsupported";
  readonly label: string;
  readonly value: string | boolean;
  readonly options: readonly string[];
  readonly required: boolean;
}

interface PdfFieldValidationError {
  readonly name: string;
  readonly label: string;
  readonly message: string;
}

interface PdfFieldConflict {
  readonly name: string;
  readonly label: string;
  readonly defaultValue: string;
  readonly draftValue: string;
}

interface PdfCommentPoint {
  readonly x: number;
  readonly y: number;
}

export interface PdfRedactionRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface PdfPendingRedaction extends PdfRedactionRect {
  readonly pageNumber: number;
}

type PdfStampKind = "approved" | "needs-review" | "sign-here";

interface PdfStampDescriptor {
  readonly kind: PdfStampKind;
  readonly label: string;
}

interface PdfStampAnnotation extends PdfCommentPoint {
  readonly pageNumber: number;
  readonly kind: PdfStampKind;
  readonly label: string;
}

interface PdfFreehandAnnotation {
  readonly pageNumber: number;
  readonly points: readonly PdfCommentPoint[];
  readonly strokeColor: string;
  readonly strokeWidth: number;
}

const PDF_STAMP_DESCRIPTORS = [
  { kind: "approved", label: "Approved" },
  { kind: "needs-review", label: "Needs review" },
  { kind: "sign-here", label: "Sign here" },
] as const satisfies readonly PdfStampDescriptor[];
const PDF_FREEHAND_DEFAULT_COLOR = "#2563eb";
const PDF_FREEHAND_DEFAULT_STROKE_WIDTH = 3;
const PDF_STAMP_PDF_FONT_SIZE = 10;
const PDF_STAMP_PDF_PADDING_X = 8;
const PDF_STAMP_PDF_PADDING_Y = 6;
const PDF_STAMP_PDF_HEIGHT = 22;
const PDF_SIGNATURE_PDF_FONT_SIZE = 11;
const PDF_SIGNATURE_PDF_PADDING_X = 10;
const PDF_SIGNATURE_PDF_PADDING_Y = 8;
const PDF_SIGNATURE_PDF_HEIGHT = 42;
const PDF_SIGNATURE_PDF_WIDTH = 260;

function PdfFormFieldControl({
  field,
  validationError,
  onChange,
}: {
  readonly field: PdfFieldDraft;
  readonly validationError?: PdfFieldValidationError | undefined;
  readonly onChange: (value: string | boolean) => void;
}) {
  const label = field.required ? `${field.label} required` : field.label;
  const invalid = validationError !== undefined;
  if (field.type === "checkbox") {
    return (
      <label style={CHECKBOX_FIELD_STYLE}>
        <input
          aria-label={field.label}
          type="checkbox"
          checked={field.value === true}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
        {validationError === undefined ? null : (
          <span style={PDF_FIELD_VALIDATION_STYLE}>{validationError.message}</span>
        )}
      </label>
    );
  }

  if (field.type === "choice" && field.options.length > 0) {
    return (
      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>{label}</span>
        <select
          aria-label={field.label}
          value={String(field.value)}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value)}
          style={INPUT_STYLE}
        >
          <option value="">None</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {validationError === undefined ? null : (
          <span style={PDF_FIELD_VALIDATION_STYLE}>{validationError.message}</span>
        )}
      </label>
    );
  }

  return (
    <label style={FIELD_STYLE}>
      <span style={LABEL_STYLE}>{label}</span>
      <input
        aria-label={field.label}
        value={typeof field.value === "string" ? field.value : ""}
        disabled={field.type === "unsupported"}
        aria-invalid={invalid}
        onChange={(event) => onChange(event.target.value)}
        style={INPUT_STYLE}
      />
      {validationError === undefined ? null : (
        <span style={PDF_FIELD_VALIDATION_STYLE}>{validationError.message}</span>
      )}
    </label>
  );
}

function clearSavedPdfFormState(objectId: string): boolean {
  try {
    window.localStorage.removeItem(pdfFormStateStorageKey(objectId));
    return true;
  } catch {
    return false;
  }
}

function restoreSavedPdfFormState(
  objectId: string,
  fields: readonly PdfFieldDraft[],
): readonly PdfFieldDraft[] {
  try {
    const raw = window.localStorage.getItem(pdfFormStateStorageKey(objectId));
    if (raw === null) {
      return fields;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as Record<string, unknown>).fields)
    ) {
      return fields;
    }
    return restorePdfFormStateValues(
      fields,
      ((parsed as Record<string, unknown>).fields as unknown[]).filter(isSavedPdfFieldValue),
    );
  } catch {
    return fields;
  }
}

function restorePdfFormStateValues(
  fields: readonly PdfFieldDraft[],
  savedFields: readonly PdfFormStateFieldValue[],
): readonly PdfFieldDraft[] {
  const savedValues = new Map(savedFields.map((field) => [field.name, field.value] as const));
  let restored = false;
  const nextFields = fields.map((field) => {
    const value = savedValues.get(field.name);
    if (value === undefined || typeof value !== typeof field.value) {
      return field;
    }
    restored = true;
    return { ...field, value };
  });
  return restored ? nextFields : fields;
}

function pdfFormStateFieldValue(field: PdfFieldDraft): PdfFormStateFieldValue {
  return {
    name: field.name,
    type: field.type,
    value: field.value,
  };
}

function pdfFormFieldConflicts(
  defaultFields: readonly PdfFieldDraft[],
  draftFields: readonly PdfFieldDraft[],
): readonly PdfFieldConflict[] {
  const defaultsByName = new Map(defaultFields.map((field) => [field.name, field] as const));
  return draftFields.flatMap((draftField): readonly PdfFieldConflict[] => {
    const defaultField = defaultsByName.get(draftField.name);
    if (
      defaultField === undefined ||
      defaultField.type !== draftField.type ||
      defaultField.value === draftField.value
    ) {
      return [];
    }
    return [
      {
        name: draftField.name,
        label: draftField.label,
        defaultValue: formatPdfFieldValue(defaultField.value, defaultField.type),
        draftValue: formatPdfFieldValue(draftField.value, draftField.type),
      },
    ];
  });
}

function formatPdfFieldValue(value: string | boolean, type: PdfFieldDraft["type"]): string {
  if (type === "checkbox") {
    return value === true ? "Yes" : "No";
  }
  const text = String(value).trim();
  return text.length === 0 ? "Blank" : text;
}

function isSavedPdfFieldValue(value: unknown): value is {
  readonly name: string;
  readonly value: string | boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).name === "string" &&
    (typeof (value as Record<string, unknown>).value === "string" ||
      typeof (value as Record<string, unknown>).value === "boolean")
  );
}

function pdfFormStateStorageKey(objectId: string): string {
  return `helix.pdf.form-state:${objectId}`;
}

function pdfFormStateStatusMessage(status: Exclude<PdfFormStateStatus, "idle">): string {
  if (status === "restored") {
    return "Restored saved draft.";
  }
  if (status === "restored-stale") {
    return "Restored saved draft from an earlier PDF version.";
  }
  if (status === "saving") {
    return "Saving draft...";
  }
  if (status === "saved") {
    return "Saved draft.";
  }
  if (status === "clearing") {
    return "Clearing draft...";
  }
  if (status === "cleared") {
    return "Cleared draft.";
  }
  if (status === "defaulted") {
    return "Using current PDF defaults.";
  }
  return "Could not update saved draft.";
}

function validatePdfFormFields(
  fields: readonly PdfFieldDraft[],
): readonly PdfFieldValidationError[] {
  return fields.flatMap((field): readonly PdfFieldValidationError[] => {
    if (!field.required || !isBlankPdfField(field)) {
      return [];
    }
    return [
      {
        name: field.name,
        label: field.label,
        message: "Required field is blank.",
      },
    ];
  });
}

function requiredPdfFormError(errors: readonly PdfFieldValidationError[]): string {
  const names = errors.map((error) => error.label).join(", ");
  return `Complete required PDF fields before exporting: ${names}.`;
}

function isBlankPdfField(field: PdfFieldDraft): boolean {
  if (field.type === "checkbox") {
    return field.value !== true;
  }
  return typeof field.value !== "string" || field.value.trim().length === 0;
}

function fieldDraftFromPdfField(field: PdfField): PdfFieldDraft {
  const name = field.getName();
  const label = name || "Untitled field";
  const required = field.isRequired?.() === true;
  if (isPdfTextField(field)) {
    return {
      name,
      label,
      type: "text",
      value: field.getText() ?? "",
      options: [],
      required,
    };
  }
  if (isPdfCheckBox(field)) {
    return {
      name,
      label,
      type: "checkbox",
      value: field.isChecked(),
      options: [],
      required,
    };
  }
  if (isPdfOptionField(field)) {
    return {
      name,
      label,
      type: "choice",
      value: field.getSelected()[0] ?? "",
      options: field.getOptions(),
      required,
    };
  }
  if (isPdfSignatureField(field)) {
    return {
      name,
      label,
      type: "signature",
      value: "",
      options: [],
      required,
    };
  }
  return {
    name,
    label,
    type: "unsupported",
    value: "",
    options: [],
    required,
  };
}

function applyFieldDraft(field: PdfField, draft: PdfFieldDraft) {
  if (draft.type === "text" && isPdfTextField(field)) {
    field.setText(String(draft.value));
    return;
  }
  if (draft.type === "checkbox" && isPdfCheckBox(field)) {
    if (draft.value === true) {
      field.check();
    } else {
      field.uncheck();
    }
    return;
  }
  if (draft.type === "choice" && isPdfOptionField(field)) {
    const value = String(draft.value).trim();
    if (value.length > 0) {
      field.select(value);
    }
  }
}

function drawPdfSignatureAppearances(
  document: PdfDrawableDocument,
  fields: readonly PdfFieldDraft[],
): void {
  const signedFields = fields.filter(isFilledPdfSignatureField);
  if (signedFields.length === 0) {
    return;
  }
  const targetPage = document.getPage(0);
  const pageWidth = targetPage.getWidth();
  const pageHeight = targetPage.getHeight();
  signedFields.forEach((field, index) => {
    const bounds = pdfSignatureBounds(index, pageWidth, pageHeight);
    targetPage.drawRectangle({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      color: rgb(1, 1, 1),
      borderColor: rgb(0.06, 0.09, 0.16),
      borderWidth: 1.2,
      opacity: 0.92,
    });
    targetPage.drawText(field.label, {
      x: bounds.x + PDF_SIGNATURE_PDF_PADDING_X,
      y: bounds.y + bounds.height - PDF_SIGNATURE_PDF_PADDING_Y - 9,
      size: 8,
      color: rgb(0.3, 0.36, 0.46),
      maxWidth: bounds.width - PDF_SIGNATURE_PDF_PADDING_X * 2,
    });
    targetPage.drawText(`Signature intent: ${String(field.value).trim()}`, {
      x: bounds.x + PDF_SIGNATURE_PDF_PADDING_X,
      y: bounds.y + PDF_SIGNATURE_PDF_PADDING_Y,
      size: PDF_SIGNATURE_PDF_FONT_SIZE,
      color: rgb(0.06, 0.09, 0.16),
      maxWidth: bounds.width - PDF_SIGNATURE_PDF_PADDING_X * 2,
    });
  });
}

function isFilledPdfSignatureField(field: PdfFieldDraft): boolean {
  return field.type === "signature" && typeof field.value === "string" && field.value.trim() !== "";
}

function pdfSignatureBounds(
  index: number,
  pageWidth: number,
  pageHeight: number,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const width = Math.min(PDF_SIGNATURE_PDF_WIDTH, Math.max(120, pageWidth - 24));
  const height = Math.min(PDF_SIGNATURE_PDF_HEIGHT, Math.max(24, pageHeight - 24));
  const x = clampNumber(12, 4, pageWidth - width - 4);
  const y = clampNumber(12 + index * (height + 8), 4, pageHeight - height - 4);
  return { x, y, width, height };
}

interface PdfField {
  getName(): string;
  isRequired?: () => boolean;
}

interface PdfTextField extends PdfField {
  getText(): string | undefined;
  setText(value: string): void;
}

interface PdfCheckBox extends PdfField {
  isChecked(): boolean;
  check(): void;
  uncheck(): void;
}

interface PdfOptionField extends PdfField {
  getOptions(): string[];
  getSelected(): string[];
  select(value: string): void;
}

interface PdfSignatureField extends PdfField {
  needsAppearancesUpdate?: () => boolean;
}

interface PdfDrawableDocument {
  getPage(index: number): PdfDrawablePage;
}

interface PdfDrawablePage {
  getWidth(): number;
  getHeight(): number;
  drawRectangle(options: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly color: Color;
    readonly borderColor: Color;
    readonly borderWidth: number;
    readonly opacity?: number;
  }): void;
  drawText(
    text: string,
    options: {
      readonly x: number;
      readonly y: number;
      readonly size: number;
      readonly color: Color;
      readonly maxWidth?: number;
    },
  ): void;
}

function isPdfTextField(field: PdfField): field is PdfTextField {
  return "getText" in field && "setText" in field;
}

function isPdfCheckBox(field: PdfField): field is PdfCheckBox {
  return "isChecked" in field && "check" in field && "uncheck" in field;
}

function isPdfOptionField(field: PdfField): field is PdfOptionField {
  return "getOptions" in field && "getSelected" in field && "select" in field;
}

function isPdfSignatureField(field: PdfField): field is PdfSignatureField {
  const constructorName =
    typeof field.constructor === "function" ? field.constructor.name : undefined;
  return constructorName === "PDFSignature" || "needsAppearancesUpdate" in field;
}

function documentNode(): Document {
  return globalThis.document;
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = documentNode().createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function pdfBytesToBlob(bytes: Uint8Array): Blob {
  const bytesView = new Uint8Array(bytes);
  const buffer = bytesView.buffer.slice(
    bytesView.byteOffset,
    bytesView.byteOffset + bytesView.byteLength,
  );
  return new Blob([buffer], { type: "application/pdf" });
}

function browserWindow(): Window | null {
  return typeof window === "undefined" ? null : window;
}

function normalizePdfRotation(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

function buildPdfViewLink(
  state: NativePdfViewRouteState & { readonly annotationId?: string | null },
): string {
  const windowNode = browserWindow();
  const nextUrl =
    windowNode === null ? new URL("http://localhost/pdf") : new URL(windowNode.location.href);
  nextUrl.searchParams.set("page", String(state.page));
  nextUrl.searchParams.set("zoom", String(state.zoom));
  if (state.annotationId !== undefined && state.annotationId !== null) {
    nextUrl.searchParams.set("annotation", state.annotationId);
    nextUrl.searchParams.delete("comment");
  } else if (state.commentId === null) {
    nextUrl.searchParams.delete("annotation");
    nextUrl.searchParams.delete("comment");
  } else {
    nextUrl.searchParams.delete("annotation");
    nextUrl.searchParams.set("comment", state.commentId);
  }
  if (state.sourceFolderId === null) {
    nextUrl.searchParams.delete("folder");
  } else {
    nextUrl.searchParams.set("folder", state.sourceFolderId);
  }
  return nextUrl.href;
}

async function writeClipboardText(value: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (clipboard === undefined) {
    return;
  }
  await clipboard.writeText(value);
}

function focusPdfControl(controlId: string): void {
  document.getElementById(controlId)?.focus();
}

function pdfDownloadFileStem(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 80) || "pdf"
  );
}

function filledCopyFilename(objectId: string): string {
  return `${pdfDownloadFileStem(objectId)}-filled.pdf`;
}

function redactedCopyFilename(objectId: string): string {
  return `${pdfDownloadFileStem(objectId)}-redacted.pdf`;
}

function stampedCopyFilename(objectId: string): string {
  return `${pdfDownloadFileStem(objectId)}-stamped.pdf`;
}

function rotatedPageCopyFilename(
  objectId: string,
  page: number,
  direction: "left" | "right",
): string {
  return `${pdfDownloadFileStem(objectId)}-page-${String(page)}-rotated-${direction}.pdf`;
}

function movedPageCopyFilename(
  objectId: string,
  page: number,
  direction: "earlier" | "later",
): string {
  return `${pdfDownloadFileStem(objectId)}-page-${String(page)}-moved-${direction}.pdf`;
}

function reorderedPageCopyFilename(objectId: string): string {
  return `${pdfDownloadFileStem(objectId)}-reordered.pdf`;
}

interface ReorderablePdfDocument<TPage> {
  readonly getPage: (index: number) => TPage;
  readonly removePage: (index: number) => void;
  readonly insertPage: (index: number, page: TPage) => void;
}

function applyPageOrderToPdfDocument<TPage>(
  pdfDocument: ReorderablePdfDocument<TPage>,
  pageOrder: readonly number[],
): void {
  const currentOrder = defaultPageOrder(pageOrder.length);
  pageOrder.forEach((pageNumber, targetIndex) => {
    const currentIndex = currentOrder.indexOf(pageNumber);
    if (currentIndex === -1 || currentIndex === targetIndex) {
      return;
    }
    const movedPage = pdfDocument.getPage(currentIndex);
    pdfDocument.removePage(currentIndex);
    pdfDocument.insertPage(targetIndex, movedPage);
    currentOrder.splice(currentIndex, 1);
    currentOrder.splice(targetIndex, 0, pageNumber);
  });
}

function currentPageCopyFilename(objectId: string, page: number): string {
  return `${pdfDownloadFileStem(objectId)}-page-${String(page)}.pdf`;
}

function withoutCurrentPageCopyFilename(objectId: string, page: number): string {
  return `${pdfDownloadFileStem(objectId)}-without-page-${String(page)}.pdf`;
}

function mergedPdfCopyFilename(objectId: string): string {
  return `${pdfDownloadFileStem(objectId)}-merged.pdf`;
}

function splitPagesZipFilename(objectId: string): string {
  return `${pdfDownloadFileStem(objectId)}-split-pages.zip`;
}

interface PdfZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

function zipStorePdfEntries(entries: readonly PdfZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.data.byteLength, true);
    localView.setUint32(22, entry.data.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    localView.setUint16(28, 0, true);
    localParts.push(local, name, entry.data);

    const central = new Uint8Array(46);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.data.byteLength, true);
    centralView.setUint32(24, entry.data.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralParts.push(central, name);
    offset += local.byteLength + name.byteLength + entry.data.byteLength;
  }

  const centralSize = centralParts.reduce((size, part) => size + part.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);
  return concatUint8Arrays([...localParts, ...centralParts, end]);
}

function concatUint8Arrays(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((size, part) => size + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function commentCountForPage(comments: readonly PdfDriveComment[], page: number): number {
  return comments.filter((comment) => pageFromPdfComment(comment) === page).length;
}

function defaultPageOrder(pageCount: number | null): number[] {
  return pageCount === null ? [] : Array.from({ length: pageCount }, (_, index) => index + 1);
}

function pageOrderForPageCount(
  pageOrder: readonly number[],
  pageCount: number | null,
): readonly number[] {
  if (pageCount === null) {
    return [];
  }
  const expected = defaultPageOrder(pageCount);
  return pageOrder.length === pageCount &&
    expected.every((pageNumber) => pageOrder.includes(pageNumber))
    ? pageOrder
    : expected;
}

function pageOrderChanged(pageOrder: readonly number[]): boolean {
  return pageOrder.some((pageNumber, index) => pageNumber !== index + 1);
}

function reorderPageOrder(
  pageOrder: readonly number[],
  draggedPage: number,
  targetPage: number,
): readonly number[] {
  const current = [...pageOrder];
  const fromIndex = current.indexOf(draggedPage);
  const toIndex = current.indexOf(targetPage);
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
    return current;
  }
  current.splice(fromIndex, 1);
  current.splice(toIndex, 0, draggedPage);
  return current;
}

function pageFromPdfComment(comment: PdfDriveComment): number {
  const page = comment.anchor.page;
  return typeof page === "number" && Number.isInteger(page) && page > 0 ? page : 1;
}

function pointFromPdfComment(comment: PdfDriveComment): PdfCommentPoint | null {
  const { x, y } = comment.anchor;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > 100 ||
    y < 0 ||
    y > 100
  ) {
    return null;
  }
  return { x, y };
}

function pdfCommentHasAnnotationAnchor(comment: PdfDriveComment): boolean {
  return (
    textAnchorFromPdfComment(comment) !== null ||
    redactionFromPdfComment(comment) !== null ||
    stampFromPdfComment(comment) !== null ||
    freehandFromPdfComment(comment) !== null ||
    pointFromPdfComment(comment) !== null
  );
}

function pdfCommentAnchor({
  objectId,
  page,
  pageCount,
  point,
}: {
  readonly objectId: string;
  readonly page: number;
  readonly pageCount: number | null;
  readonly point: PdfCommentPoint | null;
}): Record<string, unknown> {
  const base = {
    kind: point === null ? "pdf-page" : "pdf-page-point",
    objectId,
    page,
    ...(pageCount === null ? {} : { pageCount }),
  };
  if (point === null) {
    return { ...base, target: "page" };
  }
  return {
    ...base,
    target: "point",
    units: "percent",
    x: point.x,
    y: point.y,
  };
}

function pdfTextCommentAnchor({
  objectId,
  page,
  pageCount,
  match,
  renderedPage,
}: {
  readonly objectId: string;
  readonly page: number;
  readonly pageCount: number | null;
  readonly match: PdfTextLayerItem;
  readonly renderedPage: PdfRenderedPage;
}): Record<string, unknown> {
  return {
    kind: "pdf-text-match",
    objectId,
    page,
    ...(pageCount === null ? {} : { pageCount }),
    target: "text",
    units: "percent",
    quote: match.text,
    textItemIds: [match.id],
    rects: [textAnchorRectFromMatch(match, renderedPage)],
  };
}

function pdfTextSelectionCommentAnchor({
  objectId,
  page,
  pageCount,
  selection,
  renderedPage,
}: {
  readonly objectId: string;
  readonly page: number;
  readonly pageCount: number | null;
  readonly selection: PdfSelectedTextRange;
  readonly renderedPage: PdfRenderedPage;
}): Record<string, unknown> {
  return {
    kind: "pdf-text-selection",
    objectId,
    page,
    ...(pageCount === null ? {} : { pageCount }),
    target: "text",
    units: "percent",
    quote: selection.text,
    textItemIds: selection.items.map((item) => item.id),
    rects: selection.items.map((item) => textAnchorRectFromMatch(item, renderedPage)),
  };
}

function pdfRedactionCommentAnchor({
  objectId,
  pageCount,
  redaction,
}: {
  readonly objectId: string;
  readonly pageCount: number | null;
  readonly redaction: PdfPendingRedaction;
}): Record<string, unknown> {
  return {
    kind: "pdf-redaction",
    objectId,
    page: redaction.pageNumber,
    ...(pageCount === null ? {} : { pageCount }),
    target: "redaction",
    units: "percent",
    x: redaction.x,
    y: redaction.y,
    width: redaction.width,
    height: redaction.height,
  };
}

function pdfStampCommentAnchor({
  objectId,
  page,
  pageCount,
  point,
  stamp,
}: {
  readonly objectId: string;
  readonly page: number;
  readonly pageCount: number | null;
  readonly point: PdfCommentPoint;
  readonly stamp: PdfStampDescriptor;
}): Record<string, unknown> {
  return {
    kind: "pdf-stamp",
    objectId,
    page,
    ...(pageCount === null ? {} : { pageCount }),
    target: "stamp",
    units: "percent",
    stamp: stamp.kind,
    label: stamp.label,
    x: point.x,
    y: point.y,
  };
}

function pdfFreehandCommentAnchor({
  objectId,
  page,
  pageCount,
  points,
}: {
  readonly objectId: string;
  readonly page: number;
  readonly pageCount: number | null;
  readonly points: readonly PdfCommentPoint[];
}): Record<string, unknown> {
  return {
    kind: "pdf-freehand",
    objectId,
    page,
    ...(pageCount === null ? {} : { pageCount }),
    target: "draw",
    units: "percent",
    strokeColor: PDF_FREEHAND_DEFAULT_COLOR,
    strokeWidth: PDF_FREEHAND_DEFAULT_STROKE_WIDTH,
    points: points.map((point) => ({ x: point.x, y: point.y })),
  };
}

function redactionFromPdfComment(comment: PdfDriveComment): PdfPendingRedaction | null {
  if (comment.anchor.kind !== "pdf-redaction" || comment.anchor.target !== "redaction") {
    return null;
  }
  const pageNumber = pageFromPdfComment(comment);
  const x = numberAnchorValue(comment.anchor.x);
  const y = numberAnchorValue(comment.anchor.y);
  const width = redactionSizeValue(comment.anchor.width);
  const height = redactionSizeValue(comment.anchor.height);
  if (x === null || y === null || width === null || height === null) {
    return null;
  }
  return { pageNumber, x, y, width, height };
}

function stampFromPdfComment(comment: PdfDriveComment): PdfStampAnnotation | null {
  if (comment.anchor.kind !== "pdf-stamp" || comment.anchor.target !== "stamp") {
    return null;
  }
  const point = pointFromPdfComment(comment);
  const stamp = typeof comment.anchor.stamp === "string" ? comment.anchor.stamp : "";
  const descriptor = pdfStampDescriptor(stamp);
  if (point === null || descriptor === null) {
    return null;
  }
  return {
    pageNumber: pageFromPdfComment(comment),
    x: point.x,
    y: point.y,
    kind: descriptor.kind,
    label: descriptor.label,
  };
}

function freehandFromPdfComment(comment: PdfDriveComment): PdfFreehandAnnotation | null {
  if (comment.anchor.kind !== "pdf-freehand" || comment.anchor.target !== "draw") {
    return null;
  }
  const points = unknownArrayOrNull(comment.anchor.points)
    ?.map(pointFromUnknown)
    .filter((point): point is PdfCommentPoint => point !== null);
  if (points === undefined || points.length < 2) {
    return null;
  }
  return {
    pageNumber: pageFromPdfComment(comment),
    points,
    strokeColor:
      typeof comment.anchor.strokeColor === "string" && comment.anchor.strokeColor.length > 0
        ? comment.anchor.strokeColor
        : PDF_FREEHAND_DEFAULT_COLOR,
    strokeWidth: freehandStrokeWidthValue(comment.anchor.strokeWidth),
  };
}

function textAnchorFromPdfComment(comment: PdfDriveComment): PdfTextAnchor | null {
  if (
    (comment.anchor.kind !== "pdf-text-match" && comment.anchor.kind !== "pdf-text-selection") ||
    comment.anchor.target !== "text"
  ) {
    return null;
  }
  const rects = comment.anchor.rects;
  if (!Array.isArray(rects)) {
    return null;
  }
  const parsedRects = rects
    .map(textAnchorRectFromUnknown)
    .filter((rect): rect is PdfTextAnchorRect => rect !== null);
  if (parsedRects.length === 0) {
    return null;
  }
  return {
    text: typeof comment.anchor.quote === "string" ? comment.anchor.quote : "Text match",
    rects: parsedRects,
  };
}

function selectedTextRangeFromIds(
  items: readonly PdfTextLayerItem[],
  startId: string | null,
  endId: string | null,
): PdfSelectedTextRange | null {
  if (startId === null || endId === null) {
    return null;
  }
  const startIndex = items.findIndex((item) => item.id === startId);
  const endIndex = items.findIndex((item) => item.id === endId);
  if (startIndex < 0 || endIndex < 0) {
    return null;
  }
  const from = Math.min(startIndex, endIndex);
  const to = Math.max(startIndex, endIndex);
  const selectedItems = items.slice(from, to + 1).filter((item) => item.text.trim().length > 0);
  if (selectedItems.length === 0) {
    return null;
  }
  return {
    text: selectedItems.map((item) => item.text.trim()).join(" "),
    items: selectedItems,
  };
}

function browserSelectedTextRange(
  items: readonly PdfTextLayerItem[],
  selection: Selection | null = window.getSelection(),
): PdfSelectedTextRange | null {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const selectedIds = Array.from(document.querySelectorAll<HTMLElement>("[data-pdf-text-item-id]"))
    .filter((element) => rangeIntersectsNode(range, element))
    .map((element) => element.dataset.pdfTextItemId)
    .filter((id): id is string => id !== undefined && id.length > 0);
  if (selectedIds.length === 0) {
    return null;
  }
  return selectedTextRangeFromIds(items, selectedIds[0] ?? null, selectedIds.at(-1) ?? null);
}

function rangeIntersectsNode(range: Range, node: Node): boolean {
  if (typeof range.intersectsNode === "function") {
    return range.intersectsNode(node);
  }
  const nodeRange = document.createRange();
  nodeRange.selectNodeContents(node);
  return (
    range.compareBoundaryPoints(Range.END_TO_START, nodeRange) < 0 &&
    range.compareBoundaryPoints(Range.START_TO_END, nodeRange) > 0
  );
}

function textAnchorRectFromMatch(
  match: PdfTextLayerItem,
  renderedPage: PdfRenderedPage,
): PdfTextAnchorRect {
  const width = match.width ?? Math.max(match.height, match.text.length * match.height * 0.5);
  const boundedWidth = Math.max(0, Math.min(width, renderedPage.width - match.left));
  return {
    left: clampPercentage((match.left / renderedPage.width) * 100),
    top: clampPercentage((match.top / renderedPage.height) * 100),
    width: clampPercentage((boundedWidth / renderedPage.width) * 100),
    height: clampPercentage((match.height / renderedPage.height) * 100),
  };
}

function textAnchorRectFromUnknown(value: unknown): PdfTextAnchorRect | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const left = numberAnchorValue(record["left"] ?? record["x"]);
  const top = numberAnchorValue(record["top"] ?? record["y"]);
  const width = numberAnchorValue(record["width"]);
  const height = numberAnchorValue(record["height"]);
  if (left === null || top === null || width === null || height === null) {
    return null;
  }
  return { left, top, width, height };
}

function numberAnchorValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function redactionSizeValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100
    ? value
    : null;
}

function freehandStrokeWidthValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 16
    ? value
    : PDF_FREEHAND_DEFAULT_STROKE_WIDTH;
}

function commentAnchorLabel(comment: PdfDriveComment): string {
  const textAnchor = textAnchorFromPdfComment(comment);
  if (textAnchor !== null) {
    return `Page ${String(pageFromPdfComment(comment))} · "${textAnchor.text}"`;
  }
  const redaction = redactionFromPdfComment(comment);
  if (redaction !== null) {
    return `Page ${String(redaction.pageNumber)} · redaction ${formatPercent(redaction.x)}, ${formatPercent(redaction.y)}`;
  }
  const stamp = stampFromPdfComment(comment);
  if (stamp !== null) {
    return `Page ${String(stamp.pageNumber)} · ${stamp.label} stamp ${formatPercent(stamp.x)}, ${formatPercent(stamp.y)}`;
  }
  const freehand = freehandFromPdfComment(comment);
  if (freehand !== null) {
    return `Page ${String(freehand.pageNumber)} · freehand annotation ${String(freehand.points.length)} points`;
  }
  const point = pointFromPdfComment(comment);
  if (point === null) {
    return `Page ${String(pageFromPdfComment(comment))}`;
  }
  return `Page ${String(pageFromPdfComment(comment))} · ${formatPercent(point.x)}, ${formatPercent(point.y)}`;
}

function pdfStampDescriptor(value: PdfStampKind): PdfStampDescriptor;
function pdfStampDescriptor(value: string): PdfStampDescriptor | null;
function pdfStampDescriptor(value: string): PdfStampDescriptor | null {
  return PDF_STAMP_DESCRIPTORS.find((stamp) => stamp.kind === value) ?? null;
}

function clampPercentage(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

function pointFromPdfStageEvent(event: {
  readonly currentTarget: HTMLElement;
  readonly clientX: number;
  readonly clientY: number;
}): PdfCommentPoint | null {
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return {
    x: clampPercentage(((event.clientX - rect.left) / rect.width) * 100),
    y: clampPercentage(((event.clientY - rect.top) / rect.height) * 100),
  };
}

function pointFromUnknown(value: unknown): PdfCommentPoint | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const x = numberAnchorValue(record["x"]);
  const y = numberAnchorValue(record["y"]);
  return x === null || y === null ? null : { x, y };
}

function distanceBetweenPoints(a: PdfCommentPoint, b: PdfCommentPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function freehandSvgPoints(points: readonly PdfCommentPoint[]): string {
  return points.map((point) => `${String(point.x)},${String(point.y)}`).join(" ");
}

function centeredRedactionRect(x: number, y: number): PdfRedactionRect {
  const width = 22;
  const height = 10;
  return {
    x: clampPercentage(Math.min(Math.max(x - width / 2, 0), 100 - width)),
    y: clampPercentage(Math.min(Math.max(y - height / 2, 0), 100 - height)),
    width,
    height,
  };
}

function redactionRectFromPoints(start: PdfCommentPoint, end: PdfCommentPoint): PdfRedactionRect {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  return {
    x: clampPercentage(left),
    y: clampPercentage(top),
    width: clampPercentage(Math.abs(end.x - start.x)),
    height: clampPercentage(Math.abs(end.y - start.y)),
  };
}

function redactionsGroupedByPage(
  redactions: readonly PdfPendingRedaction[],
  pageCount: number,
): Map<number, readonly PdfRedactionRect[]> {
  const groups = new Map<number, PdfRedactionRect[]>();
  for (const redaction of redactions) {
    if (
      !Number.isSafeInteger(redaction.pageNumber) ||
      redaction.pageNumber < 1 ||
      redaction.pageNumber > pageCount
    ) {
      continue;
    }
    const pageRedactions = groups.get(redaction.pageNumber) ?? [];
    pageRedactions.push({
      x: redaction.x,
      y: redaction.y,
      width: redaction.width,
      height: redaction.height,
    });
    groups.set(redaction.pageNumber, pageRedactions);
  }
  return groups;
}

function stampAnnotationsGroupedByPage(
  stamps: readonly PdfStampAnnotation[],
  pageCount: number,
): Map<number, readonly PdfStampAnnotation[]> {
  const groups = new Map<number, PdfStampAnnotation[]>();
  for (const stamp of stamps) {
    if (
      !Number.isSafeInteger(stamp.pageNumber) ||
      stamp.pageNumber < 1 ||
      stamp.pageNumber > pageCount
    ) {
      continue;
    }
    const pageStamps = groups.get(stamp.pageNumber) ?? [];
    pageStamps.push(stamp);
    groups.set(stamp.pageNumber, pageStamps);
  }
  return groups;
}

export function redactionRectToPdfCoordinates(
  rect: PdfRedactionRect,
  pageWidth: number,
  pageHeight: number,
  rotation = 0,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const xPercent = rect.x / 100;
  const yPercent = rect.y / 100;
  const widthPercent = rect.width / 100;
  const heightPercent = rect.height / 100;
  const width = pageWidth * widthPercent;
  const height = pageHeight * heightPercent;
  switch (normalizePdfRotation(rotation)) {
    case 90:
      return {
        x: pageWidth * yPercent,
        y: pageHeight * xPercent,
        width: pageWidth * heightPercent,
        height: pageHeight * widthPercent,
      };
    case 180:
      return {
        x: pageWidth * (1 - xPercent - widthPercent),
        y: pageHeight * yPercent,
        width,
        height,
      };
    case 270:
      return {
        x: pageWidth * (1 - yPercent - heightPercent),
        y: pageHeight * (1 - xPercent - widthPercent),
        width: pageWidth * heightPercent,
        height: pageHeight * widthPercent,
      };
    default:
      return {
        x: pageWidth * xPercent,
        y: pageHeight * (1 - yPercent - heightPercent),
        width,
        height,
      };
  }
}

export function stampPointToPdfCoordinates(
  point: { readonly x: number; readonly y: number },
  pageWidth: number,
  pageHeight: number,
  rotation = 0,
): { readonly x: number; readonly y: number } {
  const xPercent = point.x / 100;
  const yPercent = point.y / 100;
  switch (normalizePdfRotation(rotation)) {
    case 90:
      return {
        x: pageWidth * yPercent,
        y: pageHeight * xPercent,
      };
    case 180:
      return {
        x: pageWidth * (1 - xPercent),
        y: pageHeight * yPercent,
      };
    case 270:
      return {
        x: pageWidth * (1 - yPercent),
        y: pageHeight * (1 - xPercent),
      };
    default:
      return {
        x: pageWidth * xPercent,
        y: pageHeight * (1 - yPercent),
      };
  }
}

function pdfStampBounds(
  label: string,
  center: { readonly x: number; readonly y: number },
  pageWidth: number,
  pageHeight: number,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const maxWidth = Math.max(24, pageWidth - 8);
  const width = Math.min(Math.max(label.length * 6 + PDF_STAMP_PDF_PADDING_X * 2, 58), maxWidth);
  const height = Math.min(PDF_STAMP_PDF_HEIGHT, Math.max(12, pageHeight - 8));
  return {
    x: clampNumber(center.x - width / 2, 4, pageWidth - width - 4),
    y: clampNumber(center.y - height / 2, 4, pageHeight - height - 4),
    width,
    height,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function redactionRectToCanvasCoordinates(
  rect: PdfRedactionRect,
  canvasWidth: number,
  canvasHeight: number,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  return {
    x: (rect.x / 100) * canvasWidth,
    y: (rect.y / 100) * canvasHeight,
    width: (rect.width / 100) * canvasWidth,
    height: (rect.height / 100) * canvasHeight,
  };
}

function formatPercent(value: number): string {
  return `${String(Math.round(value))}%`;
}

function pdfCommentThreads(
  comments: readonly PdfDriveComment[],
): readonly { readonly comment: PdfDriveComment; readonly replies: readonly PdfDriveComment[] }[] {
  const repliesByParent = new Map<string, PdfDriveComment[]>();
  const commentIds = new Set(comments.map((comment) => comment.id));
  const roots: PdfDriveComment[] = [];
  for (const comment of comments) {
    if (
      comment.parentCommentId === null ||
      comment.parentCommentId === undefined ||
      !commentIds.has(comment.parentCommentId)
    ) {
      roots.push(comment);
    } else {
      const replies = repliesByParent.get(comment.parentCommentId) ?? [];
      replies.push(comment);
      repliesByParent.set(comment.parentCommentId, replies);
    }
  }
  return roots.map((comment) => ({
    comment,
    replies: repliesByParent.get(comment.id) ?? [],
  }));
}

function selectedCommentThreadId(
  threads: readonly {
    readonly comment: PdfDriveComment;
    readonly replies: readonly PdfDriveComment[];
  }[],
  selectedCommentId: string | null,
): string | null {
  if (selectedCommentId === null) {
    return null;
  }
  for (const thread of threads) {
    if (
      thread.comment.id === selectedCommentId ||
      thread.replies.some((reply) => reply.id === selectedCommentId)
    ) {
      return thread.comment.id;
    }
  }
  return null;
}

function commentAuthorLabel(comment: PdfDriveComment): string {
  return comment.author?.displayName ?? comment.author?.email ?? comment.actorId ?? "Unknown";
}

function emptyCommentsLabel(status: PdfCommentStatus): string {
  if (status === "open") return "No open comments.";
  if (status === "resolved") return "No resolved comments.";
  return "No comments.";
}

function PageNavigationButton({
  pageNumber,
  selected,
  thumbnail,
  commentCount,
  reorderEnabled,
  dragActive,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onSelect,
}: {
  readonly pageNumber: number;
  readonly selected: boolean;
  readonly thumbnail: PdfPageThumbnail | null;
  readonly commentCount: number;
  readonly reorderEnabled: boolean;
  readonly dragActive: boolean;
  readonly onDragStart: () => void;
  readonly onDragOver: (event: DragEvent<HTMLButtonElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLButtonElement>) => void;
  readonly onDragEnd: () => void;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`PDF thumbnail page ${pageNumber}`}
      aria-pressed={selected}
      draggable={reorderEnabled}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(pageNumber));
        onDragStart();
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      style={{
        ...PAGE_BUTTON_STYLE,
        borderColor: selected ? "var(--accent)" : "var(--border)",
        opacity: dragActive ? 0.6 : undefined,
      }}
    >
      {thumbnail === null ? null : (
        <img
          alt=""
          src={thumbnail.dataUrl}
          width={thumbnail.width}
          height={thumbnail.height}
          loading="lazy"
          decoding="async"
          style={PAGE_THUMBNAIL_STYLE}
        />
      )}
      <span>Page {pageNumber}</span>
      {commentCount > 0 ? <span style={COMMENT_COUNT_STYLE}>{commentCount}</span> : null}
    </button>
  );
}

function thumbnailForPage(
  thumbnails: readonly PdfPageThumbnail[],
  pageNumber: number,
): PdfPageThumbnail | null {
  return thumbnails.find((thumbnail) => thumbnail.pageNumber === pageNumber) ?? null;
}

function textMatchesForQuery(
  pages: readonly PdfPageTextIndex[],
  query: string,
): readonly PdfTextSearchMatch[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) {
    return [];
  }
  return pages.flatMap((page) =>
    page.textItems
      .filter((item) => item.text.toLocaleLowerCase().includes(normalized))
      .map((item) => ({ ...item, pageNumber: page.pageNumber })),
  );
}

function loadPdfJs(): PdfJsModule {
  const pdfjsModule = pdfjs as unknown as PdfJsModule;
  if (pdfjsModule.GlobalWorkerOptions !== undefined) {
    pdfjsModule.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }
  return pdfjsModule;
}

async function renderPdfThumbnails(pdf: PdfJsDocument): Promise<readonly PdfPageThumbnail[]> {
  const thumbnails: PdfPageThumbnail[] = [];
  const pageTotal = Math.min(pdf.numPages, 40);
  for (let pageNumber = 1; pageNumber <= pageTotal; pageNumber += 1) {
    const thumbnail = await renderPdfThumbnail(pdf, pageNumber);
    if (thumbnail !== null) {
      thumbnails.push(thumbnail);
    }
  }
  return thumbnails;
}

async function loadPdfTextIndex(pdf: PdfJsDocument): Promise<readonly PdfPageTextIndex[]> {
  const pages: PdfPageTextIndex[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    pages.push({
      pageNumber,
      textItems: textLayerItemsFromContent(textContent, viewport, 1),
    });
  }
  return pages;
}

async function renderPdfThumbnail(
  pdf: PdfJsDocument,
  pageNumber: number,
): Promise<PdfPageThumbnail | null> {
  const image = await renderPdfPageImage(pdf, pageNumber, 0.18);
  return {
    pageNumber,
    ...image,
  };
}

async function renderPdfPageImage(
  pdf: PdfJsDocument,
  pageNumber: number,
  scale: number,
): Promise<{ readonly dataUrl: string; readonly width: number; readonly height: number }> {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = documentNode().createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("Canvas 2D rendering is unavailable.");
  }
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
  };
}

async function renderRedactedPdfPageImage(
  pdfBytes: Uint8Array,
  pageNumber: number,
  redactions: readonly PdfRedactionRect[],
): Promise<{ readonly dataUrl: string; readonly width: number; readonly height: number }> {
  const pdf = await loadPdfJs().getDocument({ data: new Uint8Array(pdfBytes) }).promise;
  try {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = documentNode().createElement("canvas");
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("Canvas 2D rendering is unavailable.");
    }
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: context, viewport }).promise;
    context.fillStyle = "#000000";
    for (const redaction of redactions) {
      const rect = redactionRectToCanvasCoordinates(redaction, canvas.width, canvas.height);
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
    return {
      dataUrl: canvas.toDataURL("image/png"),
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    await pdf.destroy?.();
  }
}

async function renderPdfPageWithText(
  pdf: PdfJsDocument,
  pageNumber: number,
  scale: number,
): Promise<{
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly textItems: readonly PdfTextLayerItem[];
}> {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = documentNode().createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("Canvas 2D rendering is unavailable.");
  }
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const [textContent] = await Promise.all([
    page.getTextContent(),
    page.render({ canvasContext: context, viewport }).promise,
  ]);
  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
    textItems: textLayerItemsFromContent(textContent, viewport, scale),
  };
}

function textLayerItemsFromContent(
  content: PdfJsTextContent,
  viewport: PdfJsViewport,
  scale: number,
): readonly PdfTextLayerItem[] {
  return content.items
    .map((item, index) => textLayerItemFromSource(item, index, viewport, scale))
    .filter((item): item is PdfTextLayerItem => item !== null);
}

function textLayerItemFromSource(
  item: PdfJsTextItemSource,
  index: number,
  viewport: PdfJsViewport,
  scale: number,
): PdfTextLayerItem | null {
  const text = item.str?.trim();
  const transform = item.transform;
  if (text === undefined || text.length === 0 || transform === undefined || transform.length < 6) {
    return null;
  }
  const rawX = transform[4];
  const rawY = transform[5];
  if (rawX === undefined || rawY === undefined) {
    return null;
  }
  const rawHeight = Math.abs(transform[3] ?? item.height ?? 10);
  const height = Math.max(6, rawHeight * scale);
  const width = typeof item.width === "number" && item.width > 0 ? item.width * scale : null;
  return {
    id: `text-${String(index)}`,
    text,
    left: rawX * scale,
    top: Math.max(0, viewport.height - rawY * scale - height),
    width,
    height,
  };
}

async function loadPdfOutline(pdf: PdfJsDocument): Promise<readonly PdfOutlineItem[]> {
  const rawOutline = await pdf.getOutline();
  if (rawOutline === null) {
    return [];
  }
  return flattenPdfOutline(pdf, rawOutline, 0, "outline");
}

async function flattenPdfOutline(
  pdf: PdfJsDocument,
  items: readonly PdfJsOutlineSource[],
  depth: number,
  prefix: string,
): Promise<readonly PdfOutlineItem[]> {
  const outline: PdfOutlineItem[] = [];
  for (const [index, item] of items.entries()) {
    const id = `${prefix}-${String(index)}`;
    const destination = await pdfOutlineDestination(pdf, item.dest);
    if (destination !== null && item.title !== undefined && item.title.trim().length > 0) {
      outline.push({
        id,
        title: item.title.trim(),
        pageNumber: destination.pageNumber,
        ...(destination.zoom === undefined ? {} : { zoom: destination.zoom }),
        depth,
      });
    }
    if (item.items !== undefined && item.items.length > 0) {
      outline.push(...(await flattenPdfOutline(pdf, item.items, depth + 1, id)));
    }
  }
  return outline;
}

async function pdfOutlineDestination(
  pdf: PdfJsDocument,
  destination: unknown,
): Promise<{ readonly pageNumber: number; readonly zoom?: number | undefined } | null> {
  const resolved =
    typeof destination === "string"
      ? await pdf.getDestination(destination)
      : unknownArrayOrNull(destination);
  if (resolved === null || resolved.length === 0) {
    return null;
  }
  const pageNumber = await pageNumberFromPdfDestinationRef(pdf, resolved[0]);
  if (pageNumber === null) {
    return null;
  }
  const zoom = zoomFromPdfDestination(resolved);
  return {
    pageNumber,
    ...(zoom === undefined ? {} : { zoom }),
  };
}

async function pageNumberFromPdfDestinationRef(
  pdf: PdfJsDocument,
  pageRef: unknown,
): Promise<number | null> {
  if (typeof pageRef === "number" && Number.isSafeInteger(pageRef)) {
    const pageNumber = pageRef + 1;
    return pageNumber >= 1 && pageNumber <= pdf.numPages ? pageNumber : null;
  }
  try {
    const pageNumber = (await pdf.getPageIndex(pageRef)) + 1;
    return pageNumber >= 1 && pageNumber <= pdf.numPages ? pageNumber : null;
  } catch {
    return null;
  }
}

function zoomFromPdfDestination(destination: readonly unknown[]): number | undefined {
  const mode = destination[1];
  const modeName =
    typeof mode === "object" && mode !== null && "name" in mode
      ? (mode as { readonly name?: unknown }).name
      : mode;
  if (modeName !== "XYZ") {
    return undefined;
  }
  const zoom = destination[4];
  if (typeof zoom !== "number" || !Number.isFinite(zoom) || zoom <= 0) {
    return undefined;
  }
  return Math.min(200, Math.max(50, Math.round(zoom * 100)));
}

function unknownArrayOrNull(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? (value as readonly unknown[]) : null;
}

const DEFAULT_PDF_VIEW_STATE = {
  page: 1,
  zoom: 100,
  commentId: null,
  sourceFolderId: null,
} satisfies NativePdfViewRouteState;

const PDF_SHELL_STYLE = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  flex: 1,
  background: "var(--bg)",
} satisfies CSSProperties;

const TOOLBAR_STYLE = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 10,
  padding: "10px 14px",
  borderBottom: "1px solid var(--border)",
  background: "var(--surface)",
} satisfies CSSProperties;

const MERGE_PLACEMENT_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: "var(--text-caption)",
  color: "var(--text-2)",
} satisfies CSSProperties;

const MERGE_PLACEMENT_SELECT_STYLE = {
  minWidth: 176,
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "5px 8px",
  background: "var(--surface-2)",
  color: "var(--text)",
  font: "inherit",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const MERGE_FILE_BUTTON_STYLE = {
  position: "relative",
  overflow: "hidden",
} satisfies CSSProperties;

const HIDDEN_FILE_INPUT_STYLE = {
  position: "absolute",
  inlineSize: 1,
  blockSize: 1,
  opacity: 0,
  pointerEvents: "none",
} satisfies CSSProperties;

const TITLE_STYLE = {
  fontSize: "var(--text-body-sm)",
  fontWeight: 600,
} satisfies CSSProperties;

const META_STYLE = {
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const PAGER_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  marginLeft: 16,
} satisfies CSSProperties;

const PAGE_FIELD_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const PAGE_COUNT_STYLE = {
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const ZOOM_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  marginLeft: 8,
} satisfies CSSProperties;

const ZOOM_VALUE_STYLE = {
  minWidth: 42,
  textAlign: "center",
  fontSize: "var(--text-caption)",
  color: "var(--text-2)",
} satisfies CSSProperties;

const PDF_FIND_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  marginLeft: 8,
} satisfies CSSProperties;

const PDF_FIND_INPUT_STYLE = {
  width: 132,
  height: 30,
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "0 8px",
  background: "var(--surface-2)",
  color: "var(--text)",
  font: "inherit",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const PDF_FIND_COUNT_STYLE = {
  minWidth: 42,
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
  textAlign: "center",
} satisfies CSSProperties;

const VIEWER_GRID_STYLE = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) 320px",
  gap: 12,
  minHeight: 0,
  flex: 1,
  padding: 12,
} satisfies CSSProperties;

const PDF_STAGE_STYLE = {
  position: "relative",
  display: "grid",
  placeItems: "center",
  minHeight: 420,
  border: "1px solid var(--border)",
  borderRadius: 8,
  overflow: "auto",
  background: "var(--surface)",
} satisfies CSSProperties;

const PDF_RENDERED_PAGE_STYLE = {
  display: "block",
  width: "100%",
  height: "100%",
  objectFit: "contain",
  background: "#fff",
  boxShadow: "0 12px 32px rgba(15,23,42,.18)",
} satisfies CSSProperties;

const PDF_PAGE_LAYER_STYLE = {
  position: "relative",
  display: "block",
  flex: "0 0 auto",
} satisfies CSSProperties;

const PDF_TEXT_LAYER_STYLE = {
  position: "absolute",
  inset: 0,
  zIndex: 1,
  overflow: "hidden",
  userSelect: "text",
} satisfies CSSProperties;

const PDF_TEXT_ITEM_STYLE = {
  position: "absolute",
  whiteSpace: "pre",
  color: "transparent",
  borderRadius: 2,
  lineHeight: 1,
  transformOrigin: "0 0",
} satisfies CSSProperties;

const PDF_TEXT_SELECTABLE_STYLE = {
  cursor: "crosshair",
  outline: "1px dashed rgba(37, 99, 235, .36)",
} satisfies CSSProperties;

const PDF_TEXT_MATCH_STYLE = {
  background: "rgba(250, 204, 21, .34)",
} satisfies CSSProperties;

const PDF_TEXT_ACTIVE_MATCH_STYLE = {
  background: "rgba(37, 99, 235, .28)",
  outline: "1px solid rgba(37, 99, 235, .82)",
} satisfies CSSProperties;

const PDF_TEXT_SELECTED_STYLE = {
  background: "rgba(14, 165, 233, .32)",
  outline: "1px solid rgba(14, 165, 233, .86)",
} satisfies CSSProperties;

const PDF_TEXT_ANCHOR_STYLE = {
  position: "absolute",
  zIndex: 2,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "rgba(245, 158, 11, .82)",
  borderRadius: 2,
  background: "rgba(245, 158, 11, .22)",
  padding: 0,
  cursor: "pointer",
} satisfies CSSProperties;

const PDF_TEXT_ANCHOR_SELECTED_STYLE = {
  borderColor: "rgba(37, 99, 235, .9)",
  background: "rgba(37, 99, 235, .22)",
} satisfies CSSProperties;

const PDF_RENDER_STATUS_STYLE = {
  display: "grid",
  placeItems: "center",
  minHeight: 420,
  color: "var(--text-3)",
  fontSize: "var(--text-meta)",
} satisfies CSSProperties;

const PDF_COMMENT_PIN_STYLE = {
  position: "absolute",
  zIndex: 2,
  display: "inline-grid",
  placeItems: "center",
  width: 26,
  height: 26,
  padding: 0,
  border: "2px solid #fff",
  borderRadius: 999,
  background: "var(--accent)",
  color: "#fff",
  boxShadow: "0 6px 16px rgba(15,23,42,.24)",
  transform: "translate(-50%, -50%)",
  cursor: "pointer",
} satisfies CSSProperties;

const PDF_PENDING_PIN_STYLE = {
  ...PDF_COMMENT_PIN_STYLE,
  zIndex: 3,
  background: "var(--warning, #f59e0b)",
  pointerEvents: "none",
} satisfies CSSProperties;

const PDF_REDACTION_RECT_STYLE = {
  position: "absolute",
  zIndex: 3,
  border: "2px solid #fff",
  borderRadius: 2,
  background: "rgba(0,0,0,.72)",
  boxShadow: "0 6px 16px rgba(15,23,42,.24)",
  pointerEvents: "none",
} satisfies CSSProperties;

const PDF_REDACTION_ANNOTATION_STYLE = {
  borderColor: "rgba(245, 158, 11, .95)",
  background: "rgba(0,0,0,.56)",
  cursor: "pointer",
  pointerEvents: "auto",
} satisfies CSSProperties;

const PDF_REDACTION_SELECTED_STYLE = {
  borderColor: "rgba(37, 99, 235, .95)",
  boxShadow: "0 0 0 2px rgba(37, 99, 235, .28), 0 6px 16px rgba(15,23,42,.24)",
} satisfies CSSProperties;

const PDF_STAMP_STYLE = {
  position: "absolute",
  zIndex: 3,
  padding: "5px 8px",
  border: "2px solid rgba(15, 23, 42, .82)",
  borderRadius: 4,
  background: "rgba(255,255,255,.9)",
  color: "rgba(15, 23, 42, .92)",
  boxShadow: "0 6px 16px rgba(15,23,42,.24)",
  fontSize: "var(--text-caption)",
  fontWeight: 800,
  letterSpacing: 0,
  textTransform: "uppercase",
  transform: "translate(-50%, -50%) rotate(-4deg)",
  cursor: "pointer",
} satisfies CSSProperties;

const PDF_STAMP_SELECTED_STYLE = {
  borderColor: "rgba(37, 99, 235, .95)",
  boxShadow: "0 0 0 2px rgba(37, 99, 235, .28), 0 6px 16px rgba(15,23,42,.24)",
} satisfies CSSProperties;

const PDF_FREEHAND_LAYER_STYLE = {
  position: "absolute",
  inset: 0,
  zIndex: 3,
  width: "100%",
  height: "100%",
  overflow: "visible",
  pointerEvents: "none",
} satisfies CSSProperties;

const PDF_FREEHAND_PATH_STYLE = {
  pointerEvents: "stroke",
  cursor: "pointer",
  filter: "drop-shadow(0 2px 3px rgba(15,23,42,.22))",
} satisfies CSSProperties;

const PDF_FREEHAND_SELECTED_STYLE = {
  stroke: "var(--accent)",
  filter: "drop-shadow(0 0 3px rgba(37, 99, 235, .72))",
} satisfies CSSProperties;

const PDF_FREEHAND_DRAFT_STYLE = {
  opacity: 0.72,
  pointerEvents: "none",
} satisfies CSSProperties;

const PDF_PLACEMENT_OVERLAY_STYLE = {
  position: "absolute",
  inset: 0,
  zIndex: 4,
  cursor: "crosshair",
  background: "transparent",
  touchAction: "none",
} satisfies CSSProperties;

const PDF_PLACEMENT_HINT_STYLE = {
  position: "absolute",
  left: 12,
  bottom: 12,
  zIndex: 5,
  padding: "6px 8px",
  borderRadius: 6,
  background: "rgba(15,23,42,.82)",
  color: "#fff",
  fontSize: "var(--text-caption)",
  pointerEvents: "none",
} satisfies CSSProperties;

const COMMENT_PIN_ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 8,
} satisfies CSSProperties;

const PIN_META_STYLE = {
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const FORMS_PANEL_STYLE = {
  display: "grid",
  alignContent: "start",
  gap: 12,
  minHeight: 0,
  overflowY: "auto",
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--surface)",
  padding: 12,
} satisfies CSSProperties;

const PANEL_TITLE_STYLE = {
  fontSize: "var(--text-body-sm)",
  fontWeight: 600,
} satisfies CSSProperties;

const PANEL_NOTE_STYLE = {
  fontSize: "var(--text-meta)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const INLINE_PANEL_BUTTON_STYLE = {
  marginLeft: 8,
} satisfies CSSProperties;

const PANEL_ERROR_STYLE = {
  fontSize: "var(--text-meta)",
  color: "var(--danger)",
} satisfies CSSProperties;

const PDF_FIELD_CONFLICTS_STYLE = {
  display: "grid",
  gap: 6,
  padding: 8,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
  fontSize: "var(--text-meta)",
  color: "var(--text-2)",
} satisfies CSSProperties;

const PDF_FIELD_CONFLICT_ROW_STYLE = {
  display: "grid",
  gap: 2,
} satisfies CSSProperties;

const PDF_FIELD_VALIDATION_STYLE = {
  color: "var(--danger)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const COMMENT_COUNT_STYLE = {
  display: "inline-grid",
  placeItems: "center",
  minWidth: 20,
  height: 20,
  borderRadius: 999,
  background: "var(--accent-soft)",
  color: "var(--accent)",
  fontSize: "var(--text-caption)",
  fontWeight: 700,
} satisfies CSSProperties;

const COMMENTS_STYLE = {
  display: "grid",
  gap: 8,
  margin: 0,
  padding: 0,
  listStyle: "none",
} satisfies CSSProperties;

const COMMENT_STYLE = {
  display: "grid",
  gap: 6,
  padding: 8,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
} satisfies CSSProperties;

const COMMENT_SELECTED_STYLE = {
  borderColor: "var(--accent)",
  boxShadow: "0 0 0 1px var(--accent)",
} satisfies CSSProperties;

const COMMENT_HEADER_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
} satisfies CSSProperties;

const COMMENT_PAGE_BUTTON_STYLE = {
  justifySelf: "start",
  border: 0,
  padding: 0,
  background: "transparent",
  color: "var(--accent)",
  font: "inherit",
  fontSize: "var(--text-caption)",
  fontWeight: 700,
  cursor: "pointer",
} satisfies CSSProperties;

const COMMENT_BODY_STYLE = {
  margin: 0,
  color: "var(--text)",
  fontSize: "var(--text-meta)",
  whiteSpace: "pre-wrap",
} satisfies CSSProperties;

const COMMENT_META_STYLE = {
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const COMMENT_ACTIONS_STYLE = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 6,
} satisfies CSSProperties;

const REPLY_LIST_STYLE = {
  display: "grid",
  gap: 6,
  margin: 0,
  padding: 0,
  listStyle: "none",
} satisfies CSSProperties;

const REPLY_STYLE = {
  display: "grid",
  gap: 4,
  padding: "6px 8px",
  borderLeft: "2px solid var(--border)",
  background: "var(--surface)",
} satisfies CSSProperties;

const REPLY_HEADER_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 6,
} satisfies CSSProperties;

const REPLY_FORM_STYLE = {
  display: "grid",
  gap: 5,
} satisfies CSSProperties;

const RESOLVED_STYLE = {
  justifySelf: "start",
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
  fontWeight: 700,
} satisfies CSSProperties;

const FIELDS_STYLE = {
  display: "grid",
  gap: 10,
} satisfies CSSProperties;

const PAGES_STYLE = {
  display: "grid",
  gap: 6,
} satisfies CSSProperties;

const PAGE_BUTTON_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  minHeight: 32,
  padding: "6px 8px",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
  color: "var(--text)",
  font: "inherit",
  fontSize: "var(--text-meta)",
  cursor: "pointer",
} satisfies CSSProperties;

const PAGE_THUMBNAIL_STYLE = {
  width: 42,
  height: 54,
  objectFit: "contain",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "var(--border)",
  background: "#fff",
} satisfies CSSProperties;

const OUTLINE_STYLE = {
  display: "grid",
  gap: 6,
  margin: 0,
  padding: 0,
  listStyle: "none",
} satisfies CSSProperties;

const OUTLINE_BUTTON_STYLE = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 8,
  width: "100%",
  minHeight: 30,
  padding: "5px 8px",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
  color: "var(--text)",
  font: "inherit",
  fontSize: "var(--text-meta)",
  textAlign: "left",
  cursor: "pointer",
} satisfies CSSProperties;

const OUTLINE_PAGE_STYLE = {
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const FIELD_STYLE = {
  display: "grid",
  gap: 5,
} satisfies CSSProperties;

const CHECKBOX_FIELD_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: "var(--text-meta)",
} satisfies CSSProperties;

const LABEL_STYLE = {
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const INPUT_STYLE = {
  minWidth: 0,
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "7px 9px",
  background: "var(--surface-2)",
  color: "var(--text)",
  font: "inherit",
} satisfies CSSProperties;

const TEXTAREA_STYLE = {
  ...INPUT_STYLE,
  resize: "vertical",
} satisfies CSSProperties;
