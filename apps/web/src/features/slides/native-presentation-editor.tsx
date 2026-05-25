import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWebPlatformHost } from "@helix/sdk-web";
import { Icons } from "@/components/icons";
import { uploadDriveFile, type DriveApiEntry } from "@/features/drive/api";
import { driveQueryKeys } from "@/features/drive/queries";
import type { PeopleDirectoryPerson } from "@/features/people/api";
import {
  createSlidesComment,
  createSlidesSlide,
  deleteSlidesComment,
  deleteSlidesSlide,
  exportSlidesDeck,
  reopenSlidesComment,
  reorderSlidesSlides,
  resolveSlidesComment,
  updateSlidesDeck,
  updateSlidesComment,
  updateSlidesSlide,
  type SlidesApiDeckDetail,
  type SlidesApiSlide,
  type SlidesCommentStatus,
  type SlidesDriveComment,
  type SlidesExportResult,
} from "./api";
import {
  slidesCommentsQueryOptions,
  slidesDeckDetailQueryOptions,
  slidesDriveShapeAssetsQueryOptions,
  slidesMentionPeopleQueryOptions,
  slidesQueryKeys,
} from "./queries";
import {
  NativePresentationSyncProvider,
  type NativePresentationAwarenessFrame,
  type NativePresentationSyncStatus,
} from "./native-presentation-sync-provider";
import {
  emptySlideContent,
  SLIDE_LAYOUT_OPTIONS,
  SLIDE_THEME_OPTIONS,
  type SlideContent,
  type SlideConnectorArrow,
  type SlideConnectorDirection,
  type SlideBackground,
  type SlideLayout,
  type SlideImageFit,
  type SlideImageMask,
  type SlideMediaType,
  type SlideShape,
  type SlideShapeAnimation,
  type SlideShapeAnimationEasing,
  type SlideShapeAnimationType,
  type SlideShapeKind,
  type SlideShapeMotionPath,
  type SlideShapeTone,
  type SlideTheme,
  type SlideTransition,
  type SlideTransitionDirection,
} from "./seed";

type LiveCaptionStatus = "off" | "listening" | "unsupported" | "error";
type PresentationCollaborator = Omit<
  NativePresentationAwarenessFrame,
  "type" | "protocol" | "deckId" | "status"
>;
interface PresentationRemoteShapeSelection {
  readonly actorId: string;
  readonly displayName: string;
  readonly shapeId: string;
}

interface PresentationShapeFocusRequest {
  readonly slideId: string;
  readonly shapeId: string;
}

interface SlidesCommentTarget {
  readonly anchor: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly label: string;
  readonly buttonLabel: string;
}

interface SlidesCommentThread {
  readonly root: SlidesDriveComment;
  readonly replies: readonly SlidesDriveComment[];
}

interface SlidesMentionOption {
  readonly person: PeopleDirectoryPerson;
  readonly label: string;
  readonly token: string;
}

type DeckMediaAction = "muteVideo" | "disableAutoplay" | "disableLoop" | "resetTrims";
type DeckMediaPlaybackUpdate = Partial<
  Pick<SlideShape, "mediaAutoplay" | "mediaLoop" | "mediaMuted">
>;
type DeckMediaFilter =
  | "all"
  | "video"
  | "audio"
  | "needs-attention"
  | "external"
  | "missing-poster"
  | "duplicate";

interface DeckMediaAssetRow {
  readonly slide: SlidesApiSlide;
  readonly slideNumber: number;
  readonly shape: SlideShape;
  readonly shapeIndex: number;
  readonly issues: readonly string[];
}

interface DeckMediaReadiness {
  readonly total: number;
  readonly ready: number;
  readonly needsAttention: number;
  readonly external: number;
  readonly missingPoster: number;
  readonly duplicates: number;
  readonly exportBlockers: number;
  readonly exportWarnings: number;
}

type PresentationRecordingStatus =
  | "off"
  | "requesting"
  | "recording"
  | "finalizing"
  | "ready"
  | "unsupported"
  | "error";
type PresentationCaptionPosition = "bottom" | "top";
type PresentationCaptionSize = "standard" | "large";

const PRESENTATION_INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "video",
  "audio",
  '[role="button"]',
  '[contenteditable="true"]',
  '[data-presentation-interactive="true"]',
].join(", ");

interface BrowserSpeechRecognitionResult {
  readonly isFinal?: boolean;
  readonly 0: { readonly transcript: string };
}

interface BrowserSpeechRecognitionEvent {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: BrowserSpeechRecognitionResult;
  };
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  start(): void;
  stop(): void;
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

interface PresentationCaptionCue {
  readonly slideIndex: number;
  readonly slideNumber: number;
  readonly text: string;
  readonly speaker: string | null;
  readonly offsetMs: number | null;
}

type PresentationMediaPlaybackEvent = "play" | "pause" | "ended" | "seeked" | "error";

interface PresentationMediaPlaybackStats {
  readonly key: string;
  readonly slideNumber: number;
  readonly title: string;
  readonly mediaType: SlideMediaType;
  readonly plays: number;
  readonly pauses: number;
  readonly completions: number;
  readonly seeks: number;
  readonly errors: number;
}

interface CaptionTranscriptLibraryEntry {
  readonly id: string;
  readonly deckTitle: string;
  readonly filename: string;
  readonly savedAt: string;
  readonly lines: readonly string[];
}

interface ShapeAnimationTimelineRow {
  readonly key: string;
  readonly shapeId: string;
  readonly shapeLabel: string;
  readonly phase: "entrance" | "exit";
  readonly type: SlideShapeAnimationType;
  readonly motionPath?: SlideShapeMotionPath | undefined;
  readonly order: number;
  readonly durationMs: number;
  readonly easing: SlideShapeAnimationEasing;
  readonly shapeIndex: number;
}

interface DeckShapeAnimationTimelineRow extends ShapeAnimationTimelineRow {
  readonly slideId: string;
  readonly slideNumber: number;
  readonly slideTitle: string;
}

declare global {
  interface Window {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  }
}

export interface NativePresentationEditorProps {
  readonly deckId: string;
  readonly routeState?: NativePresentationEditorRouteState;
  readonly onRouteStateChange?: (state: NativePresentationEditorRouteState) => void;
  readonly onBack: () => void;
}

export interface NativePresentationEditorRouteState {
  readonly commentId: string | null;
}

const DEFAULT_NATIVE_PRESENTATION_EDITOR_ROUTE_STATE = {
  commentId: null,
} satisfies NativePresentationEditorRouteState;

interface NativePresentationCommandHandlers {
  readonly addSlide: () => void;
  readonly duplicateSlide: () => void;
  readonly presentDeck: () => void;
  readonly exportPptx: () => void;
  readonly exportPdf: () => void;
  readonly exportSvgSeries: () => void;
}

export function NativePresentationEditor({
  deckId,
  routeState,
  onRouteStateChange,
  onBack,
}: NativePresentationEditorProps) {
  const queryClient = useQueryClient();
  const platformHost = useWebPlatformHost();
  const editorRouteState = routeState ?? DEFAULT_NATIVE_PRESENTATION_EDITOR_ROUTE_STATE;
  const routeCommentId = editorRouteState.commentId;
  const commandHandlersRef = useRef<NativePresentationCommandHandlers>({
    addSlide: () => undefined,
    duplicateSlide: () => undefined,
    presentDeck: () => undefined,
    exportPptx: () => undefined,
    exportPdf: () => undefined,
    exportSvgSeries: () => undefined,
  });
  const deckQuery = useQuery(slidesDeckDetailQueryOptions(deckId));
  const slides = deckQuery.data?.slides ?? [];
  const [activeSlideId, setActiveSlideId] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);
  const [presentSlideIndex, setPresentSlideIndex] = useState(0);
  const [syncStatus, setSyncStatus] = useState<NativePresentationSyncStatus>("offline");
  const [collaborators, setCollaborators] = useState<readonly PresentationCollaborator[]>([]);
  const [activeShapeId, setActiveShapeId] = useState<string | null>(null);
  const [shapeFocusRequest, setShapeFocusRequest] = useState<PresentationShapeFocusRequest | null>(
    null,
  );
  const [commentStatusFilter, setCommentStatusFilter] = useState<SlidesCommentStatus>(
    routeCommentId === null ? "open" : "all",
  );
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(routeCommentId);
  const [newCommentDraft, setNewCommentDraft] = useState("");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editCommentDraft, setEditCommentDraft] = useState("");
  const commentRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const routeCommentIdRef = useRef<string | null>(routeCommentId);
  const suppressRouteEmitRef = useRef(false);
  const syncProviderRef = useRef<NativePresentationSyncProvider | null>(null);
  const pendingCreateOperationIdRef = useRef<string | null>(null);
  const pendingCreatePositionRef = useRef<number | null>(null);
  const deckTheme = themeFromMetadata(deckQuery.data?.deck.metadata);
  const driveAssetQuery = useQuery(slidesDriveShapeAssetsQueryOptions());
  const mentionPeopleQuery = useQuery(slidesMentionPeopleQueryOptions());
  const openCommentsQuery = useQuery(slidesCommentsQueryOptions(deckId, "open"));
  const filteredCommentsQuery = useQuery(slidesCommentsQueryOptions(deckId, commentStatusFilter));
  const driveImageAssets = useMemo(
    () => (driveAssetQuery.data ?? []).filter(isDriveImageAsset),
    [driveAssetQuery.data],
  );
  const driveMediaAssets = useMemo(
    () => (driveAssetQuery.data ?? []).filter((entry) => driveEntryMediaType(entry) !== null),
    [driveAssetQuery.data],
  );
  const mentionOptions = useMemo(
    () => slidesMentionOptions(mentionPeopleQuery.data ?? []),
    [mentionPeopleQuery.data],
  );
  const deckExportReadiness = useMemo(
    () => mediaAssetReadiness(deckMediaAssetRows(slides)),
    [slides],
  );
  const deckExportBlocked = deckExportReadiness.exportBlockers > 0;

  useEffect(() => {
    setActiveSlideId((current) => current ?? slides[0]?.id ?? null);
  }, [slides]);

  const activeSlide = useMemo(
    () => slides.find((slide) => slide.id === activeSlideId) ?? slides[0] ?? null,
    [activeSlideId, slides],
  );
  const activeSlideIndex = Math.max(
    0,
    slides.findIndex((slide) => slide.id === activeSlide?.id),
  );
  const activeSlideShapes = useMemo(
    () => (activeSlide === null ? [] : slideShapes(activeSlide.content)),
    [activeSlide],
  );
  const activeShapeIndex = activeSlideShapes.findIndex((shape) => shape.id === activeShapeId);
  const activeShape = activeShapeIndex < 0 ? null : (activeSlideShapes[activeShapeIndex] ?? null);
  const comments =
    commentStatusFilter === "open"
      ? (openCommentsQuery.data ?? [])
      : (filteredCommentsQuery.data ?? []);
  const commentThreads = useMemo(() => slidesCommentThreads(comments), [comments]);
  const selectedComment =
    selectedCommentId === null
      ? null
      : (comments.find((comment) => comment.id === selectedCommentId) ?? null);
  const selectedThreadId =
    selectedCommentId === null
      ? null
      : slidesSelectedCommentThreadId(commentThreads, selectedCommentId);
  const linkedCommentUnavailable =
    routeCommentId !== null &&
    selectedCommentId === routeCommentId &&
    selectedComment === null &&
    !filteredCommentsQuery.isLoading &&
    !openCommentsQuery.isLoading;
  const openCommentCounts = useMemo(
    () => slideOpenCommentCounts(openCommentsQuery.data ?? []),
    [openCommentsQuery.data],
  );
  const commentTarget = useMemo(
    () =>
      activeSlide === null
        ? null
        : slidesCommentTarget({
            deckId,
            slide: activeSlide,
            slideIndex: activeSlideIndex,
            shape: activeShape,
            shapeIndex: activeShapeIndex,
          }),
    [activeShape, activeShapeIndex, activeSlide, activeSlideIndex, deckId],
  );

  useEffect(() => {
    setPresentSlideIndex((current) => Math.min(current, Math.max(slides.length - 1, 0)));
  }, [slides.length]);

  useEffect(() => {
    const provider = new NativePresentationSyncProvider({
      deckId,
      onStatusChange: setSyncStatus,
      onSnapshot: (snapshot) => {
        queryClient.setQueryData(slidesQueryKeys.deckDetail(deckId), snapshot);
        setActiveSlideId((current) => {
          if (current !== null && snapshot.slides.some((slide) => slide.id === current)) {
            return current;
          }
          return snapshot.slides[0]?.id ?? null;
        });
      },
      onOperation: (frame) => {
        if (
          frame.operation.kind === "create-slide" &&
          pendingCreateOperationIdRef.current === frame.operationId
        ) {
          const selectedPosition = pendingCreatePositionRef.current;
          pendingCreateOperationIdRef.current = null;
          pendingCreatePositionRef.current = null;
          setActiveSlideId(
            selectedPosition === null
              ? (frame.slides.at(-1)?.id ?? null)
              : (frame.slides[selectedPosition]?.id ?? frame.slides.at(-1)?.id ?? null),
          );
        }
      },
      onAwareness: (frame) => {
        setCollaborators((current) => {
          const remaining = current.filter(
            (collaborator) => collaborator.actorId !== frame.actorId,
          );
          if (frame.status === "left") {
            return remaining;
          }
          return [...remaining, frame].sort((left, right) =>
            left.displayName.localeCompare(right.displayName),
          );
        });
      },
    });
    syncProviderRef.current = provider;
    provider.connect();
    return () => {
      setCollaborators([]);
      provider.disconnect();
      if (syncProviderRef.current === provider) {
        syncProviderRef.current = null;
      }
    };
  }, [deckId, queryClient]);

  useEffect(() => {
    syncProviderRef.current?.sendAwareness({
      selectedSlideId: activeSlide?.id ?? null,
      selectedShapeId: presenting ? null : activeShapeId,
      mode: presenting ? "presenting" : "editing",
    });
  }, [activeShapeId, activeSlide?.id, presenting, syncStatus]);

  useEffect(() => {
    setActiveShapeId(null);
  }, [activeSlide?.id]);

  const onActiveShapeChange = useCallback(
    (shapeId: string | null) => {
      setActiveShapeId(shapeId);
      setShapeFocusRequest((current) =>
        current !== null && current.slideId === activeSlide?.id && current.shapeId === shapeId
          ? null
          : current,
      );
    },
    [activeSlide?.id],
  );

  const focusCommentAnchor = useCallback(
    (comment: SlidesDriveComment) => {
      const slideId = slidesCommentSlideId(comment);
      const shapeId = slidesCommentShapeId(comment);
      if (slideId !== null && slides.some((slide) => slide.id === slideId)) {
        setActiveSlideId(slideId);
        setShapeFocusRequest(shapeId === null ? null : { slideId, shapeId });
      }
      if (shapeId === null) {
        setActiveShapeId(null);
      }
    },
    [slides],
  );

  useEffect(() => {
    if (routeCommentIdRef.current === routeCommentId) {
      return;
    }
    routeCommentIdRef.current = routeCommentId;
    suppressRouteEmitRef.current = true;
    setSelectedCommentId(routeCommentId);
    if (routeCommentId !== null) {
      setCommentStatusFilter("all");
    }
  }, [routeCommentId]);

  useEffect(() => {
    if (selectedCommentId === routeCommentId) {
      suppressRouteEmitRef.current = false;
      return;
    }
    if (suppressRouteEmitRef.current) {
      return;
    }
    onRouteStateChange?.({ commentId: selectedCommentId });
  }, [onRouteStateChange, routeCommentId, selectedCommentId]);

  useEffect(() => {
    if (selectedComment !== null) {
      focusCommentAnchor(selectedComment);
    }
  }, [focusCommentAnchor, selectedComment]);

  useEffect(() => {
    if (selectedThreadId === null) {
      return;
    }
    commentRefs.current[selectedThreadId]?.scrollIntoView?.({ block: "nearest" });
  }, [selectedThreadId]);

  const openDeckMediaAsset = useCallback((slideId: string, shapeId: string) => {
    setShapeFocusRequest({ slideId, shapeId });
    setActiveSlideId(slideId);
  }, []);

  function updateDeckMediaAssetPlayback(
    slide: SlidesApiSlide,
    shapeId: string,
    playback: DeckMediaPlaybackUpdate,
  ) {
    saveSlide(
      slide.id,
      slideContentWithUpdatedShape(slide.content, shapeId, (shape) =>
        normalizeSlideShape({ ...shape, ...playback }),
      ),
      slide.speakerNotes,
    );
  }

  function replaceDeckMediaAssetSource(slide: SlidesApiSlide, shapeId: string, objectId: string) {
    if (objectId.length === 0) {
      return;
    }
    const asset = driveMediaAssets.find((entry) => entry.id === objectId);
    const mediaType = asset === undefined ? null : driveEntryMediaType(asset);
    if (asset === undefined || mediaType === null) {
      return;
    }
    saveSlide(
      slide.id,
      slideContentWithUpdatedShape(slide.content, shapeId, (shape) => {
        if (shape.kind !== "media") {
          return shape;
        }
        const currentTitle = shape.mediaTitle?.trim() ?? "";
        return normalizeSlideShape({
          ...shape,
          mediaUrl: driveObjectContentUrl(asset.id),
          mediaType,
          mediaTitle: currentTitle.length > 0 ? currentTitle : labelFromFilename(asset.name),
        });
      }),
      slide.speakerNotes,
    );
  }

  function replaceDeckMediaAssetPoster(slide: SlidesApiSlide, shapeId: string, objectId: string) {
    if (objectId.length === 0) {
      return;
    }
    const asset = driveImageAssets.find((entry) => entry.id === objectId);
    if (asset === undefined) {
      return;
    }
    saveSlide(
      slide.id,
      slideContentWithUpdatedShape(slide.content, shapeId, (shape) =>
        shape.kind === "media"
          ? normalizeSlideShape({ ...shape, mediaPosterUrl: driveObjectContentUrl(asset.id) })
          : shape,
      ),
      slide.speakerNotes,
    );
  }

  function replaceBlockingDeckMediaSources(mediaType: SlideMediaType, objectId: string) {
    if (objectId.length === 0) {
      return;
    }
    const asset = driveMediaAssets.find((entry) => entry.id === objectId);
    if (asset === undefined || driveEntryMediaType(asset) !== mediaType) {
      return;
    }
    for (const slide of slides) {
      const nextContent = slideContentWithUpdatedMediaShapes(slide.content, (shape) => {
        if (
          shape.kind !== "media" ||
          (shape.mediaType ?? "video") !== mediaType ||
          !mediaAssetIssues(shape).some((issue) => MEDIA_EXPORT_BLOCKING_ISSUES.has(issue))
        ) {
          return shape;
        }
        const currentTitle = shape.mediaTitle?.trim() ?? "";
        return normalizeSlideShape({
          ...shape,
          mediaUrl: driveObjectContentUrl(asset.id),
          mediaType,
          mediaTitle: currentTitle.length > 0 ? currentTitle : labelFromFilename(asset.name),
        });
      });
      if (nextContent !== null) {
        saveSlide(slide.id, nextContent, slide.speakerNotes);
      }
    }
  }

  function replaceDuplicateDeckMediaSources(mediaType: SlideMediaType, objectId: string) {
    if (objectId.length === 0) {
      return;
    }
    const asset = driveMediaAssets.find((entry) => entry.id === objectId);
    if (asset === undefined || driveEntryMediaType(asset) !== mediaType) {
      return;
    }
    const duplicateTargets = new Set(
      mediaDuplicateReplacementRows(deckMediaAssetRows(slides), mediaType).map(
        (row) => `${row.slide.id}:${row.shape.id}`,
      ),
    );
    if (duplicateTargets.size === 0) {
      return;
    }
    for (const slide of slides) {
      const nextContent = slideContentWithUpdatedMediaShapes(slide.content, (shape) => {
        if (
          shape.kind !== "media" ||
          !duplicateTargets.has(`${slide.id}:${shape.id}`) ||
          (shape.mediaType ?? "video") !== mediaType
        ) {
          return shape;
        }
        const currentTitle = shape.mediaTitle?.trim() ?? "";
        return normalizeSlideShape({
          ...shape,
          mediaUrl: driveObjectContentUrl(asset.id),
          mediaType,
          mediaTitle: currentTitle.length > 0 ? currentTitle : labelFromFilename(asset.name),
        });
      });
      if (nextContent !== null) {
        saveSlide(slide.id, nextContent, slide.speakerNotes);
      }
    }
  }

  function applyDeckMediaAction(action: DeckMediaAction) {
    for (const slide of slides) {
      const nextContent = slideContentWithUpdatedMediaShapes(slide.content, (shape) => {
        if (shape.kind !== "media" || shape.mediaType === "audio") {
          return shape;
        }

        switch (action) {
          case "muteVideo":
            return shape.mediaMuted === true
              ? shape
              : normalizeSlideShape({ ...shape, mediaMuted: true });
          case "disableAutoplay":
            return shape.mediaAutoplay === true
              ? normalizeSlideShape({ ...shape, mediaAutoplay: false })
              : shape;
          case "disableLoop":
            return shape.mediaLoop === true
              ? normalizeSlideShape({ ...shape, mediaLoop: false })
              : shape;
          case "resetTrims":
            if (shape.mediaStartSeconds === undefined && shape.mediaEndSeconds === undefined) {
              return shape;
            }
            return normalizeSlideShape(shapeWithoutMediaTrim(shape));
        }
      });

      if (nextContent !== null) {
        saveSlide(slide.id, nextContent, slide.speakerNotes);
      }
    }
  }

  const createMutation = useMutation({
    mutationFn: (input: {
      readonly content: SlideContent;
      readonly speakerNotes: string;
      readonly position?: number;
    }) =>
      createSlidesSlide({
        deckId,
        content: input.content,
        speakerNotes: input.speakerNotes,
        ...(input.position === undefined ? {} : { position: input.position }),
      }),
    onMutate: () => undefined,
    onSuccess: async (slide) => {
      setActiveSlideId(slide.id);
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.deckDetail(deckId) });
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.all });
    },
    onError: () => undefined,
  });

  const updateMutation = useMutation({
    mutationFn: (input: {
      readonly slideId: string;
      readonly content: SlideContent;
      readonly speakerNotes: string;
    }) => updateSlidesSlide(input),
    onMutate: () => undefined,
    onSuccess: async (slide) => {
      setActiveSlideId(slide.id);
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.deckDetail(deckId) });
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.all });
    },
    onError: () => undefined,
  });

  const deleteMutation = useMutation({
    mutationFn: (slideId: string) => deleteSlidesSlide({ slideId }),
    onMutate: () => undefined,
    onSuccess: async (_result, slideId) => {
      setActiveSlideId((current) => {
        if (current !== slideId) return current;
        const remaining = slides.filter((slide) => slide.id !== slideId);
        const deletedIndex = slides.findIndex((slide) => slide.id === slideId);
        return remaining[Math.min(deletedIndex, remaining.length - 1)]?.id ?? null;
      });
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.deckDetail(deckId) });
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.all });
    },
    onError: () => undefined,
  });

  const reorderMutation = useMutation({
    mutationFn: (slideIds: readonly string[]) => reorderSlidesSlides({ deckId, slideIds }),
    onMutate: () => undefined,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.deckDetail(deckId) });
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.all });
    },
    onError: () => undefined,
  });

  const themeMutation = useMutation({
    mutationFn: (theme: SlideTheme) => {
      const latestDeckDetail = queryClient.getQueryData<SlidesApiDeckDetail>(
        slidesQueryKeys.deckDetail(deckId),
      );
      return updateSlidesDeck({
        deckId,
        metadata: metadataWithTheme(
          latestDeckDetail?.deck.metadata ?? deckQuery.data?.deck.metadata ?? {},
          theme,
        ),
      });
    },
    onMutate: () => undefined,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.deckDetail(deckId) });
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.all });
    },
    onError: () => undefined,
  });

  const exportMutation = useMutation({
    mutationFn: (format: SlidesExportResult["format"]) => exportSlidesDeck({ deckId, format }),
    onMutate: () => undefined,
    onSuccess: (exported) => {
      downloadSlidesExport(exported);
    },
    onError: () => undefined,
  });

  const createCommentMutation = useMutation({
    mutationFn: (input: {
      readonly body: string;
      readonly anchor: Record<string, unknown>;
      readonly metadata: Record<string, unknown>;
      readonly parentCommentId?: string;
    }) => createSlidesComment({ deckId, ...input }),
    onMutate: () => undefined,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.deckComments(deckId) });
    },
    onError: () => undefined,
  });

  const resolveCommentMutation = useMutation({
    mutationFn: (commentId: string) => resolveSlidesComment({ commentId }),
    onMutate: () => undefined,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.deckComments(deckId) });
    },
    onError: () => undefined,
  });

  const reopenCommentMutation = useMutation({
    mutationFn: (commentId: string) => reopenSlidesComment({ commentId }),
    onMutate: () => undefined,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.deckComments(deckId) });
    },
    onError: () => undefined,
  });

  const updateCommentMutation = useMutation({
    mutationFn: (input: { readonly commentId: string; readonly body: string }) =>
      updateSlidesComment(input),
    onMutate: () => undefined,
    onSuccess: async () => {
      setEditingCommentId(null);
      setEditCommentDraft("");
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.deckComments(deckId) });
    },
    onError: () => undefined,
  });

  const deleteCommentMutation = useMutation({
    mutationFn: (commentId: string) => deleteSlidesComment({ commentId }),
    onMutate: () => undefined,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.deckComments(deckId) });
    },
    onError: () => undefined,
  });

  const isSaving =
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending ||
    reorderMutation.isPending ||
    themeMutation.isPending;
  const collaboratorSummary =
    collaborators.length === 0
      ? null
      : `${collaborators.length} collaborator${collaborators.length === 1 ? "" : "s"}`;
  const activeRemoteShapeSelections = useMemo(
    () =>
      activeSlide === null
        ? []
        : collaborators
            .filter(
              (
                collaborator,
              ): collaborator is PresentationCollaborator & { readonly selectedShapeId: string } =>
                collaborator.selectedSlideId === activeSlide.id &&
                collaborator.selectedShapeId !== null,
            )
            .map((collaborator) => ({
              actorId: collaborator.actorId,
              displayName: collaborator.displayName,
              shapeId: collaborator.selectedShapeId,
            })),
    [activeSlide, collaborators],
  );

  function createSlide() {
    createSlideAt({
      content: emptySlideContent("bullets"),
      speakerNotes: "",
    });
  }

  function duplicateSlide(slide: SlidesApiSlide) {
    const index = slides.findIndex((candidate) => candidate.id === slide.id);
    createSlideAt({
      content: cloneSlideContent(slide.content),
      speakerNotes: slide.speakerNotes,
      position: index < 0 ? slides.length : index + 1,
    });
  }

  function createSlideAt(input: {
    readonly content: SlideContent;
    readonly speakerNotes: string;
    readonly position?: number;
  }) {
    const operationId = syncProviderRef.current?.sendOperation({
      kind: "create-slide",
      content: input.content,
      speakerNotes: input.speakerNotes,
      ...(input.position === undefined ? {} : { position: input.position }),
    });
    if (operationId !== null && operationId !== undefined) {
      pendingCreateOperationIdRef.current = operationId;
      pendingCreatePositionRef.current = input.position ?? null;
      return;
    }
    createMutation.mutate(input);
  }

  function updateTheme(theme: SlideTheme) {
    const latestDeckDetail = queryClient.getQueryData<SlidesApiDeckDetail>(
      slidesQueryKeys.deckDetail(deckId),
    );
    const metadata = metadataWithTheme(
      latestDeckDetail?.deck.metadata ?? deckQuery.data?.deck.metadata ?? {},
      theme,
    );
    const operationId = syncProviderRef.current?.sendOperation({
      kind: "update-deck",
      metadata,
    });
    if (operationId !== null && operationId !== undefined) {
      return;
    }
    themeMutation.mutate(theme);
  }

  function moveSlide(slideId: string, direction: -1 | 1) {
    const index = slides.findIndex((slide) => slide.id === slideId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= slides.length || reorderMutation.isPending) {
      return;
    }
    const slideIds = slides.map((slide) => slide.id);
    const currentSlideId = slideIds[index];
    const targetSlideId = slideIds[targetIndex];
    if (currentSlideId === undefined || targetSlideId === undefined) {
      return;
    }
    slideIds[index] = targetSlideId;
    slideIds[targetIndex] = currentSlideId;
    const operationId = syncProviderRef.current?.sendOperation({
      kind: "reorder-slides",
      slideIds,
    });
    if (operationId !== null && operationId !== undefined) {
      return;
    }
    reorderMutation.mutate(slideIds);
  }

  function removeSlide(slideId: string) {
    const operationId = syncProviderRef.current?.sendOperation({
      kind: "delete-slide",
      slideId,
    });
    if (operationId !== null && operationId !== undefined) {
      return;
    }
    deleteMutation.mutate(slideId);
  }

  function submitNewComment() {
    const body = newCommentDraft.trim();
    if (body.length === 0 || commentTarget === null || createCommentMutation.isPending) {
      return;
    }
    setNewCommentDraft("");
    createCommentMutation.mutate({
      body,
      anchor: commentTarget.anchor,
      metadata: slidesCommentMetadataWithMentions(commentTarget.metadata, body),
    });
  }

  function submitReply(parent: SlidesDriveComment) {
    const body = (replyDrafts[parent.id] ?? "").trim();
    if (body.length === 0 || createCommentMutation.isPending) {
      return;
    }
    setReplyDrafts((current) => ({ ...current, [parent.id]: "" }));
    createCommentMutation.mutate({
      body,
      anchor: parent.anchor,
      metadata: slidesCommentMetadataWithMentions(
        {
          ...slidesCommentMetadataWithoutMentions(parent.metadata),
          source: "web.native-presentation-editor.comments.reply",
          parentCommentId: parent.id,
        },
        body,
      ),
      parentCommentId: parent.id,
    });
  }

  function startEditingComment(comment: SlidesDriveComment) {
    setEditingCommentId(comment.id);
    setEditCommentDraft(comment.body);
  }

  function submitCommentEdit(comment: SlidesDriveComment) {
    const body = editCommentDraft.trim();
    if (body.length === 0 || updateCommentMutation.isPending) {
      return;
    }
    updateCommentMutation.mutate({ commentId: comment.id, body });
  }

  function openCommentAnchor(comment: SlidesDriveComment) {
    setSelectedCommentId(comment.id);
    focusCommentAnchor(comment);
  }

  function clearLinkedComment() {
    setSelectedCommentId(null);
  }

  async function copySlidesCommentLink(comment: SlidesDriveComment) {
    await writeClipboardText(buildSlidesCommentLink({ deckId, commentId: comment.id }));
  }

  function startPresenting() {
    if (slides.length === 0) {
      return;
    }
    setPresentSlideIndex(activeSlideIndex);
    setPresenting(true);
  }

  function exportDeck(format: SlidesExportResult["format"]) {
    if (deckExportBlocked) {
      return;
    }
    exportMutation.mutate(format);
  }

  function saveSlide(slideId: string, content: SlideContent, speakerNotes: string) {
    const operationId = syncProviderRef.current?.sendOperation({
      kind: "update-slide",
      slideId,
      content,
      speakerNotes,
    });
    if (operationId !== null && operationId !== undefined) {
      return;
    }
    updateMutation.mutate({ slideId, content, speakerNotes });
  }

  commandHandlersRef.current = {
    addSlide: createSlide,
    duplicateSlide: () => {
      if (activeSlide !== null) {
        duplicateSlide(activeSlide);
      }
    },
    presentDeck: startPresenting,
    exportPptx: () => exportDeck("pptx"),
    exportPdf: () => exportDeck("pdf"),
    exportSvgSeries: () => exportDeck("svg-series"),
  };

  useEffect(() => {
    const deckTitle = deckQuery.data?.deck.title;
    if (deckTitle === undefined) {
      return undefined;
    }
    const run = (command: keyof NativePresentationCommandHandlers) => () => {
      commandHandlersRef.current[command]();
    };
    const exportDisabledReason = deckExportBlocked
      ? deckExportBlockedTitle(deckExportReadiness)
      : exportMutation.isPending
        ? "Export already in progress."
        : undefined;
    const exportCommands = [
      {
        id: `slides:${deckId}:export-pptx`,
        pluginId: "com.helix.slides",
        label: "Export deck as PPTX",
        group: "Presentation",
        keywords: ["export", "download", "powerpoint", "pptx", deckTitle],
        disabledReason: exportDisabledReason,
        order: 100,
        run: run("exportPptx"),
      },
      {
        id: `slides:${deckId}:export-pdf`,
        pluginId: "com.helix.slides",
        label: "Export deck as PDF",
        group: "Presentation",
        keywords: ["export", "download", "pdf", deckTitle],
        disabledReason: exportDisabledReason,
        order: 110,
        run: run("exportPdf"),
      },
      {
        id: `slides:${deckId}:export-svg-series`,
        pluginId: "com.helix.slides",
        label: "Export deck as SVG ZIP",
        group: "Presentation",
        keywords: ["export", "download", "svg", "images", "zip", deckTitle],
        disabledReason: exportDisabledReason,
        order: 120,
        run: run("exportSvgSeries"),
      },
    ];
    return platformHost.registerCommandPaletteItems([
      {
        id: `slides:${deckId}:add-slide`,
        pluginId: "com.helix.slides",
        label: "Add slide",
        group: "Presentation",
        keywords: ["new", "create", "slide", deckTitle],
        order: 10,
        run: run("addSlide"),
      },
      {
        id: `slides:${deckId}:duplicate-slide`,
        pluginId: "com.helix.slides",
        label: "Duplicate current slide",
        group: "Presentation",
        keywords: ["copy", "duplicate", "current slide", activeSlide?.content.title ?? deckTitle],
        order: 20,
        run: run("duplicateSlide"),
      },
      {
        id: `slides:${deckId}:present`,
        pluginId: "com.helix.slides",
        label: "Present deck",
        group: "Presentation",
        keywords: ["present", "slideshow", "presentation", deckTitle],
        shortcut: "Slides",
        order: 30,
        run: run("presentDeck"),
      },
      ...exportCommands,
    ]);
  }, [
    activeSlide?.content.title,
    deckExportBlocked,
    deckExportReadiness,
    deckId,
    deckQuery.data?.deck.title,
    exportMutation.isPending,
    platformHost,
  ]);

  if (deckQuery.isLoading) {
    return <EditorNotice icon={<Icons.Image />} text="Loading deck..." />;
  }

  if (deckQuery.isError || deckQuery.data === undefined) {
    return <EditorNotice icon={<Icons.Globe />} text="Presentation unavailable." />;
  }

  return (
    <div style={EDITOR_STYLE}>
      <style>{SLIDE_SHAPE_ANIMATION_KEYFRAMES}</style>
      <div style={HEADER_STYLE}>
        <button
          type="button"
          className="icon-btn"
          onClick={onBack}
          aria-label="Back to slides list"
        >
          <Icons.ArrowLeft />
        </button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="truncate" style={TITLE_STYLE}>
            {deckQuery.data.deck.title}
          </div>
          <div style={META_STYLE}>
            {isSaving
              ? "Saving..."
              : syncStatus === "connected"
                ? `Live collaboration connected${collaboratorSummary === null ? "" : ` · ${collaboratorSummary}`}`
                : "All changes saved"}
          </div>
        </div>
        {collaborators.length > 0 ? (
          <div aria-label="Active collaborators" style={COLLABORATOR_ROW_STYLE}>
            {collaborators.slice(0, 4).map((collaborator) => {
              return (
                <span
                  key={collaborator.actorId}
                  title={collaboratorPresenceTitle(collaborator, slides)}
                  style={COLLABORATOR_BADGE_STYLE}
                >
                  {initials(collaborator.displayName)}
                </span>
              );
            })}
          </div>
        ) : null}
        <label style={THEME_CONTROL_STYLE}>
          <span style={LABEL_STYLE}>Theme</span>
          <select
            aria-label="Deck theme"
            value={deckTheme}
            disabled={themeMutation.isPending}
            onChange={(event) => updateTheme(event.target.value as SlideTheme)}
            style={HEADER_SELECT_STYLE}
          >
            {SLIDE_THEME_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn sm primary"
          disabled={createMutation.isPending}
          onClick={createSlide}
        >
          <Icons.Plus /> Add slide
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={slides.length === 0}
          onClick={startPresenting}
        >
          Present
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={exportMutation.isPending || deckExportBlocked}
          title={deckExportBlocked ? deckExportBlockedTitle(deckExportReadiness) : undefined}
          onClick={() => exportDeck("pptx")}
        >
          <Icons.Download /> PPTX
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={exportMutation.isPending || deckExportBlocked}
          title={deckExportBlocked ? deckExportBlockedTitle(deckExportReadiness) : undefined}
          onClick={() => exportDeck("pdf")}
        >
          <Icons.Download /> PDF
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={exportMutation.isPending || deckExportBlocked}
          title={deckExportBlocked ? deckExportBlockedTitle(deckExportReadiness) : undefined}
          onClick={() => exportDeck("svg-series")}
        >
          <Icons.Download /> SVG ZIP
        </button>
        {deckExportBlocked ? (
          <span style={EXPORT_GATE_STATUS_STYLE} role="status">
            Resolve {String(deckExportReadiness.exportBlockers)} media export blocker
            {deckExportReadiness.exportBlockers === 1 ? "" : "s"} before export.
          </span>
        ) : null}
      </div>

      <div style={BODY_STYLE}>
        <aside style={THUMB_RAIL_STYLE} aria-label="Slides">
          {slides.length === 0 ? (
            <p style={EMPTY_STYLE}>No slides</p>
          ) : (
            slides.map((slide, index) => {
              const openCommentCount = openCommentCounts.get(slide.id) ?? 0;
              return (
                <div
                  key={slide.id}
                  style={{
                    ...THUMB_ROW_STYLE,
                    borderColor: activeSlide?.id === slide.id ? "var(--accent)" : "var(--border)",
                  }}
                >
                  <button
                    type="button"
                    aria-pressed={activeSlide?.id === slide.id}
                    onClick={() => setActiveSlideId(slide.id)}
                    style={THUMB_SELECT_STYLE}
                  >
                    <span style={THUMB_INDEX_STYLE}>{index + 1}</span>
                    <span className="truncate" style={THUMB_TITLE_STYLE}>
                      {slideTitle(slide.content)}
                    </span>
                    {openCommentCount > 0 ? (
                      <span
                        style={THUMB_COMMENT_BADGE_STYLE}
                        aria-label={`${String(openCommentCount)} open comments for ${slideTitle(
                          slide.content,
                        )}`}
                      >
                        {openCommentCount}
                      </span>
                    ) : null}
                  </button>
                  <span style={THUMB_ACTIONS_STYLE}>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Move ${slideTitle(slide.content)} up`}
                      disabled={index === 0 || reorderMutation.isPending}
                      onClick={() => moveSlide(slide.id, -1)}
                      title="Move up"
                    >
                      <Icons.ChevronDown style={{ transform: "rotate(180deg)" }} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Move ${slideTitle(slide.content)} down`}
                      disabled={index === slides.length - 1 || reorderMutation.isPending}
                      onClick={() => moveSlide(slide.id, 1)}
                      title="Move down"
                    >
                      <Icons.ChevronDown />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Duplicate ${slideTitle(slide.content)}`}
                      disabled={createMutation.isPending}
                      onClick={() => duplicateSlide(slide)}
                      title="Duplicate slide"
                    >
                      <Icons.Copy />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Delete ${slideTitle(slide.content)}`}
                      disabled={deleteMutation.isPending}
                      onClick={() => removeSlide(slide.id)}
                      title="Delete slide"
                    >
                      <Icons.Trash />
                    </button>
                  </span>
                </div>
              );
            })
          )}
          <DeckMediaAssetTable
            slides={slides}
            activeSlideId={activeSlide?.id ?? null}
            driveImageAssets={driveImageAssets}
            driveMediaAssets={driveMediaAssets}
            onOpenMediaAsset={openDeckMediaAsset}
            onApplyDeckMediaAction={applyDeckMediaAction}
            onUpdateMediaPlayback={updateDeckMediaAssetPlayback}
            onReplaceMediaSource={replaceDeckMediaAssetSource}
            onReplaceMediaPoster={replaceDeckMediaAssetPoster}
            onReplaceBlockingSources={replaceBlockingDeckMediaSources}
            onReplaceDuplicateSources={replaceDuplicateDeckMediaSources}
          />
          <DeckAnimationTimelineTable
            slides={slides}
            activeSlideId={activeSlide?.id ?? null}
            onSelectSlide={setActiveSlideId}
          />
        </aside>

        <main style={CANVAS_COLUMN_STYLE}>
          {activeSlide === null ? (
            <div style={EMPTY_CANVAS_STYLE}>
              <p style={EMPTY_STYLE}>Create a slide to start editing this deck.</p>
            </div>
          ) : (
            <>
              <SlideEditor
                slide={activeSlide}
                theme={deckTheme}
                saving={updateMutation.isPending}
                onSave={(content, speakerNotes) => saveSlide(activeSlide.id, content, speakerNotes)}
                onSelectedShapeChange={onActiveShapeChange}
                requestedSelectedShapeId={
                  shapeFocusRequest?.slideId === activeSlide.id ? shapeFocusRequest.shapeId : null
                }
                remoteShapeSelections={activeRemoteShapeSelections}
              />
              <SlidesCommentsRail
                comments={commentThreads}
                filter={commentStatusFilter}
                loading={filteredCommentsQuery.isLoading || openCommentsQuery.isLoading}
                selectedThreadId={selectedThreadId}
                linkedCommentUnavailable={linkedCommentUnavailable}
                target={commentTarget}
                newCommentDraft={newCommentDraft}
                replyDrafts={replyDrafts}
                editingCommentId={editingCommentId}
                editCommentDraft={editCommentDraft}
                mentionOptions={mentionOptions}
                slides={slides}
                busy={
                  createCommentMutation.isPending ||
                  resolveCommentMutation.isPending ||
                  reopenCommentMutation.isPending ||
                  updateCommentMutation.isPending ||
                  deleteCommentMutation.isPending
                }
                onFilterChange={setCommentStatusFilter}
                onNewCommentDraftChange={setNewCommentDraft}
                onReplyDraftChange={(commentId, value) =>
                  setReplyDrafts((current) => ({ ...current, [commentId]: value }))
                }
                onEditDraftChange={setEditCommentDraft}
                onSubmitNewComment={submitNewComment}
                onSubmitReply={submitReply}
                onStartEdit={startEditingComment}
                onCancelEdit={() => {
                  setEditingCommentId(null);
                  setEditCommentDraft("");
                }}
                onSubmitEdit={submitCommentEdit}
                onResolve={(comment) => resolveCommentMutation.mutate(comment.id)}
                onReopen={(comment) => reopenCommentMutation.mutate(comment.id)}
                onDelete={(comment) => deleteCommentMutation.mutate(comment.id)}
                onOpenComment={openCommentAnchor}
                onClearLinkedComment={clearLinkedComment}
                onCopyCommentLink={copySlidesCommentLink}
                onThreadElement={(commentId, element) => {
                  commentRefs.current[commentId] = element;
                }}
              />
            </>
          )}
        </main>
      </div>
      {presenting ? (
        <PresentationMode
          deckTitle={deckQuery.data.deck.title}
          slides={slides}
          theme={deckTheme}
          slideIndex={presentSlideIndex}
          onSelectSlide={(index) => {
            const nextSlide = slides[index];
            setPresentSlideIndex(index);
            setActiveSlideId(nextSlide?.id ?? null);
          }}
          onClose={() => setPresenting(false)}
        />
      ) : null}
    </div>
  );
}

function SlidesCommentsRail({
  comments,
  filter,
  loading,
  selectedThreadId,
  linkedCommentUnavailable,
  target,
  newCommentDraft,
  replyDrafts,
  editingCommentId,
  editCommentDraft,
  mentionOptions,
  slides,
  busy,
  onFilterChange,
  onNewCommentDraftChange,
  onReplyDraftChange,
  onEditDraftChange,
  onSubmitNewComment,
  onSubmitReply,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onResolve,
  onReopen,
  onDelete,
  onOpenComment,
  onClearLinkedComment,
  onCopyCommentLink,
  onThreadElement,
}: {
  readonly comments: readonly SlidesCommentThread[];
  readonly filter: SlidesCommentStatus;
  readonly loading: boolean;
  readonly selectedThreadId: string | null;
  readonly linkedCommentUnavailable: boolean;
  readonly target: SlidesCommentTarget | null;
  readonly newCommentDraft: string;
  readonly replyDrafts: Record<string, string>;
  readonly editingCommentId: string | null;
  readonly editCommentDraft: string;
  readonly mentionOptions: readonly SlidesMentionOption[];
  readonly slides: readonly SlidesApiSlide[];
  readonly busy: boolean;
  readonly onFilterChange: (filter: SlidesCommentStatus) => void;
  readonly onNewCommentDraftChange: (value: string) => void;
  readonly onReplyDraftChange: (commentId: string, value: string) => void;
  readonly onEditDraftChange: (value: string) => void;
  readonly onSubmitNewComment: () => void;
  readonly onSubmitReply: (comment: SlidesDriveComment) => void;
  readonly onStartEdit: (comment: SlidesDriveComment) => void;
  readonly onCancelEdit: () => void;
  readonly onSubmitEdit: (comment: SlidesDriveComment) => void;
  readonly onResolve: (comment: SlidesDriveComment) => void;
  readonly onReopen: (comment: SlidesDriveComment) => void;
  readonly onDelete: (comment: SlidesDriveComment) => void;
  readonly onOpenComment: (comment: SlidesDriveComment) => void;
  readonly onClearLinkedComment: () => void;
  readonly onCopyCommentLink: (comment: SlidesDriveComment) => void | Promise<void>;
  readonly onThreadElement: (commentId: string, element: HTMLLIElement | null) => void;
}) {
  return (
    <aside style={COMMENTS_RAIL_STYLE} aria-label="Slides review comments">
      <div style={COMMENTS_HEADER_STYLE}>
        <strong>Review comments</strong>
        <select
          aria-label="Slides comment status"
          value={filter}
          onChange={(event) => onFilterChange(event.target.value as SlidesCommentStatus)}
          style={DECK_MEDIA_FILTER_SELECT_STYLE}
        >
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </select>
      </div>
      {target === null ? null : (
        <div style={COMMENT_COMPOSER_STYLE}>
          <span style={LABEL_STYLE}>{target.label}</span>
          <SlidesMentionTextarea
            aria-label="Slides comment"
            value={newCommentDraft}
            onChange={onNewCommentDraftChange}
            mentionOptions={mentionOptions}
            rows={3}
            style={TEXTAREA_STYLE}
          />
          <button
            type="button"
            className="btn sm primary"
            disabled={busy || newCommentDraft.trim().length === 0}
            onClick={onSubmitNewComment}
          >
            {target.buttonLabel}
          </button>
        </div>
      )}
      {loading ? <p style={EMPTY_STYLE}>Loading comments...</p> : null}
      {linkedCommentUnavailable ? (
        <div role="status" style={COMMENT_LINK_NOTICE_STYLE}>
          <span>Linked Slides comment is unavailable or no longer visible.</span>
          <button type="button" className="btn sm" onClick={onClearLinkedComment}>
            Clear link
          </button>
        </div>
      ) : null}
      {!loading && comments.length === 0 ? <p style={EMPTY_STYLE}>No comments</p> : null}
      <ol style={COMMENT_THREAD_LIST_STYLE} aria-label="Slides comments">
        {comments.map((thread) => {
          const isSelected = thread.root.id === selectedThreadId;
          return (
            <li
              key={thread.root.id}
              ref={(element) => onThreadElement(thread.root.id, element)}
              aria-current={isSelected ? "true" : undefined}
              style={isSelected ? COMMENT_THREAD_SELECTED_STYLE : COMMENT_THREAD_STYLE}
            >
              <SlidesCommentCard
                comment={thread.root}
                slides={slides}
                busy={busy}
                editingCommentId={editingCommentId}
                editCommentDraft={editCommentDraft}
                onEditDraftChange={onEditDraftChange}
                onStartEdit={onStartEdit}
                onCancelEdit={onCancelEdit}
                onSubmitEdit={onSubmitEdit}
                onResolve={onResolve}
                onReopen={onReopen}
                onDelete={onDelete}
                onOpenComment={onOpenComment}
                onCopyCommentLink={onCopyCommentLink}
              />
              {thread.replies.length > 0 ? (
                <ol style={COMMENT_REPLY_LIST_STYLE} aria-label={`Replies for ${thread.root.id}`}>
                  {thread.replies.map((reply) => (
                    <li key={reply.id}>
                      <SlidesCommentCard
                        comment={reply}
                        slides={slides}
                        busy={busy}
                        editingCommentId={editingCommentId}
                        editCommentDraft={editCommentDraft}
                        onEditDraftChange={onEditDraftChange}
                        onStartEdit={onStartEdit}
                        onCancelEdit={onCancelEdit}
                        onSubmitEdit={onSubmitEdit}
                        onResolve={onResolve}
                        onReopen={onReopen}
                        onDelete={onDelete}
                        onOpenComment={onOpenComment}
                        onCopyCommentLink={onCopyCommentLink}
                      />
                    </li>
                  ))}
                </ol>
              ) : null}
              {thread.root.status === "open" ? (
                <div style={COMMENT_REPLY_FORM_STYLE}>
                  <SlidesMentionTextarea
                    aria-label={`Reply to ${thread.root.id}`}
                    value={replyDrafts[thread.root.id] ?? ""}
                    onChange={(value) => onReplyDraftChange(thread.root.id, value)}
                    mentionOptions={mentionOptions}
                    rows={2}
                    style={TEXTAREA_STYLE}
                  />
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy || (replyDrafts[thread.root.id] ?? "").trim().length === 0}
                    onClick={() => onSubmitReply(thread.root)}
                  >
                    Reply
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

function SlidesMentionTextarea({
  "aria-label": ariaLabel,
  value,
  onChange,
  mentionOptions,
  rows,
  style,
}: {
  readonly "aria-label": string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly mentionOptions: readonly SlidesMentionOption[];
  readonly rows: number;
  readonly style: CSSProperties;
}) {
  const mentionQuery = activeMentionQuery(value);
  const matches =
    mentionQuery === null ? [] : filteredSlidesMentionOptions(mentionOptions, mentionQuery);
  return (
    <div style={MENTION_TEXTAREA_WRAP_STYLE}>
      <textarea
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        style={style}
      />
      {matches.length > 0 ? (
        <div style={MENTION_PICKER_STYLE} role="listbox" aria-label={`${ariaLabel} mentions`}>
          {matches.map((option) => (
            <button
              key={option.person.id}
              type="button"
              style={MENTION_PICKER_OPTION_STYLE}
              role="option"
              aria-label={`Mention ${option.label}`}
              onClick={() => onChange(valueWithInsertedMention(value, option.token))}
            >
              <span style={MENTION_PICKER_NAME_STYLE}>{option.label}</span>
              {option.person.email === null ? null : (
                <span style={MENTION_PICKER_EMAIL_STYLE}>{option.person.email}</span>
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SlidesCommentCard({
  comment,
  slides,
  busy,
  editingCommentId,
  editCommentDraft,
  onEditDraftChange,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onResolve,
  onReopen,
  onDelete,
  onOpenComment,
  onCopyCommentLink,
}: {
  readonly comment: SlidesDriveComment;
  readonly slides: readonly SlidesApiSlide[];
  readonly busy: boolean;
  readonly editingCommentId: string | null;
  readonly editCommentDraft: string;
  readonly onEditDraftChange: (value: string) => void;
  readonly onStartEdit: (comment: SlidesDriveComment) => void;
  readonly onCancelEdit: () => void;
  readonly onSubmitEdit: (comment: SlidesDriveComment) => void;
  readonly onResolve: (comment: SlidesDriveComment) => void;
  readonly onReopen: (comment: SlidesDriveComment) => void;
  readonly onDelete: (comment: SlidesDriveComment) => void;
  readonly onOpenComment: (comment: SlidesDriveComment) => void;
  readonly onCopyCommentLink: (comment: SlidesDriveComment) => void | Promise<void>;
}) {
  const label = slidesCommentAnchorLabel(comment, slides);
  const isEditing = editingCommentId === comment.id;
  return (
    <article style={COMMENT_CARD_STYLE}>
      <div style={COMMENT_CARD_HEADER_STYLE}>
        <button
          type="button"
          className="btn sm"
          aria-label={`Open comment anchor ${comment.id}`}
          onClick={() => onOpenComment(comment)}
        >
          {label}
        </button>
        <span style={COMMENT_HEADER_ACTIONS_STYLE}>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Copy comment link: ${comment.body}`}
            onClick={() => void onCopyCommentLink(comment)}
          >
            <Icons.Link size={14} />
          </button>
          <span style={COMMENT_STATUS_STYLE}>{comment.status}</span>
        </span>
      </div>
      {isEditing ? (
        <div style={COMMENT_EDIT_FORM_STYLE}>
          <textarea
            aria-label={`Edit comment ${comment.id}`}
            value={editCommentDraft}
            onChange={(event) => onEditDraftChange(event.target.value)}
            rows={3}
            style={TEXTAREA_STYLE}
          />
          <span style={COMMENT_ACTION_ROW_STYLE}>
            <button
              type="button"
              className="btn sm primary"
              disabled={busy || editCommentDraft.trim().length === 0}
              aria-label={`Save comment ${comment.id}`}
              onClick={() => onSubmitEdit(comment)}
            >
              Save
            </button>
            <button type="button" className="btn sm" disabled={busy} onClick={onCancelEdit}>
              Cancel
            </button>
          </span>
        </div>
      ) : (
        <p style={COMMENT_BODY_STYLE}>{comment.body}</p>
      )}
      <span style={COMMENT_ACTION_ROW_STYLE}>
        {comment.status === "open" ? (
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            aria-label={`Resolve comment ${comment.id}`}
            onClick={() => onResolve(comment)}
          >
            Resolve
          </button>
        ) : (
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            aria-label={`Reopen comment ${comment.id}`}
            onClick={() => onReopen(comment)}
          >
            Reopen
          </button>
        )}
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          aria-label={`Edit comment ${comment.id}`}
          onClick={() => onStartEdit(comment)}
        >
          Edit
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          aria-label={`Delete comment ${comment.id}`}
          onClick={() => onDelete(comment)}
        >
          Delete
        </button>
      </span>
    </article>
  );
}

export function downloadSlidesExport(exported: {
  readonly filename: string;
  readonly mimeType: string;
  readonly contentBase64: string;
}): void {
  const blob = new Blob([base64ToArrayBuffer(exported.contentBase64)], {
    type: exported.mimeType,
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = exported.filename;
  link.rel = "noopener";
  link.click();
  URL.revokeObjectURL(url);
}

function buildSlidesCommentLink(input: { readonly deckId: string; readonly commentId: string }) {
  const nextUrl =
    typeof window === "undefined"
      ? new URL("http://localhost/slides")
      : new URL(window.location.href);
  nextUrl.pathname = "/slides";
  nextUrl.searchParams.set("deck", input.deckId);
  nextUrl.searchParams.set("comment", input.commentId);
  return nextUrl.href;
}

async function writeClipboardText(text: string): Promise<void> {
  if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
    return;
  }
  await navigator.clipboard.writeText(text);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function PresentationMode({
  deckTitle,
  slides,
  theme,
  slideIndex,
  onSelectSlide,
  onClose,
}: {
  readonly deckTitle: string;
  readonly slides: readonly SlidesApiSlide[];
  readonly theme: SlideTheme;
  readonly slideIndex: number;
  readonly onSelectSlide: (index: number) => void;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const selectedIndex = Math.min(Math.max(slideIndex, 0), Math.max(slides.length - 1, 0));
  const slide = slides[selectedIndex] ?? null;
  const nextSlide = slides[selectedIndex + 1] ?? null;
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingUrlRef = useRef<string | null>(null);
  const recordingPackageUrlRef = useRef<string | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);
  const captionSpeakerRef = useRef("Presenter");
  const [captionStatus, setCaptionStatus] = useState<LiveCaptionStatus>("off");
  const [captionText, setCaptionText] = useState("");
  const [captionTranscriptLines, setCaptionTranscriptLines] = useState<readonly string[]>([]);
  const [captionCues, setCaptionCues] = useState<readonly PresentationCaptionCue[]>([]);
  const [captionPosition, setCaptionPosition] = useState<PresentationCaptionPosition>("bottom");
  const [captionSize, setCaptionSize] = useState<PresentationCaptionSize>("standard");
  const [captionSpeaker, setCaptionSpeaker] = useState("Presenter");
  const [captionTranscriptLibrary, setCaptionTranscriptLibrary] = useState<
    readonly CaptionTranscriptLibraryEntry[]
  >(() => readCaptionTranscriptLibrary());
  const [captionLibraryStatus, setCaptionLibraryStatus] = useState("");
  const [recordingStatus, setRecordingStatus] = useState<PresentationRecordingStatus>("off");
  const [recordingMessage, setRecordingMessage] = useState("");
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null);
  const [recordingPackageUrl, setRecordingPackageUrl] = useState<string | null>(null);
  const [recordingPackageBlob, setRecordingPackageBlob] = useState<Blob | null>(null);
  const [mediaPlaybackStats, setMediaPlaybackStats] = useState<
    Record<string, PresentationMediaPlaybackStats>
  >({});
  const [buildStep, setBuildStep] = useState(0);
  const recordingDriveMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (file: File) => uploadDriveFile({ file, folderId: null }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
    },
  });
  const captionTranscriptDriveMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (file: File) => uploadDriveFile({ file, folderId: null }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
    },
  });
  const animatedShapeCount = slide === null ? 0 : slideAnimatedShapeCount(slide);
  const captionTranscriptHref = useMemo(
    () => captionTranscriptDataUrl(deckTitle, captionTranscriptLines),
    [captionTranscriptLines, deckTitle],
  );
  const captionOverlayStyle = useMemo(
    () => presenterCaptionsStyle(captionPosition),
    [captionPosition],
  );
  const captionTextStyle = useMemo(() => presenterCaptionTextStyle(captionSize), [captionSize]);
  const mediaPlaybackRows = useMemo(
    () => presentationMediaPlaybackRows(slides, mediaPlaybackStats),
    [mediaPlaybackStats, slides],
  );

  useEffect(() => {
    setBuildStep(0);
  }, [slide?.id]);

  useEffect(() => {
    captionSpeakerRef.current = captionSpeaker;
  }, [captionSpeaker]);

  function saveCaptionTranscriptToLibrary() {
    if (captionTranscriptLines.length === 0) {
      return;
    }
    const entry = captionTranscriptLibraryEntry(deckTitle, captionTranscriptLines);
    setCaptionTranscriptLibrary((current) => {
      const next = [entry, ...current.filter((item) => item.id !== entry.id)].slice(
        0,
        CAPTION_TRANSCRIPT_LIBRARY_LIMIT,
      );
      writeCaptionTranscriptLibrary(next);
      return next;
    });
    setCaptionLibraryStatus("Transcript saved to library.");
  }

  function advancePresentation() {
    if (buildStep < animatedShapeCount) {
      setBuildStep((current) => Math.min(current + 1, animatedShapeCount));
      return;
    }
    onSelectSlide(Math.min(selectedIndex + 1, slides.length - 1));
  }

  function rewindPresentation() {
    if (buildStep > 0) {
      setBuildStep((current) => Math.max(current - 1, 0));
      return;
    }
    onSelectSlide(Math.max(selectedIndex - 1, 0));
  }

  function recordMediaPlaybackEvent(
    slideId: string,
    shape: SlideShape,
    event: PresentationMediaPlaybackEvent,
  ) {
    const slideNumber = slides.findIndex((candidate) => candidate.id === slideId) + 1;
    const key = `${slideId}:${shape.id}`;
    setMediaPlaybackStats((current) => {
      const fallback = presentationMediaPlaybackRow({
        slideId,
        slideNumber: slideNumber <= 0 ? selectedIndex + 1 : slideNumber,
        shape,
      });
      const previous = current[key] ?? fallback;
      return {
        ...current,
        [key]: {
          ...previous,
          slideNumber: slideNumber <= 0 ? previous.slideNumber : slideNumber,
          title: fallback.title,
          mediaType: fallback.mediaType,
          plays: previous.plays + (event === "play" ? 1 : 0),
          pauses: previous.pauses + (event === "pause" ? 1 : 0),
          completions: previous.completions + (event === "ended" ? 1 : 0),
          seeks: previous.seeks + (event === "seeked" ? 1 : 0),
          errors: previous.errors + (event === "error" ? 1 : 0),
        },
      };
    });
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
        event.preventDefault();
        advancePresentation();
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        rewindPresentation();
      }
    }

    globalThis.document.addEventListener("keydown", handleKeyDown);
    return () => globalThis.document.removeEventListener("keydown", handleKeyDown);
  }, [advancePresentation, onClose, rewindPresentation]);

  useEffect(() => {
    recordingUrlRef.current = recordingUrl;
  }, [recordingUrl]);

  useEffect(() => {
    recordingPackageUrlRef.current = recordingPackageUrl;
  }, [recordingPackageUrl]);

  useEffect(() => {
    let cancelled = false;
    if (recordingBlob === null || captionTranscriptLines.length === 0) {
      if (recordingPackageUrlRef.current !== null) {
        URL.revokeObjectURL(recordingPackageUrlRef.current);
        recordingPackageUrlRef.current = null;
      }
      setRecordingPackageUrl(null);
      setRecordingPackageBlob(null);
      return () => {
        cancelled = true;
      };
    }
    void presentationRecordingPackageBlob(
      deckTitle,
      recordingBlob,
      captionTranscriptLines,
      captionCues,
    ).then((packageBlob) => {
      if (cancelled) {
        return;
      }
      if (recordingPackageUrlRef.current !== null) {
        URL.revokeObjectURL(recordingPackageUrlRef.current);
      }
      const packageUrl = URL.createObjectURL(packageBlob);
      recordingPackageUrlRef.current = packageUrl;
      setRecordingPackageUrl(packageUrl);
      setRecordingPackageBlob(packageBlob);
    });
    return () => {
      cancelled = true;
    };
  }, [captionCues, captionTranscriptLines, deckTitle, recordingBlob]);

  useEffect(() => {
    return () => {
      stopLiveCaptions(recognitionRef);
      cleanupPresentationRecording({
        recorderRef,
        recordingStreamRef,
        recordingUrl: recordingUrlRef.current,
        recordingPackageUrl: recordingPackageUrlRef.current,
      });
    };
  }, []);

  function toggleLiveCaptions() {
    if (captionStatus === "listening") {
      stopLiveCaptions(recognitionRef);
      setCaptionStatus("off");
      return;
    }

    const SpeechRecognition =
      window.SpeechRecognition ?? window.webkitSpeechRecognition ?? undefined;
    if (SpeechRecognition === undefined) {
      setCaptionStatus("unsupported");
      setCaptionText("Live captions are unavailable in this browser.");
      return;
    }

    stopLiveCaptions(recognitionRef);
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onstart = () => {
      setCaptionStatus("listening");
      setCaptionText("");
    };
    recognition.onerror = () => {
      setCaptionStatus("error");
      setCaptionText("Live captions paused. Check microphone access.");
    };
    recognition.onend = () => {
      recognitionRef.current = null;
    };
    recognition.onresult = (event) => {
      const transcript = transcriptFromRecognitionEvent(event);
      if (transcript.displayText.length > 0) {
        setCaptionText(transcript.displayText);
      }
      if (transcript.finalText.length > 0) {
        const speaker = normalizeCaptionSpeaker(captionSpeakerRef.current);
        const line = captionTranscriptLine(selectedIndex, transcript.finalText, speaker);
        setCaptionTranscriptLines((current) =>
          current[current.length - 1] === line ? current : [...current, line],
        );
        const cue = captionCue(
          selectedIndex,
          transcript.finalText,
          recordingStartedAtRef.current,
          speaker,
        );
        setCaptionCues((current) =>
          current.some(
            (existing) =>
              existing.slideIndex === cue.slideIndex &&
              existing.speaker === cue.speaker &&
              existing.text === cue.text &&
              existing.offsetMs === cue.offsetMs,
          )
            ? current
            : [...current, cue],
        );
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setCaptionStatus("error");
      setCaptionText("Live captions could not be started.");
    }
  }

  async function startPresentationRecording() {
    if (recordingStatus === "recording" || recordingStatus === "requesting") {
      return;
    }

    const getDisplayMedia = navigator.mediaDevices?.getDisplayMedia.bind(navigator.mediaDevices);
    if (typeof MediaRecorder === "undefined" || getDisplayMedia === undefined) {
      setRecordingStatus("unsupported");
      setRecordingMessage("Recording is unavailable in this browser.");
      return;
    }

    if (recordingUrl !== null) {
      URL.revokeObjectURL(recordingUrl);
      setRecordingUrl(null);
    }
    if (recordingPackageUrl !== null) {
      URL.revokeObjectURL(recordingPackageUrl);
      recordingPackageUrlRef.current = null;
      setRecordingPackageUrl(null);
    }
    setRecordingBlob(null);
    setRecordingPackageBlob(null);
    recordingDriveMutation.reset();

    setRecordingStatus("requesting");
    setRecordingMessage("Choose a screen or window to record.");
    try {
      const stream = await getDisplayMedia.call(navigator.mediaDevices, {
        video: true,
        audio: true,
      });
      const recorder = new MediaRecorder(stream, mediaRecorderOptions());
      recordingChunksRef.current = [];
      recordingStreamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordingChunksRef.current = [...recordingChunksRef.current, event.data];
        }
      };
      recorder.onerror = () => {
        stopMediaStream(stream);
        recordingStartedAtRef.current = null;
        setRecordingStatus("error");
        setRecordingMessage("Recording failed.");
      };
      recorder.onstop = () => {
        stopMediaStream(stream);
        recordingStreamRef.current = null;
        recorderRef.current = null;
        recordingStartedAtRef.current = null;
        const chunks = recordingChunksRef.current;
        recordingChunksRef.current = [];
        if (chunks.length === 0) {
          setRecordingStatus("error");
          setRecordingMessage("Recording ended without captured media.");
          return;
        }
        const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
        const url = URL.createObjectURL(blob);
        setRecordingBlob(blob);
        setRecordingUrl(url);
        setRecordingStatus("ready");
        setRecordingMessage("Recording ready.");
      };
      for (const track of stream.getVideoTracks()) {
        track.addEventListener("ended", () => {
          if (recorder.state === "recording") {
            setRecordingStatus("finalizing");
            setRecordingMessage("Finalizing recording...");
            recorder.stop();
          }
        });
      }
      recorder.start();
      recordingStartedAtRef.current = performance.now();
      setRecordingStatus("recording");
      setRecordingMessage("Recording presentation.");
    } catch {
      recordingStreamRef.current = null;
      recorderRef.current = null;
      recordingChunksRef.current = [];
      setRecordingStatus("error");
      setRecordingMessage("Recording could not be started.");
    }
  }

  function stopPresentationRecording() {
    const recorder = recorderRef.current;
    if (recorder === null) {
      return;
    }
    if (recorder.state === "recording") {
      setRecordingStatus("finalizing");
      setRecordingMessage("Finalizing recording...");
      recorder.stop();
    }
  }

  function handleStageClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (isPresentationInteractiveTarget(event.target)) {
      return;
    }
    advancePresentation();
  }

  if (slide === null) {
    return null;
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Presentation mode" style={PRESENTER_STYLE}>
      <div style={PRESENTER_TOPBAR_STYLE}>
        <div style={{ minWidth: 0 }}>
          <div className="truncate" style={PRESENTER_TITLE_STYLE}>
            {deckTitle}
          </div>
          <div style={PRESENTER_META_STYLE}>
            Slide {selectedIndex + 1} of {slides.length}
          </div>
        </div>
        <button type="button" className="btn sm" onClick={onClose}>
          Exit
        </button>
      </div>
      <div style={PRESENTER_STAGE_STYLE} aria-label="Presentation stage" onClick={handleStageClick}>
        <SlidePreview
          key={`present-${slide.id}`}
          slide={slide}
          theme={theme}
          style={PRESENTER_SLIDE_STYLE}
          mediaControls
          animateTransition
          animateShapes
          visibleBuildStep={buildStep}
          onMediaPlaybackEvent={recordMediaPlaybackEvent}
        />
        {captionStatus === "off" ? null : (
          <div aria-label="Live captions" style={captionOverlayStyle}>
            <div style={PRESENTER_CAPTION_META_STYLE}>
              {captionStatus === "listening"
                ? `Live captions${captionSpeakerLabel(captionSpeaker)}`
                : "Captions"}
            </div>
            <div aria-label="Live caption text" style={captionTextStyle}>
              {captionText.length > 0 ? captionText : "Listening..."}
            </div>
          </div>
        )}
      </div>
      <div style={PRESENTER_CONTROLS_STYLE}>
        <button
          type="button"
          className="btn sm"
          disabled={selectedIndex === 0 && buildStep === 0}
          onClick={rewindPresentation}
        >
          Previous
        </button>
        {animatedShapeCount > 0 ? (
          <div style={PRESENTER_BUILD_STYLE} aria-label="Slide builds">
            Build {Math.min(buildStep, animatedShapeCount)} of {animatedShapeCount}
          </div>
        ) : null}
        <button type="button" className="btn sm" onClick={toggleLiveCaptions}>
          {captionStatus === "listening" ? <Icons.MicOff /> : <Icons.Mic />}
          {captionStatus === "listening" ? "Stop captions" : "Start captions"}
        </button>
        {captionStatus === "off" ? null : (
          <>
            <label style={PRESENTER_CAPTION_SELECT_STYLE}>
              <span style={PRESENTER_NOTES_LABEL_STYLE}>Caption position</span>
              <select
                aria-label="Caption position"
                value={captionPosition}
                onChange={(event) =>
                  setCaptionPosition(event.currentTarget.value as PresentationCaptionPosition)
                }
                onKeyDown={(event) => event.stopPropagation()}
                style={PRESENTER_SELECT_STYLE}
              >
                <option value="bottom">Bottom</option>
                <option value="top">Top</option>
              </select>
            </label>
            <label style={PRESENTER_CAPTION_SELECT_STYLE}>
              <span style={PRESENTER_NOTES_LABEL_STYLE}>Caption size</span>
              <select
                aria-label="Caption size"
                value={captionSize}
                onChange={(event) =>
                  setCaptionSize(event.currentTarget.value as PresentationCaptionSize)
                }
                onKeyDown={(event) => event.stopPropagation()}
                style={PRESENTER_SELECT_STYLE}
              >
                <option value="standard">Standard</option>
                <option value="large">Large</option>
              </select>
            </label>
            <label style={PRESENTER_CAPTION_SPEAKER_STYLE}>
              <span style={PRESENTER_NOTES_LABEL_STYLE}>Caption speaker</span>
              <input
                aria-label="Caption speaker"
                value={captionSpeaker}
                maxLength={80}
                onChange={(event) => setCaptionSpeaker(event.currentTarget.value)}
                onKeyDown={(event) => event.stopPropagation()}
                style={PRESENTER_INPUT_STYLE}
              />
            </label>
          </>
        )}
        {captionTranscriptLines.length > 0 ? (
          <>
            <a
              className="btn sm"
              aria-label="Download caption transcript"
              href={captionTranscriptHref}
              download={`${downloadSlug(deckTitle)}-captions.txt`}
            >
              <Icons.Download /> Download transcript
            </a>
            <button
              className="btn sm"
              type="button"
              disabled={captionTranscriptDriveMutation.isPending}
              onClick={() => {
                captionTranscriptDriveMutation.mutate(
                  captionTranscriptDriveFile(deckTitle, captionTranscriptLines),
                );
              }}
            >
              <Icons.Upload />
              {captionTranscriptDriveMutation.isPending
                ? "Saving transcript..."
                : "Save transcript to Drive"}
            </button>
            {captionTranscriptDriveMutation.isSuccess ? (
              <span style={PRESENTER_NOTES_LABEL_STYLE}>Transcript saved.</span>
            ) : null}
            {captionTranscriptDriveMutation.isError ? (
              <span style={PRESENTER_NOTES_LABEL_STYLE}>Transcript save failed.</span>
            ) : null}
            <button className="btn sm" type="button" onClick={saveCaptionTranscriptToLibrary}>
              <Icons.History /> Save transcript to library
            </button>
            {captionLibraryStatus.length > 0 ? (
              <span style={PRESENTER_NOTES_LABEL_STYLE}>{captionLibraryStatus}</span>
            ) : null}
          </>
        ) : null}
        {captionTranscriptLibrary.length === 0 ? null : (
          <div aria-label="Caption transcript library" style={PRESENTER_TRANSCRIPT_LIBRARY_STYLE}>
            <span style={PRESENTER_NOTES_LABEL_STYLE}>Transcript library</span>
            {captionTranscriptLibrary.map((entry) => (
              <a
                key={entry.id}
                className="btn sm"
                aria-label={`Download saved caption transcript ${entry.filename}`}
                href={captionTranscriptLibraryEntryHref(entry)}
                download={entry.filename}
              >
                <Icons.Download /> {entry.filename}
              </a>
            ))}
          </div>
        )}
        <button
          type="button"
          className="btn sm"
          disabled={recordingStatus === "requesting" || recordingStatus === "finalizing"}
          onClick={() => {
            if (recordingStatus === "recording") {
              stopPresentationRecording();
              return;
            }
            void startPresentationRecording();
          }}
        >
          <Icons.Circle />
          {recordingStatus === "recording" ? "Stop recording" : "Start recording"}
        </button>
        <div style={PRESENTER_NOTES_STYLE}>
          <span style={PRESENTER_NOTES_LABEL_STYLE}>Notes</span>
          <span>
            {slide.speakerNotes.trim().length > 0 ? slide.speakerNotes : "No speaker notes"}
          </span>
        </div>
        <div style={PRESENTER_NEXT_STYLE} aria-label="Next slide preview">
          <span style={PRESENTER_NOTES_LABEL_STYLE}>Next</span>
          <span>{nextSlide === null ? "End of deck" : slideTitle(nextSlide.content)}</span>
        </div>
        {mediaPlaybackRows.length === 0 ? null : (
          <ol aria-label="Playback analytics" style={PRESENTER_MEDIA_ANALYTICS_STYLE}>
            {mediaPlaybackRows.map((row) => (
              <li key={row.key} style={PRESENTER_MEDIA_ANALYTICS_ROW_STYLE}>
                <span>
                  Slide {row.slideNumber} · {row.title}
                </span>
                <span>
                  {row.mediaType === "audio" ? "Audio" : "Video"} · Plays {row.plays} · Pauses{" "}
                  {row.pauses} · Completed {row.completions} · Seeks {row.seeks} · Errors{" "}
                  {row.errors}
                </span>
              </li>
            ))}
          </ol>
        )}
        <button
          type="button"
          className="btn sm primary"
          disabled={selectedIndex === slides.length - 1 && buildStep >= animatedShapeCount}
          onClick={advancePresentation}
        >
          Next
        </button>
      </div>
      {recordingStatus === "off" ? null : (
        <div aria-label="Presentation recording" style={PRESENTER_RECORDING_STYLE}>
          <div style={PRESENTER_RECORDING_ACTIONS_STYLE}>
            <span>{recordingMessage}</span>
            {recordingUrl === null ? null : (
              <a
                className="btn sm"
                href={recordingUrl}
                download={`${downloadSlug(deckTitle)}-presentation.webm`}
              >
                <Icons.Download /> Download recording
              </a>
            )}
            {recordingPackageUrl === null ? null : (
              <a
                className="btn sm"
                aria-label="Download recording package"
                href={recordingPackageUrl}
                download={`${downloadSlug(deckTitle)}-recording-package.zip`}
              >
                <Icons.Download /> Download package
              </a>
            )}
            {recordingBlob === null ? null : (
              <button
                className="btn sm"
                type="button"
                disabled={recordingDriveMutation.isPending}
                onClick={() => {
                  const file = recordingDriveFile({
                    deckTitle,
                    recordingBlob,
                    recordingPackageBlob,
                  });
                  recordingDriveMutation.mutate(file);
                }}
              >
                <Icons.Upload />
                {recordingDriveMutation.isPending ? "Saving..." : "Save to Drive"}
              </button>
            )}
            {recordingDriveMutation.isSuccess ? <span>Saved to Drive.</span> : null}
            {recordingDriveMutation.isError ? <span>Drive save failed.</span> : null}
          </div>
          {recordingUrl === null ? null : (
            <div aria-label="Recording review" style={PRESENTER_RECORDING_REVIEW_STYLE}>
              <video
                aria-label="Recording review playback"
                controls
                src={recordingUrl}
                style={PRESENTER_RECORDING_VIDEO_STYLE}
              />
              {captionCues.length === 0 ? null : (
                <ol aria-label="Recording caption review" style={PRESENTER_RECORDING_CUES_STYLE}>
                  {captionCues.map((cue, index) => (
                    <li
                      key={`${cue.slideNumber}-${cue.offsetMs ?? "live"}-${cue.text}-${index}`}
                      style={PRESENTER_RECORDING_CUE_STYLE}
                    >
                      {recordingCaptionCueLabel(cue)}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function presentationMediaPlaybackRows(
  slides: readonly SlidesApiSlide[],
  stats: Readonly<Record<string, PresentationMediaPlaybackStats>>,
): readonly PresentationMediaPlaybackStats[] {
  return slides.flatMap((slide, slideIndex) =>
    slideShapes(slide.content)
      .filter((shape) => shape.kind === "media")
      .map((shape) => {
        const row = presentationMediaPlaybackRow({
          slideId: slide.id,
          slideNumber: slideIndex + 1,
          shape,
        });
        return stats[row.key] ?? row;
      }),
  );
}

function presentationMediaPlaybackRow({
  slideId,
  slideNumber,
  shape,
}: {
  readonly slideId: string;
  readonly slideNumber: number;
  readonly shape: SlideShape;
}): PresentationMediaPlaybackStats {
  const mediaType = shape.mediaType ?? "video";
  return {
    key: `${slideId}:${shape.id}`,
    slideNumber,
    title:
      shape.mediaTitle?.trim() || shape.text?.trim() || (mediaType === "audio" ? "Audio" : "Video"),
    mediaType,
    plays: 0,
    pauses: 0,
    completions: 0,
    seeks: 0,
    errors: 0,
  };
}

function mediaRecorderOptions(): MediaRecorderOptions | undefined {
  const mimeType = "video/webm;codecs=vp9,opus";
  if (
    typeof MediaRecorder.isTypeSupported === "function" &&
    MediaRecorder.isTypeSupported(mimeType)
  ) {
    return { mimeType };
  }
  return undefined;
}

function isPresentationInteractiveTarget(target: EventTarget): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return target.closest(PRESENTATION_INTERACTIVE_SELECTOR) !== null;
}

function cleanupPresentationRecording({
  recorderRef,
  recordingStreamRef,
  recordingUrl,
  recordingPackageUrl,
}: {
  readonly recorderRef: { current: MediaRecorder | null };
  readonly recordingStreamRef: { current: MediaStream | null };
  readonly recordingUrl: string | null;
  readonly recordingPackageUrl: string | null;
}) {
  const recorder = recorderRef.current;
  if (recorder !== null) {
    recorder.ondataavailable = null;
    recorder.onerror = null;
    recorder.onstop = null;
    if (recorder.state === "recording") {
      recorder.stop();
    }
    recorderRef.current = null;
  }
  stopMediaStream(recordingStreamRef.current);
  recordingStreamRef.current = null;
  if (recordingUrl !== null) {
    URL.revokeObjectURL(recordingUrl);
  }
  if (recordingPackageUrl !== null) {
    URL.revokeObjectURL(recordingPackageUrl);
  }
}

function stopMediaStream(stream: MediaStream | null) {
  if (stream === null) {
    return;
  }
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function stopLiveCaptions(ref: { current: BrowserSpeechRecognition | null }) {
  const recognition = ref.current;
  if (recognition === null) {
    return;
  }
  recognition.onstart = null;
  recognition.onend = null;
  recognition.onerror = null;
  recognition.onresult = null;
  recognition.stop();
  ref.current = null;
}

function transcriptFromRecognitionEvent(event: BrowserSpeechRecognitionEvent): {
  readonly displayText: string;
  readonly finalText: string;
} {
  const parts: string[] = [];
  const finalParts: string[] = [];
  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const result = event.results[index];
    const transcript = result?.[0]?.transcript.trim();
    if (transcript !== undefined && transcript.length > 0) {
      parts.push(transcript);
      if (result?.isFinal === true) {
        finalParts.push(transcript);
      }
    }
  }
  return {
    displayText: parts.join(" ").trim(),
    finalText: finalParts.join(" ").trim(),
  };
}

function normalizeCaptionSpeaker(speaker: string): string | null {
  const normalized = speaker.trim().replace(/\s+/gu, " ");
  return normalized.length > 0 ? normalized : null;
}

function captionSpeakerLabel(speaker: string): string {
  const normalized = normalizeCaptionSpeaker(speaker);
  return normalized === null ? "" : ` - ${normalized}`;
}

function captionTranscriptLine(
  slideIndex: number,
  transcript: string,
  speaker: string | null,
): string {
  const speakerPrefix = speaker === null ? "" : ` (${speaker})`;
  return `Slide ${String(slideIndex + 1)}${speakerPrefix}: ${transcript}`;
}

function captionCue(
  slideIndex: number,
  transcript: string,
  recordingStartedAt: number | null,
  speaker: string | null,
): PresentationCaptionCue {
  return {
    slideIndex,
    slideNumber: slideIndex + 1,
    text: transcript,
    speaker,
    offsetMs:
      recordingStartedAt === null
        ? null
        : Math.max(0, Math.round(performance.now() - recordingStartedAt)),
  };
}

function captionTranscriptDataUrl(deckTitle: string, lines: readonly string[]): string {
  return `data:text/plain;charset=utf-8,${encodeURIComponent(captionTranscriptText(deckTitle, lines))}`;
}

function captionTranscriptText(deckTitle: string, lines: readonly string[]): string {
  return [`${deckTitle} live captions`, "", ...lines].join("\n");
}

function captionTranscriptDriveFile(deckTitle: string, lines: readonly string[]): File {
  return new File(
    [captionTranscriptText(deckTitle, lines)],
    `${downloadSlug(deckTitle)}-captions.txt`,
    { type: "text/plain;charset=utf-8" },
  );
}

const CAPTION_TRANSCRIPT_LIBRARY_KEY = "helix.slides.captionTranscripts.v1";
const CAPTION_TRANSCRIPT_LIBRARY_LIMIT = 6;

function captionTranscriptLibraryEntry(
  deckTitle: string,
  lines: readonly string[],
): CaptionTranscriptLibraryEntry {
  const savedAt = new Date().toISOString();
  const slug = downloadSlug(deckTitle);
  return {
    id: `${slug}-${savedAt}`,
    deckTitle,
    filename: `${slug}-captions-${savedAt.slice(0, 10)}.txt`,
    savedAt,
    lines: [...lines],
  };
}

function captionTranscriptLibraryEntryHref(entry: CaptionTranscriptLibraryEntry): string {
  return captionTranscriptDataUrl(entry.deckTitle, entry.lines);
}

function readCaptionTranscriptLibrary(): readonly CaptionTranscriptLibraryEntry[] {
  try {
    const raw = globalThis.localStorage?.getItem(CAPTION_TRANSCRIPT_LIBRARY_KEY);
    if (raw === null || raw === undefined) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(isCaptionTranscriptLibraryEntry).slice(0, CAPTION_TRANSCRIPT_LIBRARY_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function writeCaptionTranscriptLibrary(entries: readonly CaptionTranscriptLibraryEntry[]): void {
  try {
    globalThis.localStorage?.setItem(CAPTION_TRANSCRIPT_LIBRARY_KEY, JSON.stringify(entries));
  } catch {
    // Browser storage can be unavailable in privacy modes; transcript download still works.
  }
}

function isCaptionTranscriptLibraryEntry(value: unknown): value is CaptionTranscriptLibraryEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.deckTitle === "string" &&
    typeof entry.filename === "string" &&
    typeof entry.savedAt === "string" &&
    Array.isArray(entry.lines) &&
    entry.lines.every((line) => typeof line === "string")
  );
}

function recordingCaptionCueLabel(cue: PresentationCaptionCue): string {
  const timestamp = cue.offsetMs === null ? "live" : formatCaptionCueOffset(cue.offsetMs);
  const speaker = cue.speaker === null ? "" : ` - ${cue.speaker}`;
  return `Slide ${String(cue.slideNumber)} - ${timestamp}${speaker} - ${cue.text}`;
}

function recordingDriveFile(input: {
  readonly deckTitle: string;
  readonly recordingBlob: Blob;
  readonly recordingPackageBlob: Blob | null;
}): File {
  const slug = downloadSlug(input.deckTitle);
  if (input.recordingPackageBlob !== null) {
    return new File([input.recordingPackageBlob], `${slug}-recording-package.zip`, {
      type: "application/zip",
    });
  }
  return new File([input.recordingBlob], `${slug}-presentation.webm`, {
    type: input.recordingBlob.type || "video/webm",
  });
}

function formatCaptionCueOffset(offsetMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(offsetMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, "0")}`;
}

async function presentationRecordingPackageBlob(
  deckTitle: string,
  recordingBlob: Blob,
  captionTranscriptLines: readonly string[],
  captionCues: readonly PresentationCaptionCue[],
): Promise<Blob> {
  const slug = downloadSlug(deckTitle);
  const encoder = new TextEncoder();
  const manifest = {
    deckTitle,
    recording: {
      filename: `${slug}-presentation.webm`,
      mimeType: recordingBlob.type || "video/webm",
    },
    captions: {
      filename: `${slug}-captions.txt`,
      cues: captionCues,
    },
  };
  const recordingBytes = new Uint8Array(await recordingBlob.arrayBuffer());
  const zipBytes = zipStorePresentationEntries([
    { name: `${slug}-presentation.webm`, data: recordingBytes },
    {
      name: `${slug}-captions.txt`,
      data: encoder.encode(captionTranscriptText(deckTitle, captionTranscriptLines)),
    },
    {
      name: `${slug}-recording-sync.json`,
      data: encoder.encode(JSON.stringify(manifest, null, 2)),
    },
  ]);
  const zipBuffer = new ArrayBuffer(zipBytes.byteLength);
  new Uint8Array(zipBuffer).set(zipBytes);
  return new Blob([zipBuffer], { type: "application/zip" });
}

interface PresentationZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

function zipStorePresentationEntries(entries: readonly PresentationZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = presentationCrc32(entry.data);
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
  return concatPresentationUint8Arrays([...localParts, ...centralParts, end]);
}

function concatPresentationUint8Arrays(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((size, part) => size + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function presentationCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function SlidePreview({
  slide,
  theme,
  style,
  selectedShapeId = null,
  remoteShapeSelections = [],
  onSelectShape,
  onChangeShape,
  mediaControls = false,
  animateTransition = false,
  animateShapes = false,
  visibleBuildStep,
  onTransitionAnimationEnd,
  onMediaPlaybackEvent,
}: {
  readonly slide: SlidesApiSlide;
  readonly theme: SlideTheme;
  readonly style?: CSSProperties;
  readonly selectedShapeId?: string | null;
  readonly remoteShapeSelections?: readonly PresentationRemoteShapeSelection[];
  readonly onSelectShape?: (shapeId: string) => void;
  readonly onChangeShape?: (shapeId: string, patch: Partial<SlideShape>) => void;
  readonly mediaControls?: boolean;
  readonly animateTransition?: boolean;
  readonly animateShapes?: boolean;
  readonly visibleBuildStep?: number | undefined;
  readonly onTransitionAnimationEnd?: () => void;
  readonly onMediaPlaybackEvent?: (
    slideId: string,
    shape: SlideShape,
    event: PresentationMediaPlaybackEvent,
  ) => void;
}) {
  const content = slide.content;
  const shapes = slideShapes(content);
  const visibleShapes =
    visibleBuildStep === undefined
      ? shapes.map((shape) => ({ shape, exiting: false }))
      : shapesForBuildStep(shapes, visibleBuildStep);
  const isShapeEditable = onSelectShape !== undefined && onChangeShape !== undefined;
  return (
    <section
      style={{
        ...SLIDE_CANVAS_STYLE,
        ...slideBackgroundStyle(content, theme),
        ...slideTransitionStyle(content, animateTransition),
        ...style,
      }}
      aria-label="Slide preview"
      onAnimationEnd={onTransitionAnimationEnd}
    >
      {content.layout === "title" ? (
        <div style={TITLE_LAYOUT_STYLE}>
          {content.eyebrow !== undefined ? (
            <div style={EYEBROW_STYLE}>{content.eyebrow}</div>
          ) : null}
          <h2 style={SLIDE_TITLE_STYLE}>{content.title}</h2>
          {content.subtitle !== undefined ? (
            <p style={SLIDE_SUBTITLE_STYLE}>{content.subtitle}</p>
          ) : null}
        </div>
      ) : content.layout === "agenda" || content.layout === "bullets" ? (
        <div style={CONTENT_LAYOUT_STYLE}>
          <h2 style={SLIDE_TITLE_STYLE}>{content.title}</h2>
          <ul style={BULLET_LIST_STYLE}>
            {content.items.map((item, index) => (
              <li key={`${item}-${String(index)}`}>{item}</li>
            ))}
          </ul>
        </div>
      ) : content.layout === "stats" ? (
        <div style={CONTENT_LAYOUT_STYLE}>
          <h2 style={SLIDE_TITLE_STYLE}>{content.title}</h2>
          <div style={STATS_GRID_STYLE}>
            {content.stats.map((stat, index) => (
              <div key={`${stat.label}-${String(index)}`} style={STAT_STYLE}>
                <strong>{stat.value}</strong>
                <span>{stat.label}</span>
              </div>
            ))}
          </div>
        </div>
      ) : content.layout === "split" ? (
        <div style={SPLIT_LAYOUT_STYLE}>
          <div>
            <h2 style={SLIDE_TITLE_STYLE}>{content.title}</h2>
            <p>{content.left}</p>
          </div>
          <div style={SPLIT_RIGHT_STYLE}>
            {Array.isArray(content.rightContent) ? (
              <ul>
                {content.rightContent.map((item, index) => (
                  <li key={`${item}-${String(index)}`}>{item}</li>
                ))}
              </ul>
            ) : (
              <p>{content.rightContent}</p>
            )}
          </div>
        </div>
      ) : (
        <div style={CONTENT_LAYOUT_STYLE}>
          <h2 style={SLIDE_TITLE_STYLE}>{content.title}</h2>
          <p>{content.note}</p>
        </div>
      )}
      {shapes.length > 0 ? (
        <div
          style={{
            ...SHAPE_LAYER_STYLE,
            pointerEvents: isShapeEditable ? "auto" : "none",
            ...(mediaControls && !isShapeEditable ? { pointerEvents: "auto" } : {}),
          }}
          aria-label="Freeform slide shapes"
        >
          {visibleShapes.map(({ shape, exiting }, index) => (
            <SlideShapePreview
              key={shape.id}
              shape={shape}
              stackIndex={index}
              selected={shape.id === selectedShapeId}
              onSelect={onSelectShape}
              onChangeShape={onChangeShape}
              mediaControls={mediaControls}
              onMediaPlaybackEvent={onMediaPlaybackEvent}
              slideId={slide.id}
              animate={animateShapes}
              exiting={exiting}
            />
          ))}
          {remoteShapeSelections.map((selection) => {
            const shape = shapes.find((candidate) => candidate.id === selection.shapeId);
            if (shape === undefined) {
              return null;
            }
            return (
              <RemoteShapeSelectionIndicator
                key={`${selection.actorId}:${selection.shapeId}`}
                selection={selection}
                shape={shape}
              />
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function RemoteShapeSelectionIndicator({
  selection,
  shape,
}: {
  readonly selection: PresentationRemoteShapeSelection;
  readonly shape: SlideShape;
}) {
  return (
    <div
      aria-label={`${selection.displayName} selected ${shapeLabelText(shape) || shape.id}`}
      style={{
        ...REMOTE_SHAPE_SELECTION_STYLE,
        ...shapeBoundsStyle(shape),
      }}
    >
      <span style={REMOTE_SHAPE_SELECTION_BADGE_STYLE}>{initials(selection.displayName)}</span>
    </div>
  );
}

function SlideShapePreview({
  shape,
  stackIndex,
  selected,
  onSelect,
  onChangeShape,
  mediaControls,
  onMediaPlaybackEvent,
  slideId,
  animate,
  exiting,
}: {
  readonly shape: SlideShape;
  readonly stackIndex: number;
  readonly selected: boolean;
  readonly onSelect?: (shapeId: string) => void;
  readonly onChangeShape?: (shapeId: string, patch: Partial<SlideShape>) => void;
  readonly mediaControls: boolean;
  readonly onMediaPlaybackEvent?: (
    slideId: string,
    shape: SlideShape,
    event: PresentationMediaPlaybackEvent,
  ) => void;
  readonly slideId: string;
  readonly animate: boolean;
  readonly exiting: boolean;
}) {
  const label = shapeLabelText(shape);
  const markerNamespace = useId().replace(/:/gu, "");
  const connectorId = `connector-arrow-${markerNamespace}-${stackIndex}-${shape.id.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
  const connector = connectorLineProps(shape);
  const dragRef = useRef<ShapeDragState | null>(null);
  const editable = onSelect !== undefined && onChangeShape !== undefined;

  function beginShapeDrag(event: ReactMouseEvent<HTMLElement>, mode: ShapeDragMode) {
    const selectShape = onSelect;
    const changeShape = onChangeShape;
    if (selectShape === undefined || changeShape === undefined) {
      return;
    }
    const applyShapeChange: (shapeId: string, patch: Partial<SlideShape>) => void = changeShape;
    const layer = event.currentTarget.closest('[aria-label="Freeform slide shapes"]');
    const rect = layer?.getBoundingClientRect();
    if (rect === undefined || rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const layerRect = rect;
    event.preventDefault();
    event.stopPropagation();
    selectShape(shape.id);
    dragRef.current = {
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startShape: shape,
      layerWidth: rect.width,
      layerHeight: rect.height,
    };

    function handleMouseMove(moveEvent: MouseEvent) {
      const drag = dragRef.current;
      if (drag === null) {
        return;
      }
      const deltaX = ((moveEvent.clientX - drag.startClientX) / drag.layerWidth) * 100;
      const deltaY = ((moveEvent.clientY - drag.startClientY) / drag.layerHeight) * 100;
      const nextShape = nextShapeFromDrag(drag, {
        x: clampShapeNumber(((moveEvent.clientX - layerRect.left) / drag.layerWidth) * 100, 0, 100),
        y: clampShapeNumber(((moveEvent.clientY - layerRect.top) / drag.layerHeight) * 100, 0, 100),
        deltaX,
        deltaY,
      });
      applyShapeChange(shape.id, {
        x: nextShape.x,
        y: nextShape.y,
        width: nextShape.width,
        height: nextShape.height,
        connectorDirection: nextShape.connectorDirection,
        connectorArrow: nextShape.connectorArrow,
      });
    }

    function handleMouseUp() {
      dragRef.current = null;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    }

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }

  return (
    <div
      style={{
        ...SHAPE_STYLE,
        zIndex: stackIndex + 1,
        ...(editable ? SHAPE_EDITABLE_STYLE : {}),
        ...(selected ? SHAPE_SELECTED_STYLE : {}),
        ...shapeBoundsStyle(shape),
        ...shapeToneStyle(shape),
        ...shapeAnimationStyle(shape, animate, exiting),
        ...(!editable && shape.kind !== "media" ? { pointerEvents: "none" as const } : {}),
      }}
      aria-label={`${shapeKindLabel(shape.kind, true)} ${label}`.trim()}
      aria-pressed={editable ? selected : undefined}
      data-presentation-interactive={
        !editable && mediaControls && shape.kind === "media" ? "true" : undefined
      }
      role={editable ? "button" : undefined}
      tabIndex={editable ? 0 : undefined}
      onMouseDown={(event) => beginShapeDrag(event, "move")}
      onClick={(event) => {
        if (!editable) {
          return;
        }
        event.stopPropagation();
        onSelect?.(shape.id);
      }}
    >
      {shape.kind === "connector" ? (
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={CONNECTOR_SVG_STYLE}>
          {connector.arrow !== "none" ? (
            <defs>
              <marker
                id={connectorId}
                markerWidth="10"
                markerHeight="10"
                refX="8"
                refY="5"
                orient="auto-start-reverse"
                markerUnits="strokeWidth"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
          ) : null}
          <line
            x1={connector.x1}
            y1={connector.y1}
            x2={connector.x2}
            y2={connector.y2}
            markerStart={
              connector.arrow === "start" || connector.arrow === "both"
                ? `url(#${connectorId})`
                : undefined
            }
            markerEnd={
              connector.arrow === "end" || connector.arrow === "both"
                ? `url(#${connectorId})`
                : undefined
            }
            style={CONNECTOR_LINE_STYLE}
          />
        </svg>
      ) : null}
      {shape.kind === "image" ? (
        shape.imageUrl?.trim() ? (
          <img
            src={shape.imageUrl}
            alt={shape.imageAlt ?? label}
            style={imageShapeStyle(shape)}
            draggable={false}
          />
        ) : (
          <span style={IMAGE_PLACEHOLDER_STYLE}>Image</span>
        )
      ) : null}
      {shape.kind === "media" ? (
        <SlideMediaShape
          shape={shape}
          label={label}
          controls={mediaControls}
          onPlaybackEvent={
            onMediaPlaybackEvent === undefined
              ? undefined
              : (event) => onMediaPlaybackEvent(slideId, shape, event)
          }
        />
      ) : null}
      {shape.kind === "text" || (shape.kind === "rectangle" && label.length > 0) ? (
        <span style={SHAPE_TEXT_STYLE}>{label.length > 0 ? label : "Text"}</span>
      ) : null}
      {editable ? (
        <>
          {shape.kind === "connector" ? (
            <>
              <span
                aria-label={`Move ${shapeLabel(shape, stackIndex)} left endpoint`}
                style={{
                  ...CONNECTOR_ENDPOINT_HANDLE_STYLE,
                  left: 4,
                  top: connector.y1 === "8" ? 8 : "calc(100% - 8px)",
                }}
                onMouseDown={(event) => beginShapeDrag(event, "connector-left")}
              />
              <span
                aria-label={`Move ${shapeLabel(shape, stackIndex)} right endpoint`}
                style={{
                  ...CONNECTOR_ENDPOINT_HANDLE_STYLE,
                  right: 4,
                  top: connector.y2 === "8" ? 8 : "calc(100% - 8px)",
                }}
                onMouseDown={(event) => beginShapeDrag(event, "connector-right")}
              />
            </>
          ) : null}
          <span
            aria-label={`Resize ${shapeLabel(shape, stackIndex)}`}
            style={SHAPE_RESIZE_HANDLE_STYLE}
            onMouseDown={(event) => beginShapeDrag(event, "resize")}
          />
        </>
      ) : null}
    </div>
  );
}

function SlideMediaShape({
  shape,
  label,
  controls,
  onPlaybackEvent,
}: {
  readonly shape: SlideShape;
  readonly label: string;
  readonly controls: boolean;
  readonly onPlaybackEvent?: (event: PresentationMediaPlaybackEvent) => void;
}) {
  const mediaUrl = shape.mediaUrl?.trim() ?? "";
  const mediaType = shape.mediaType ?? "video";
  const title = shape.mediaTitle?.trim() || label || (mediaType === "audio" ? "Audio" : "Video");
  const posterUrl = shape.mediaPosterUrl?.trim() ?? "";
  const captionUrl = shape.mediaCaptionUrl?.trim() ?? "";
  const captionLabel = shape.mediaCaptionLabel?.trim() || "Captions";
  const videoSrc = mediaType === "video" ? mediaUrlWithVideoTrim(mediaUrl, shape) : mediaUrl;
  const autoplay = controls && shape.mediaAutoplay === true;
  const muted = !controls || shape.mediaMuted === true || autoplay;

  if (mediaUrl.length === 0) {
    return <span style={MEDIA_PLACEHOLDER_STYLE}>{mediaType === "audio" ? "Audio" : "Video"}</span>;
  }

  if (mediaType === "audio") {
    return (
      <div style={AUDIO_SHAPE_WRAPPER_STYLE}>
        <span style={MEDIA_TITLE_STYLE}>{title}</span>
        <audio
          aria-label={`Audio ${title}`}
          data-shape-id={shape.id}
          src={mediaUrl}
          controls={controls}
          preload="metadata"
          style={AUDIO_SHAPE_STYLE}
          onPlay={() => onPlaybackEvent?.("play")}
          onPause={() => onPlaybackEvent?.("pause")}
          onEnded={() => onPlaybackEvent?.("ended")}
          onSeeked={() => onPlaybackEvent?.("seeked")}
          onError={() => onPlaybackEvent?.("error")}
        >
          {captionUrl.length === 0 ? null : (
            <track kind="captions" src={captionUrl} srcLang="en" label={captionLabel} />
          )}
        </audio>
      </div>
    );
  }

  return (
    <video
      aria-label={`Video ${title}`}
      data-shape-id={shape.id}
      src={videoSrc}
      poster={posterUrl.length === 0 ? undefined : posterUrl}
      controls={controls}
      autoPlay={autoplay}
      loop={shape.mediaLoop === true}
      preload="metadata"
      playsInline
      muted={muted}
      style={VIDEO_SHAPE_STYLE}
      onPlay={() => onPlaybackEvent?.("play")}
      onPause={() => onPlaybackEvent?.("pause")}
      onEnded={() => onPlaybackEvent?.("ended")}
      onSeeked={() => onPlaybackEvent?.("seeked")}
      onError={() => onPlaybackEvent?.("error")}
    >
      {captionUrl.length === 0 ? null : (
        <track kind="captions" src={captionUrl} srcLang="en" label={captionLabel} />
      )}
    </video>
  );
}

function SlideEditor({
  slide,
  theme,
  saving,
  onSave,
  onSelectedShapeChange,
  requestedSelectedShapeId,
  remoteShapeSelections = [],
}: {
  readonly slide: SlidesApiSlide;
  readonly theme: SlideTheme;
  readonly saving: boolean;
  readonly onSave: (content: SlideContent, speakerNotes: string) => void;
  readonly onSelectedShapeChange?: ((shapeId: string | null) => void) | undefined;
  readonly requestedSelectedShapeId?: string | null | undefined;
  readonly remoteShapeSelections?: readonly PresentationRemoteShapeSelection[] | undefined;
}) {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const mediaTrimPreviewCleanupRef = useRef<(() => void) | null>(null);
  const [draft, setDraft] = useState(() => draftFromSlide(slide.content, slide.speakerNotes));
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(
    () => draftFromSlide(slide.content, slide.speakerNotes).shapes[0]?.id ?? null,
  );
  const [layoutSuggestion, setLayoutSuggestion] = useState<SlideLayoutSuggestion | null>(null);
  const [mediaTrimPreviewStatus, setMediaTrimPreviewStatus] = useState("");
  const [transitionPreviewRun, setTransitionPreviewRun] = useState(0);
  const [previewingTransition, setPreviewingTransition] = useState(false);

  useEffect(() => {
    const nextDraft = draftFromSlide(slide.content, slide.speakerNotes);
    setDraft(nextDraft);
    setSelectedShapeId(nextDraft.shapes[0]?.id ?? null);
    setLayoutSuggestion(null);
    setMediaTrimPreviewStatus("");
    setTransitionPreviewRun(0);
    setPreviewingTransition(false);
  }, [slide]);

  useEffect(
    () => () => {
      mediaTrimPreviewCleanupRef.current?.();
    },
    [],
  );

  const canEditItems = draft.layout === "agenda" || draft.layout === "bullets";
  const nextContent = contentWithEditableFields(slide.content, draft);
  const selectedShape =
    draft.shapes.find((shape) => shape.id === selectedShapeId) ?? draft.shapes[0] ?? null;
  const selectedShapeIndex =
    selectedShape === null ? -1 : draft.shapes.findIndex((shape) => shape.id === selectedShape.id);
  const mediaShapes = draft.shapes.filter((shape) => shape.kind === "media");
  const animationTimeline = useMemo(
    () => slideShapeAnimationTimeline(draft.shapes),
    [draft.shapes],
  );
  const driveAssetQuery = useQuery(slidesDriveShapeAssetsQueryOptions());
  const driveImageAssets = useMemo(
    () => (driveAssetQuery.data ?? []).filter(isDriveImageAsset),
    [driveAssetQuery.data],
  );
  const driveMediaAssets = useMemo(
    () => (driveAssetQuery.data ?? []).filter((entry) => driveEntryMediaType(entry) !== null),
    [driveAssetQuery.data],
  );

  useEffect(() => {
    onSelectedShapeChange?.(selectedShape?.id ?? null);
  }, [onSelectedShapeChange, selectedShape?.id]);

  useEffect(() => {
    if (
      requestedSelectedShapeId !== null &&
      requestedSelectedShapeId !== undefined &&
      requestedSelectedShapeId !== selectedShapeId &&
      draft.shapes.some((shape) => shape.id === requestedSelectedShapeId)
    ) {
      setSelectedShapeId(requestedSelectedShapeId);
    }
  }, [draft.shapes, requestedSelectedShapeId, selectedShapeId]);

  const imageUploadMutation = useMutation({
    mutationFn: async (input: {
      readonly file: File;
      readonly shapeId: string;
      readonly imageAlt: string;
    }) => {
      const uploaded = await uploadDriveFile({ file: input.file, folderId: null });
      return { ...input, objectId: uploaded.objectId };
    },
    onMutate: () => undefined,
    onSuccess: (result) => {
      patchShape(result.shapeId, {
        imageUrl: `/api/drive/objects/${encodeURIComponent(result.objectId)}/content`,
        imageAlt: result.imageAlt,
      });
      setSelectedShapeId(result.shapeId);
    },
    onError: () => undefined,
  });
  const mediaUploadMutation = useMutation({
    mutationFn: async (input: {
      readonly file: File;
      readonly shapeId: string;
      readonly mediaTitle: string;
      readonly mediaType: SlideMediaType;
    }) => {
      const uploaded = await uploadDriveFile({ file: input.file, folderId: null });
      return { ...input, objectId: uploaded.objectId };
    },
    onMutate: () => undefined,
    onSuccess: (result) => {
      patchShape(result.shapeId, {
        mediaUrl: `/api/drive/objects/${encodeURIComponent(result.objectId)}/content`,
        mediaType: result.mediaType,
        mediaTitle: result.mediaTitle,
      });
      setSelectedShapeId(result.shapeId);
    },
    onError: () => undefined,
  });

  function patchDraft(patch: Partial<SlideDraft>) {
    setLayoutSuggestion(null);
    setDraft((current) => ({ ...current, ...patch }));
    if (patch.transition !== undefined) {
      setPreviewingTransition(false);
    }
  }

  function previewTransition() {
    if (draft.transition === undefined) {
      return;
    }
    setTransitionPreviewRun((current) => current + 1);
    setPreviewingTransition(true);
  }

  function addShape(kind: SlideShapeKind) {
    const shape = createSlideShape(draft.shapes, kind);
    setLayoutSuggestion(null);
    setSelectedShapeId(shape.id);
    setDraft((current) => ({ ...current, shapes: [...current.shapes, shape] }));
  }

  function patchSelectedShape(patch: Partial<SlideShape>) {
    if (selectedShape === null) {
      return;
    }
    patchShape(selectedShape.id, patch);
  }

  function patchShape(shapeId: string, patch: Partial<SlideShape>) {
    setLayoutSuggestion(null);
    setDraft((current) => ({
      ...current,
      shapes: current.shapes.map((shape) =>
        shape.id === shapeId ? normalizeSlideShape({ ...shape, ...patch }) : shape,
      ),
    }));
  }

  function uploadSelectedShapeImage(file: File | undefined) {
    if (file === undefined || selectedShape === null || selectedShape.kind !== "image") {
      return;
    }
    const currentAlt = selectedShape.imageAlt?.trim() ?? "";
    imageUploadMutation.mutate({
      file,
      shapeId: selectedShape.id,
      imageAlt: currentAlt.length > 0 ? currentAlt : imageAltFromFilename(file.name),
    });
  }

  function uploadSelectedShapeMedia(file: File | undefined) {
    if (file === undefined || selectedShape === null || selectedShape.kind !== "media") {
      return;
    }
    const currentTitle = selectedShape.mediaTitle?.trim() ?? "";
    mediaUploadMutation.mutate({
      file,
      shapeId: selectedShape.id,
      mediaType: mediaTypeFromFile(file, selectedShape.mediaType ?? "video"),
      mediaTitle: currentTitle.length > 0 ? currentTitle : mediaTitleFromFilename(file.name),
    });
  }

  function pickDriveImageAsset(objectId: string) {
    if (objectId.length === 0 || selectedShape === null || selectedShape.kind !== "image") {
      return;
    }
    const asset = driveImageAssets.find((entry) => entry.id === objectId);
    if (asset === undefined) {
      return;
    }
    const currentAlt = selectedShape.imageAlt?.trim() ?? "";
    patchSelectedShape({
      imageUrl: driveObjectContentUrl(asset.id),
      imageAlt: currentAlt.length > 0 ? currentAlt : labelFromFilename(asset.name),
    });
  }

  function pickDriveMediaAsset(objectId: string) {
    if (objectId.length === 0 || selectedShape === null || selectedShape.kind !== "media") {
      return;
    }
    const asset = driveMediaAssets.find((entry) => entry.id === objectId);
    const mediaType = asset === undefined ? null : driveEntryMediaType(asset);
    if (asset === undefined || mediaType === null) {
      return;
    }
    const currentTitle = selectedShape.mediaTitle?.trim() ?? "";
    patchSelectedShape({
      mediaUrl: driveObjectContentUrl(asset.id),
      mediaType,
      mediaTitle: currentTitle.length > 0 ? currentTitle : labelFromFilename(asset.name),
    });
  }

  function pickDriveMediaPosterAsset(objectId: string) {
    if (objectId.length === 0 || selectedShape === null || selectedShape.kind !== "media") {
      return;
    }
    const asset = driveImageAssets.find((entry) => entry.id === objectId);
    if (asset === undefined) {
      return;
    }
    patchSelectedShape({ mediaPosterUrl: driveObjectContentUrl(asset.id) });
  }

  function deleteSelectedShape() {
    if (selectedShape === null) {
      return;
    }
    const shapeId = selectedShape.id;
    const nextSelectedId = draft.shapes.find((shape) => shape.id !== shapeId)?.id ?? null;
    setLayoutSuggestion(null);
    setSelectedShapeId(nextSelectedId);
    setDraft((current) => {
      const nextShapes = current.shapes.filter((shape) => shape.id !== shapeId);
      return { ...current, shapes: nextShapes };
    });
  }

  function moveSelectedShape(direction: -1 | 1) {
    if (selectedShape === null) {
      return;
    }
    const shapeId = selectedShape.id;
    setLayoutSuggestion(null);
    setDraft((current) => {
      const index = current.shapes.findIndex((shape) => shape.id === shapeId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.shapes.length) {
        return current;
      }
      const nextShapes = [...current.shapes];
      const currentShape = nextShapes[index];
      const targetShape = nextShapes[nextIndex];
      if (currentShape === undefined || targetShape === undefined) {
        return current;
      }
      nextShapes[index] = targetShape;
      nextShapes[nextIndex] = currentShape;
      return { ...current, shapes: nextShapes };
    });
  }

  function changeLayout(layout: SlideLayout) {
    setLayoutSuggestion(null);
    setDraft((current) => {
      const next = draftFromSlide(emptySlideContent(layout), current.speakerNotes);
      return {
        ...next,
        title: current.title.trim().length > 0 ? current.title : next.title,
        shapes: current.shapes,
      };
    });
  }

  function suggestLayout() {
    setLayoutSuggestion(suggestSlideLayout(draft));
  }

  function applyLayoutSuggestion() {
    if (layoutSuggestion === null) {
      return;
    }
    setDraft((current) => layoutSuggestedDraft(current, layoutSuggestion.layout));
    setLayoutSuggestion(null);
  }

  function rewriteItems() {
    if (!canEditItems) {
      return;
    }
    setLayoutSuggestion(null);
    setDraft((current) => ({
      ...current,
      items: rewriteSlideItems(current),
    }));
  }

  function draftNotes() {
    setLayoutSuggestion(null);
    setDraft((current) => ({
      ...current,
      speakerNotes: draftSpeakerNotes(current),
    }));
  }

  function previewSelectedMediaTrim() {
    if (selectedShape === null || selectedShape.kind !== "media") {
      return;
    }
    mediaTrimPreviewCleanupRef.current?.();
    mediaTrimPreviewCleanupRef.current = null;
    const mediaElement = Array.from(
      previewRef.current?.querySelectorAll<HTMLMediaElement>("video[data-shape-id]") ?? [],
    ).find((element) => element.dataset.shapeId === selectedShape.id);
    if (mediaElement === undefined) {
      setMediaTrimPreviewStatus("Select a video shape with a media URL to preview.");
      return;
    }
    const trim = normalizedMediaTrim(selectedShape);
    const start = trim.mediaStartSeconds ?? 0;
    mediaElement.currentTime = start;
    setMediaTrimPreviewStatus(
      `Previewing trim ${mediaAssetTrimLabel(selectedShape) || "from start"}.`,
    );
    if (trim.mediaEndSeconds !== undefined) {
      const end = trim.mediaEndSeconds;
      const stopAtTrimEnd = () => {
        if (mediaElement.currentTime < end) {
          return;
        }
        mediaElement.currentTime = end;
        mediaElement.pause();
        setMediaTrimPreviewStatus(`Trim preview ended at ${String(end)}s.`);
        mediaTrimPreviewCleanupRef.current?.();
        mediaTrimPreviewCleanupRef.current = null;
      };
      mediaElement.addEventListener("timeupdate", stopAtTrimEnd);
      mediaElement.addEventListener("ended", stopAtTrimEnd);
      mediaTrimPreviewCleanupRef.current = () => {
        mediaElement.removeEventListener("timeupdate", stopAtTrimEnd);
        mediaElement.removeEventListener("ended", stopAtTrimEnd);
      };
    }
    void mediaElement.play().catch(() => {
      mediaTrimPreviewCleanupRef.current?.();
      mediaTrimPreviewCleanupRef.current = null;
      setMediaTrimPreviewStatus("Trim preview could not start.");
    });
  }

  const previewSlide = {
    ...slide,
    content: nextContent,
    speakerNotes: draft.speakerNotes,
  };

  return (
    <>
      <div ref={previewRef}>
        <SlidePreview
          key={`slide-preview-${slide.id}-${transitionPreviewRun}`}
          slide={previewSlide}
          theme={theme}
          animateTransition={previewingTransition}
          selectedShapeId={selectedShape?.id ?? null}
          remoteShapeSelections={remoteShapeSelections}
          onSelectShape={setSelectedShapeId}
          onChangeShape={patchShape}
          onTransitionAnimationEnd={() => setPreviewingTransition(false)}
        />
      </div>
      <form
        style={INSPECTOR_STYLE}
        onSubmit={(event) => {
          event.preventDefault();
          onSave(nextContent, draft.speakerNotes);
        }}
      >
        <label style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>Layout</span>
          <select
            aria-label="Slide layout"
            value={draft.layout}
            onChange={(event) => changeLayout(event.target.value as SlideLayout)}
            style={INPUT_STYLE}
          >
            {SLIDE_LAYOUT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div style={LAYOUT_SUGGESTION_STYLE} aria-label="Layout suggestion">
          <button className="btn sm" type="button" onClick={suggestLayout}>
            <Icons.Sparkles /> Suggest layout
          </button>
          {canEditItems ? (
            <button className="btn sm" type="button" onClick={rewriteItems}>
              <Icons.Sparkles /> Rewrite bullets
            </button>
          ) : null}
          <button className="btn sm" type="button" onClick={draftNotes}>
            <Icons.Sparkles /> Draft notes
          </button>
          {layoutSuggestion === null ? null : (
            <div style={LAYOUT_SUGGESTION_RESULT_STYLE}>
              <span>
                Suggested: {slideLayoutLabel(layoutSuggestion.layout)}. {layoutSuggestion.reason}
              </span>
              <button
                className="btn primary sm"
                type="button"
                disabled={layoutSuggestion.layout === draft.layout}
                onClick={applyLayoutSuggestion}
              >
                Apply layout
              </button>
            </div>
          )}
        </div>
        <label style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>Title</span>
          <input
            aria-label="Slide title"
            value={draft.title}
            onChange={(event) => patchDraft({ title: event.target.value })}
            style={INPUT_STYLE}
          />
        </label>
        <label style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>Transition</span>
          <select
            aria-label="Slide transition"
            value={draft.transition?.type ?? "none"}
            onChange={(event) =>
              patchDraft({
                transition: transitionFromSelection(event.target.value, draft.transition),
              })
            }
            style={INPUT_STYLE}
          >
            <option value="none">None</option>
            <option value="fade">Fade</option>
            <option value="slide">Slide</option>
            <option value="zoom">Zoom</option>
          </select>
        </label>
        {draft.transition !== undefined ? (
          <div style={SHAPE_GRID_STYLE}>
            <NumberField
              label="Transition duration"
              value={draft.transition.durationMs ?? 420}
              min={120}
              max={3_000}
              onChange={(value) =>
                patchDraft({
                  transition: normalizeSlideTransition({
                    ...draft.transition,
                    durationMs: value,
                  }),
                })
              }
            />
            {draft.transition.type === "slide" ? (
              <label style={FIELD_STYLE}>
                <span style={LABEL_STYLE}>Direction</span>
                <select
                  aria-label="Transition direction"
                  value={draft.transition.direction ?? "right"}
                  onChange={(event) =>
                    patchDraft({
                      transition: normalizeSlideTransition({
                        ...draft.transition,
                        direction: event.target.value as SlideTransitionDirection,
                      }),
                    })
                  }
                  style={INPUT_STYLE}
                >
                  <option value="right">Right</option>
                  <option value="left">Left</option>
                  <option value="up">Up</option>
                  <option value="down">Down</option>
                </select>
              </label>
            ) : null}
            <button
              type="button"
              className="btn sm"
              onClick={previewTransition}
              style={TRANSITION_PREVIEW_BUTTON_STYLE}
            >
              <Icons.Eye /> Preview transition
            </button>
          </div>
        ) : null}
        {draft.layout === "title" ? (
          <>
            <label style={FIELD_STYLE}>
              <span style={LABEL_STYLE}>Eyebrow</span>
              <input
                aria-label="Slide eyebrow"
                value={draft.eyebrow}
                onChange={(event) => patchDraft({ eyebrow: event.target.value })}
                style={INPUT_STYLE}
              />
            </label>
            <label style={FIELD_STYLE}>
              <span style={LABEL_STYLE}>Subtitle</span>
              <textarea
                aria-label="Slide subtitle"
                value={draft.subtitle}
                onChange={(event) => patchDraft({ subtitle: event.target.value })}
                rows={3}
                style={TEXTAREA_STYLE}
              />
            </label>
            <label style={FIELD_STYLE}>
              <span style={LABEL_STYLE}>Background</span>
              <select
                aria-label="Title background"
                value={draft.bg}
                onChange={(event) => patchDraft({ bg: event.target.value as SlideBackground })}
                style={INPUT_STYLE}
              >
                <option value="accent">Accent</option>
                <option value="neutral">Neutral</option>
              </select>
            </label>
          </>
        ) : null}
        {canEditItems ? (
          <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>
              {draft.layout === "agenda" ? "Agenda items" : "Bullets"}
            </span>
            <textarea
              aria-label={draft.layout === "agenda" ? "Agenda items" : "Slide bullets"}
              value={draft.items}
              onChange={(event) => patchDraft({ items: event.target.value })}
              rows={5}
              style={TEXTAREA_STYLE}
            />
          </label>
        ) : null}
        {draft.layout === "stats" ? (
          <>
            <label style={FIELD_STYLE}>
              <span style={LABEL_STYLE}>Subtitle</span>
              <textarea
                aria-label="Slide subtitle"
                value={draft.subtitle}
                onChange={(event) => patchDraft({ subtitle: event.target.value })}
                rows={3}
                style={TEXTAREA_STYLE}
              />
            </label>
            <label style={FIELD_STYLE}>
              <span style={LABEL_STYLE}>Stats</span>
              <textarea
                aria-label="Slide stats"
                value={draft.stats}
                onChange={(event) => patchDraft({ stats: event.target.value })}
                rows={5}
                style={TEXTAREA_STYLE}
              />
            </label>
          </>
        ) : null}
        {draft.layout === "split" ? (
          <>
            <label style={FIELD_STYLE}>
              <span style={LABEL_STYLE}>Left column</span>
              <textarea
                aria-label="Left column"
                value={draft.left}
                onChange={(event) => patchDraft({ left: event.target.value })}
                rows={4}
                style={TEXTAREA_STYLE}
              />
            </label>
            <label style={FIELD_STYLE}>
              <span style={LABEL_STYLE}>Right side</span>
              <select
                aria-label="Right side type"
                value={draft.rightKind}
                onChange={(event) =>
                  patchDraft({ rightKind: event.target.value as "list" | "quote" })
                }
                style={INPUT_STYLE}
              >
                <option value="list">List</option>
                <option value="quote">Quote</option>
              </select>
            </label>
            <label style={FIELD_STYLE}>
              <span style={LABEL_STYLE}>Right content</span>
              <textarea
                aria-label="Right content"
                value={draft.rightContent}
                onChange={(event) => patchDraft({ rightContent: event.target.value })}
                rows={4}
                style={TEXTAREA_STYLE}
              />
            </label>
            {draft.rightKind === "quote" ? (
              <label style={FIELD_STYLE}>
                <span style={LABEL_STYLE}>Quote source</span>
                <input
                  aria-label="Quote source"
                  value={draft.quoteWho}
                  onChange={(event) => patchDraft({ quoteWho: event.target.value })}
                  style={INPUT_STYLE}
                />
              </label>
            ) : null}
          </>
        ) : null}
        {draft.layout === "image" ? (
          <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>Image note</span>
            <textarea
              aria-label="Image note"
              value={draft.note}
              onChange={(event) => patchDraft({ note: event.target.value })}
              rows={5}
              style={TEXTAREA_STYLE}
            />
          </label>
        ) : null}
        <fieldset style={SHAPE_FIELDSET_STYLE}>
          <legend style={SHAPE_LEGEND_STYLE}>Shapes</legend>
          <div style={SHAPE_ACTION_ROW_STYLE}>
            <button className="btn sm" type="button" onClick={() => addShape("text")}>
              <Icons.Plus /> Text
            </button>
            <button className="btn sm" type="button" onClick={() => addShape("rectangle")}>
              <Icons.Plus /> Rectangle
            </button>
            <button className="btn sm" type="button" onClick={() => addShape("connector")}>
              <Icons.Plus /> Connector
            </button>
            <button className="btn sm" type="button" onClick={() => addShape("image")}>
              <Icons.Plus /> Image
            </button>
            <button className="btn sm" type="button" onClick={() => addShape("media")}>
              <Icons.Plus /> Media
            </button>
          </div>
          {draft.shapes.length > 0 ? (
            <>
              <label style={FIELD_STYLE}>
                <span style={LABEL_STYLE}>Selected shape</span>
                <select
                  aria-label="Slide shape"
                  value={selectedShape?.id ?? ""}
                  onChange={(event) => setSelectedShapeId(event.target.value)}
                  style={INPUT_STYLE}
                >
                  {draft.shapes.map((shape, index) => (
                    <option key={shape.id} value={shape.id}>
                      {shapeLabel(shape, index)}
                    </option>
                  ))}
                </select>
              </label>
              {mediaShapes.length > 0 ? (
                <MediaAssetTable
                  shapes={mediaShapes}
                  selectedShapeId={selectedShape?.id ?? null}
                  onSelectShape={setSelectedShapeId}
                />
              ) : null}
              {animationTimeline.length > 0 ? (
                <ShapeAnimationTimeline
                  rows={animationTimeline}
                  selectedShapeId={selectedShape?.id ?? null}
                  onSelectShape={setSelectedShapeId}
                />
              ) : null}
              {selectedShape !== null ? (
                <>
                  <label style={FIELD_STYLE}>
                    <span style={LABEL_STYLE}>Kind</span>
                    <select
                      aria-label="Shape kind"
                      value={selectedShape.kind}
                      onChange={(event) =>
                        patchSelectedShape({ kind: event.target.value as SlideShapeKind })
                      }
                      style={INPUT_STYLE}
                    >
                      <option value="text">Text</option>
                      <option value="rectangle">Rectangle</option>
                      <option value="connector">Connector</option>
                      <option value="image">Image</option>
                      <option value="media">Media</option>
                    </select>
                  </label>
                  <label style={FIELD_STYLE}>
                    <span style={LABEL_STYLE}>Text</span>
                    <input
                      aria-label="Shape text"
                      value={selectedShape.text ?? ""}
                      onChange={(event) => patchSelectedShape({ text: event.target.value })}
                      style={INPUT_STYLE}
                    />
                  </label>
                  {selectedShape.kind === "image" ? (
                    <>
                      <label style={FIELD_STYLE}>
                        <span style={LABEL_STYLE}>Image URL</span>
                        <input
                          aria-label="Shape image URL"
                          value={selectedShape.imageUrl ?? ""}
                          onChange={(event) => patchSelectedShape({ imageUrl: event.target.value })}
                          style={INPUT_STYLE}
                        />
                      </label>
                      <label style={FIELD_STYLE}>
                        <span style={LABEL_STYLE}>Alt text</span>
                        <input
                          aria-label="Shape image alt text"
                          value={selectedShape.imageAlt ?? ""}
                          onChange={(event) => patchSelectedShape({ imageAlt: event.target.value })}
                          style={INPUT_STYLE}
                        />
                      </label>
                      <label style={FIELD_STYLE}>
                        <span style={LABEL_STYLE}>Image fit</span>
                        <select
                          aria-label="Shape image fit"
                          value={selectedShape.imageFit ?? "cover"}
                          onChange={(event) =>
                            patchSelectedShape({ imageFit: event.target.value as SlideImageFit })
                          }
                          style={INPUT_STYLE}
                        >
                          <option value="cover">Fill</option>
                          <option value="contain">Fit</option>
                        </select>
                      </label>
                      <label style={FIELD_STYLE}>
                        <span style={LABEL_STYLE}>Image mask</span>
                        <select
                          aria-label="Shape image mask"
                          value={selectedShape.imageMask ?? "rounded"}
                          onChange={(event) =>
                            patchSelectedShape({ imageMask: event.target.value as SlideImageMask })
                          }
                          style={INPUT_STYLE}
                        >
                          <option value="rounded">Rounded</option>
                          <option value="rectangle">Rectangle</option>
                          <option value="circle">Circle</option>
                        </select>
                      </label>
                      <label style={FIELD_STYLE}>
                        <span style={LABEL_STYLE}>Upload image</span>
                        <input
                          aria-label="Upload shape image"
                          type="file"
                          accept="image/*"
                          disabled={imageUploadMutation.isPending}
                          onChange={(event) => {
                            const file = event.currentTarget.files?.[0];
                            event.currentTarget.value = "";
                            void uploadSelectedShapeImage(file);
                          }}
                          style={INPUT_STYLE}
                        />
                      </label>
                      <label style={FIELD_STYLE}>
                        <span style={LABEL_STYLE}>Drive image</span>
                        <select
                          aria-label="Drive image asset"
                          value={driveAssetSelectValue(selectedShape.imageUrl, driveImageAssets)}
                          disabled={driveImageAssets.length === 0}
                          onChange={(event) => pickDriveImageAsset(event.target.value)}
                          style={INPUT_STYLE}
                        >
                          <option value="">
                            {driveImageAssets.length === 0 ? "No Drive images" : "Choose image"}
                          </option>
                          {driveImageAssets.map((asset) => (
                            <option key={asset.id} value={asset.id}>
                              {asset.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {imageUploadMutation.isPending ? (
                        <div role="status" style={EMPTY_STYLE}>
                          Uploading image...
                        </div>
                      ) : null}
                      {imageUploadMutation.isError ? (
                        <div role="alert" style={EMPTY_STYLE}>
                          Image upload failed.
                        </div>
                      ) : null}
                    </>
                  ) : null}
                  {selectedShape.kind === "media" ? (
                    <>
                      <label style={FIELD_STYLE}>
                        <span style={LABEL_STYLE}>Media URL</span>
                        <input
                          aria-label="Shape media URL"
                          value={selectedShape.mediaUrl ?? ""}
                          onChange={(event) => patchSelectedShape({ mediaUrl: event.target.value })}
                          style={INPUT_STYLE}
                        />
                      </label>
                      <label style={FIELD_STYLE}>
                        <span style={LABEL_STYLE}>Media title</span>
                        <input
                          aria-label="Shape media title"
                          value={selectedShape.mediaTitle ?? ""}
                          onChange={(event) =>
                            patchSelectedShape({ mediaTitle: event.target.value })
                          }
                          style={INPUT_STYLE}
                        />
                      </label>
                      <label style={FIELD_STYLE}>
                        <span style={LABEL_STYLE}>Media type</span>
                        <select
                          aria-label="Shape media type"
                          value={selectedShape.mediaType ?? "video"}
                          onChange={(event) =>
                            patchSelectedShape({ mediaType: event.target.value as SlideMediaType })
                          }
                          style={INPUT_STYLE}
                        >
                          <option value="video">Video</option>
                          <option value="audio">Audio</option>
                        </select>
                      </label>
                      <label style={FIELD_STYLE}>
                        <span style={LABEL_STYLE}>Caption track URL</span>
                        <input
                          aria-label="Shape media caption URL"
                          value={selectedShape.mediaCaptionUrl ?? ""}
                          onChange={(event) =>
                            patchSelectedShape({ mediaCaptionUrl: event.target.value })
                          }
                          style={INPUT_STYLE}
                        />
                      </label>
                      <label style={FIELD_STYLE}>
                        <span style={LABEL_STYLE}>Caption label</span>
                        <input
                          aria-label="Shape media caption label"
                          value={selectedShape.mediaCaptionLabel ?? ""}
                          onChange={(event) =>
                            patchSelectedShape({ mediaCaptionLabel: event.target.value })
                          }
                          style={INPUT_STYLE}
                        />
                      </label>
                      {(selectedShape.mediaType ?? "video") === "video" ? (
                        <>
                          <label style={FIELD_STYLE}>
                            <span style={LABEL_STYLE}>Poster URL</span>
                            <input
                              aria-label="Shape media poster URL"
                              value={selectedShape.mediaPosterUrl ?? ""}
                              onChange={(event) =>
                                patchSelectedShape({ mediaPosterUrl: event.target.value })
                              }
                              style={INPUT_STYLE}
                            />
                          </label>
                          <label style={FIELD_STYLE}>
                            <span style={LABEL_STYLE}>Drive poster</span>
                            <select
                              aria-label="Drive poster image"
                              value={driveAssetSelectValue(
                                selectedShape.mediaPosterUrl,
                                driveImageAssets,
                              )}
                              disabled={driveImageAssets.length === 0}
                              onChange={(event) => pickDriveMediaPosterAsset(event.target.value)}
                              style={INPUT_STYLE}
                            >
                              <option value="">
                                {driveImageAssets.length === 0
                                  ? "No Drive images"
                                  : "Choose poster"}
                              </option>
                              {driveImageAssets.map((asset) => (
                                <option key={asset.id} value={asset.id}>
                                  {asset.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div style={SHAPE_GRID_STYLE}>
                            <NumberField
                              label="Shape media trim start"
                              value={selectedShape.mediaStartSeconds ?? 0}
                              max={86_400}
                              onChange={(value) => patchSelectedShape({ mediaStartSeconds: value })}
                            />
                            <NumberField
                              label="Shape media trim end"
                              value={selectedShape.mediaEndSeconds ?? 0}
                              max={86_400}
                              onChange={(value) => patchSelectedShape({ mediaEndSeconds: value })}
                            />
                          </div>
                          <div style={MEDIA_PREVIEW_ROW_STYLE}>
                            <button
                              type="button"
                              className="btn sm"
                              disabled={(selectedShape.mediaUrl?.trim().length ?? 0) === 0}
                              onClick={previewSelectedMediaTrim}
                            >
                              <Icons.Video /> Preview trim
                            </button>
                            {mediaTrimPreviewStatus.length > 0 ? (
                              <span role="status" style={EMPTY_STYLE}>
                                {mediaTrimPreviewStatus}
                              </span>
                            ) : null}
                          </div>
                          <div style={SHAPE_GRID_STYLE}>
                            <label style={CHECKBOX_LABEL_STYLE}>
                              <input
                                aria-label="Shape media autoplay"
                                type="checkbox"
                                checked={selectedShape.mediaAutoplay === true}
                                onChange={(event) =>
                                  patchSelectedShape({ mediaAutoplay: event.target.checked })
                                }
                              />
                              Autoplay
                            </label>
                            <label style={CHECKBOX_LABEL_STYLE}>
                              <input
                                aria-label="Shape media loop"
                                type="checkbox"
                                checked={selectedShape.mediaLoop === true}
                                onChange={(event) =>
                                  patchSelectedShape({ mediaLoop: event.target.checked })
                                }
                              />
                              Loop
                            </label>
                            <label style={CHECKBOX_LABEL_STYLE}>
                              <input
                                aria-label="Shape media muted"
                                type="checkbox"
                                checked={selectedShape.mediaMuted === true}
                                onChange={(event) =>
                                  patchSelectedShape({ mediaMuted: event.target.checked })
                                }
                              />
                              Muted
                            </label>
                          </div>
                        </>
                      ) : null}
                      <label style={FIELD_STYLE}>
                        <span style={LABEL_STYLE}>Upload media</span>
                        <input
                          aria-label="Upload shape media"
                          type="file"
                          accept="video/*,audio/*"
                          disabled={mediaUploadMutation.isPending}
                          onChange={(event) => {
                            const file = event.currentTarget.files?.[0];
                            event.currentTarget.value = "";
                            void uploadSelectedShapeMedia(file);
                          }}
                          style={INPUT_STYLE}
                        />
                      </label>
                      <label style={FIELD_STYLE}>
                        <span style={LABEL_STYLE}>Drive media</span>
                        <select
                          aria-label="Drive media asset"
                          value={driveAssetSelectValue(selectedShape.mediaUrl, driveMediaAssets)}
                          disabled={driveMediaAssets.length === 0}
                          onChange={(event) => pickDriveMediaAsset(event.target.value)}
                          style={INPUT_STYLE}
                        >
                          <option value="">
                            {driveMediaAssets.length === 0 ? "No Drive media" : "Choose media"}
                          </option>
                          {driveMediaAssets.map((asset) => (
                            <option key={asset.id} value={asset.id}>
                              {asset.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {mediaUploadMutation.isPending ? (
                        <div role="status" style={EMPTY_STYLE}>
                          Uploading media...
                        </div>
                      ) : null}
                      {mediaUploadMutation.isError ? (
                        <div role="alert" style={EMPTY_STYLE}>
                          Media upload failed.
                        </div>
                      ) : null}
                    </>
                  ) : null}
                  <div style={SHAPE_GRID_STYLE}>
                    <NumberField
                      label="Shape x"
                      value={selectedShape.x}
                      onChange={(value) => patchSelectedShape({ x: value })}
                    />
                    <NumberField
                      label="Shape y"
                      value={selectedShape.y}
                      onChange={(value) => patchSelectedShape({ y: value })}
                    />
                    <NumberField
                      label="Shape width"
                      value={selectedShape.width}
                      onChange={(value) => patchSelectedShape({ width: value })}
                    />
                    <NumberField
                      label="Shape height"
                      value={selectedShape.height}
                      onChange={(value) => patchSelectedShape({ height: value })}
                    />
                  </div>
                  <label style={FIELD_STYLE}>
                    <span style={LABEL_STYLE}>Tone</span>
                    <select
                      aria-label="Shape tone"
                      value={selectedShape.tone ?? "accent"}
                      onChange={(event) =>
                        patchSelectedShape({ tone: event.target.value as SlideShapeTone })
                      }
                      style={INPUT_STYLE}
                    >
                      <option value="accent">Accent</option>
                      <option value="light">Light</option>
                      <option value="dark">Dark</option>
                    </select>
                  </label>
                  <label style={FIELD_STYLE}>
                    <span style={LABEL_STYLE}>Animation</span>
                    <select
                      aria-label="Shape animation"
                      value={selectedShape.animation?.type ?? "none"}
                      onChange={(event) =>
                        patchSelectedShape({
                          animation: animationFromSelection(
                            event.target.value,
                            selectedShape.animation,
                            selectedShapeIndex,
                          ),
                        })
                      }
                      style={INPUT_STYLE}
                    >
                      <option value="none">None</option>
                      <option value="fade">Entrance fade</option>
                      <option value="fly">Entrance fly</option>
                      <option value="zoom">Entrance zoom</option>
                    </select>
                  </label>
                  {selectedShape.animation !== undefined ? (
                    <div style={SHAPE_GRID_STYLE}>
                      <NumberField
                        label="Animation order"
                        value={selectedShape.animation.order ?? Math.max(selectedShapeIndex, 0)}
                        max={199}
                        onChange={(value) =>
                          patchSelectedShape({
                            animation: normalizeSlideShapeAnimation({
                              ...selectedShape.animation,
                              order: value,
                            }),
                          })
                        }
                      />
                      <NumberField
                        label="Animation duration"
                        value={selectedShape.animation.durationMs ?? 620}
                        min={120}
                        max={5_000}
                        onChange={(value) =>
                          patchSelectedShape({
                            animation: normalizeSlideShapeAnimation({
                              ...selectedShape.animation,
                              durationMs: value,
                            }),
                          })
                        }
                      />
                      <label style={FIELD_STYLE}>
                        <span style={LABEL_STYLE}>Easing</span>
                        <select
                          aria-label="Animation easing"
                          value={selectedShape.animation.easing ?? "standard"}
                          onChange={(event) =>
                            patchSelectedShape({
                              animation: normalizeSlideShapeAnimation({
                                ...selectedShape.animation,
                                easing: event.target.value as SlideShapeAnimationEasing,
                              }),
                            })
                          }
                          style={INPUT_STYLE}
                        >
                          <option value="standard">Standard</option>
                          <option value="linear">Linear</option>
                          <option value="easeIn">Ease in</option>
                          <option value="easeOut">Ease out</option>
                          <option value="easeInOut">Ease in/out</option>
                        </select>
                      </label>
                      {selectedShape.animation.type === "fly" ? (
                        <label style={FIELD_STYLE}>
                          <span style={LABEL_STYLE}>Motion path</span>
                          <select
                            aria-label="Shape motion path"
                            value={selectedShape.animation.motionPath ?? "left"}
                            onChange={(event) =>
                              patchSelectedShape({
                                animation: normalizeSlideShapeAnimation({
                                  ...selectedShape.animation,
                                  motionPath: event.target.value as SlideShapeMotionPath,
                                }),
                              })
                            }
                            style={INPUT_STYLE}
                          >
                            <option value="left">Left</option>
                            <option value="right">Right</option>
                            <option value="up">Up</option>
                            <option value="down">Down</option>
                          </select>
                        </label>
                      ) : null}
                    </div>
                  ) : null}
                  <label style={FIELD_STYLE}>
                    <span style={LABEL_STYLE}>Exit animation</span>
                    <select
                      aria-label="Shape exit animation"
                      value={selectedShape.exitAnimation?.type ?? "none"}
                      onChange={(event) =>
                        patchSelectedShape({
                          exitAnimation: animationFromSelection(
                            event.target.value,
                            selectedShape.exitAnimation,
                            selectedShapeIndex,
                          ),
                        })
                      }
                      style={INPUT_STYLE}
                    >
                      <option value="none">None</option>
                      <option value="fade">Exit fade</option>
                      <option value="fly">Exit fly</option>
                      <option value="zoom">Exit zoom</option>
                    </select>
                  </label>
                  {selectedShape.exitAnimation !== undefined ? (
                    <div style={SHAPE_GRID_STYLE}>
                      <NumberField
                        label="Exit animation order"
                        value={selectedShape.exitAnimation.order ?? Math.max(selectedShapeIndex, 0)}
                        max={199}
                        onChange={(value) =>
                          patchSelectedShape({
                            exitAnimation: normalizeSlideShapeAnimation({
                              ...selectedShape.exitAnimation,
                              order: value,
                            }),
                          })
                        }
                      />
                      <NumberField
                        label="Exit animation duration"
                        value={selectedShape.exitAnimation.durationMs ?? 620}
                        min={120}
                        max={5_000}
                        onChange={(value) =>
                          patchSelectedShape({
                            exitAnimation: normalizeSlideShapeAnimation({
                              ...selectedShape.exitAnimation,
                              durationMs: value,
                            }),
                          })
                        }
                      />
                      <label style={FIELD_STYLE}>
                        <span style={LABEL_STYLE}>Exit easing</span>
                        <select
                          aria-label="Exit animation easing"
                          value={selectedShape.exitAnimation.easing ?? "standard"}
                          onChange={(event) =>
                            patchSelectedShape({
                              exitAnimation: normalizeSlideShapeAnimation({
                                ...selectedShape.exitAnimation,
                                easing: event.target.value as SlideShapeAnimationEasing,
                              }),
                            })
                          }
                          style={INPUT_STYLE}
                        >
                          <option value="standard">Standard</option>
                          <option value="linear">Linear</option>
                          <option value="easeIn">Ease in</option>
                          <option value="easeOut">Ease out</option>
                          <option value="easeInOut">Ease in/out</option>
                        </select>
                      </label>
                      {selectedShape.exitAnimation.type === "fly" ? (
                        <label style={FIELD_STYLE}>
                          <span style={LABEL_STYLE}>Exit motion path</span>
                          <select
                            aria-label="Shape exit motion path"
                            value={selectedShape.exitAnimation.motionPath ?? "left"}
                            onChange={(event) =>
                              patchSelectedShape({
                                exitAnimation: normalizeSlideShapeAnimation({
                                  ...selectedShape.exitAnimation,
                                  motionPath: event.target.value as SlideShapeMotionPath,
                                }),
                              })
                            }
                            style={INPUT_STYLE}
                          >
                            <option value="left">Left</option>
                            <option value="right">Right</option>
                            <option value="up">Up</option>
                            <option value="down">Down</option>
                          </select>
                        </label>
                      ) : null}
                    </div>
                  ) : null}
                  {selectedShape.kind === "connector" ? (
                    <>
                      <label style={FIELD_STYLE}>
                        <span style={LABEL_STYLE}>Direction</span>
                        <select
                          aria-label="Connector direction"
                          value={selectedShape.connectorDirection ?? "up"}
                          onChange={(event) =>
                            patchSelectedShape({
                              connectorDirection: event.target.value as SlideConnectorDirection,
                            })
                          }
                          style={INPUT_STYLE}
                        >
                          <option value="up">Up</option>
                          <option value="down">Down</option>
                        </select>
                      </label>
                      <label style={FIELD_STYLE}>
                        <span style={LABEL_STYLE}>Arrow</span>
                        <select
                          aria-label="Connector arrow"
                          value={selectedShape.connectorArrow ?? "end"}
                          onChange={(event) =>
                            patchSelectedShape({
                              connectorArrow: event.target.value as SlideConnectorArrow,
                            })
                          }
                          style={INPUT_STYLE}
                        >
                          <option value="start">Start</option>
                          <option value="end">End</option>
                          <option value="both">Both</option>
                          <option value="none">None</option>
                        </select>
                      </label>
                    </>
                  ) : null}
                  <div style={SHAPE_ACTION_ROW_STYLE}>
                    <button
                      className="btn sm"
                      type="button"
                      aria-label="Send shape backward"
                      disabled={selectedShapeIndex <= 0}
                      onClick={() => moveSelectedShape(-1)}
                    >
                      <Icons.ChevronDown style={{ transform: "rotate(90deg)" }} /> Back
                    </button>
                    <button
                      className="btn sm"
                      type="button"
                      aria-label="Bring shape forward"
                      disabled={
                        selectedShapeIndex < 0 || selectedShapeIndex >= draft.shapes.length - 1
                      }
                      onClick={() => moveSelectedShape(1)}
                    >
                      <Icons.ChevronDown style={{ transform: "rotate(-90deg)" }} /> Front
                    </button>
                  </div>
                  <button className="btn sm" type="button" onClick={deleteSelectedShape}>
                    <Icons.Trash /> Delete shape
                  </button>
                </>
              ) : null}
            </>
          ) : (
            <p style={EMPTY_STYLE}>No shapes</p>
          )}
        </fieldset>
        <label style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>Speaker notes</span>
          <textarea
            aria-label="Speaker notes"
            value={draft.speakerNotes}
            onChange={(event) => patchDraft({ speakerNotes: event.target.value })}
            rows={4}
            style={TEXTAREA_STYLE}
          />
        </label>
        <div style={ACTION_ROW_STYLE}>
          <button
            type="submit"
            className="btn sm primary"
            disabled={
              saving ||
              imageUploadMutation.isPending ||
              mediaUploadMutation.isPending ||
              draft.title.trim().length === 0
            }
          >
            {saving ? "Saving..." : "Save slide"}
          </button>
        </div>
      </form>
    </>
  );
}

type ShapeDragMode = "move" | "resize" | "connector-left" | "connector-right";

interface ShapeDragState {
  readonly mode: ShapeDragMode;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly startShape: SlideShape;
  readonly layerWidth: number;
  readonly layerHeight: number;
}

interface ShapeDragPoint {
  readonly x: number;
  readonly y: number;
  readonly deltaX: number;
  readonly deltaY: number;
}

function slideTitle(content: SlideContent): string {
  return content.title;
}

function collaboratorPresenceTitle(
  collaborator: PresentationCollaborator,
  slides: readonly SlidesApiSlide[],
): string {
  if (collaborator.selectedSlideId === null) {
    return `${collaborator.displayName} is ${collaborator.mode}`;
  }
  const slideIndex = slides.findIndex((slide) => slide.id === collaborator.selectedSlideId);
  if (slideIndex < 0) {
    return `${collaborator.displayName} is ${collaborator.mode}`;
  }
  const shapeTitle = collaboratorShapeTitle(slides[slideIndex], collaborator.selectedShapeId);
  const slideSummary = `slide ${String(slideIndex + 1)}`;
  return shapeTitle === null
    ? `${collaborator.displayName} is ${collaborator.mode} on ${slideSummary}`
    : `${collaborator.displayName} is ${collaborator.mode} on ${slideSummary}, ${shapeTitle}`;
}

function collaboratorShapeTitle(
  slide: SlidesApiSlide | undefined,
  selectedShapeId: string | null,
): string | null {
  if (slide === undefined || selectedShapeId === null) {
    return null;
  }
  const shapes = slideShapes(slide.content);
  const shapeIndex = shapes.findIndex((shape) => shape.id === selectedShapeId);
  const shape = shapes[shapeIndex];
  return shape === undefined ? null : shapeLabel(shape, shapeIndex);
}

function slidesCommentThreads(
  comments: readonly SlidesDriveComment[],
): readonly SlidesCommentThread[] {
  const repliesByParent = new Map<string, SlidesDriveComment[]>();
  for (const comment of comments) {
    const parentId = comment.parentCommentId ?? null;
    if (parentId === null) continue;
    repliesByParent.set(parentId, [...(repliesByParent.get(parentId) ?? []), comment]);
  }
  return comments
    .filter((comment) => comment.parentCommentId === null || comment.parentCommentId === undefined)
    .map((root) => ({ root, replies: repliesByParent.get(root.id) ?? [] }));
}

function slidesSelectedCommentThreadId(
  threads: readonly SlidesCommentThread[],
  commentId: string,
): string | null {
  for (const thread of threads) {
    if (thread.root.id === commentId || thread.replies.some((reply) => reply.id === commentId)) {
      return thread.root.id;
    }
  }
  return null;
}

function slideOpenCommentCounts(comments: readonly SlidesDriveComment[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const comment of comments) {
    if (
      comment.status !== "open" ||
      (comment.parentCommentId !== null && comment.parentCommentId !== undefined)
    ) {
      continue;
    }
    const slideId = slidesCommentSlideId(comment);
    if (slideId === null) continue;
    counts.set(slideId, (counts.get(slideId) ?? 0) + 1);
  }
  return counts;
}

function slidesCommentTarget(input: {
  readonly deckId: string;
  readonly slide: SlidesApiSlide;
  readonly slideIndex: number;
  readonly shape: SlideShape | null;
  readonly shapeIndex: number;
}): SlidesCommentTarget {
  const slideLabel = `Slide ${String(input.slideIndex + 1)}: ${slideTitle(input.slide.content)}`;
  if (input.shape !== null && input.shapeIndex >= 0) {
    const shape = shapeLabel(input.shape, input.shapeIndex);
    return {
      label: `${slideLabel} / ${shape}`,
      buttonLabel: "Comment on selected shape",
      anchor: {
        kind: "slides-shape",
        target: "shape",
        deckId: input.deckId,
        slideId: input.slide.id,
        slideIndex: input.slideIndex,
        slideTitle: slideTitle(input.slide.content),
        shapeId: input.shape.id,
        shapeLabel: shape,
      },
      metadata: { source: "web.native-presentation-editor.comments", anchorKind: "shape" },
    };
  }
  return {
    label: slideLabel,
    buttonLabel: "Comment on slide",
    anchor: {
      kind: "slides-slide",
      target: "slide",
      deckId: input.deckId,
      slideId: input.slide.id,
      slideIndex: input.slideIndex,
      slideTitle: slideTitle(input.slide.content),
    },
    metadata: { source: "web.native-presentation-editor.comments", anchorKind: "slide" },
  };
}

function slidesCommentMetadataWithMentions(
  metadata: Record<string, unknown>,
  body: string,
): Record<string, unknown> {
  const mentionsText = extractSlidesMentionText(body);
  return mentionsText.length === 0 ? metadata : { ...metadata, mentionsText };
}

function slidesCommentMetadataWithoutMentions(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...metadata };
  delete next.mentionsText;
  return next;
}

function slidesMentionOptions(
  people: readonly PeopleDirectoryPerson[],
): readonly SlidesMentionOption[] {
  return people
    .map((person) => {
      const token = mentionTokenForPerson(person);
      if (token === null) {
        return null;
      }
      return {
        person,
        label: person.displayName.trim() || person.email || "Unknown person",
        token,
      };
    })
    .filter((option): option is SlidesMentionOption => option !== null);
}

function activeMentionQuery(value: string): string | null {
  const match = value.match(/(^|\s)@([\p{L}\p{N}._-]*)$/u);
  return match === null ? null : (match[2] ?? "").toLowerCase();
}

function filteredSlidesMentionOptions(
  options: readonly SlidesMentionOption[],
  query: string,
): readonly SlidesMentionOption[] {
  const normalizedQuery = normalizeMentionToken(query);
  return options
    .filter((option) => {
      if (normalizedQuery.length === 0) {
        return true;
      }
      return mentionSearchText(option).includes(normalizedQuery);
    })
    .slice(0, 6);
}

function valueWithInsertedMention(value: string, token: string): string {
  return value.replace(/(^|\s)@[\p{L}\p{N}._-]*$/u, (_match, prefix: string) => {
    return `${prefix}@${token} `;
  });
}

function mentionTokenForPerson(person: PeopleDirectoryPerson): string | null {
  const emailLocalPart = person.email?.split("@")[0];
  const emailToken =
    emailLocalPart === undefined
      ? null
      : normalizeMentionToken(emailLocalPart).replace(/[^a-z0-9._-]+/gu, "");
  if (emailToken !== null && emailToken.length > 0) {
    return emailToken;
  }
  const firstName = person.displayName.trim().split(/\s+/u)[0];
  const displayToken =
    firstName === undefined
      ? null
      : normalizeMentionToken(firstName).replace(/[^a-z0-9._-]+/gu, "");
  return displayToken !== null && displayToken.length > 0 ? displayToken : null;
}

function mentionSearchText(option: SlidesMentionOption): string {
  return normalizeMentionToken(
    [option.label, option.person.email, option.token].filter(Boolean).join(" "),
  );
}

function extractSlidesMentionText(value: string): readonly string[] {
  const mentions = new Set<string>();
  for (const match of value.matchAll(/(^|\s)@([\p{L}\p{N}](?:[\p{L}\p{N}._-]*[\p{L}\p{N}])?)/gu)) {
    const mention = match[2]?.trim();
    if (mention !== undefined && mention.length > 0) {
      mentions.add(mention);
    }
  }
  return [...mentions];
}

function slidesCommentAnchorLabel(
  comment: SlidesDriveComment,
  slides: readonly SlidesApiSlide[],
): string {
  const slideId = slidesCommentSlideId(comment);
  const slideIndex = slideId === null ? -1 : slides.findIndex((slide) => slide.id === slideId);
  const slide = slideIndex < 0 ? undefined : slides[slideIndex];
  const slideLabel =
    slide === undefined
      ? (stringValue(comment.anchor.slideTitle) ?? "Unavailable slide")
      : `Slide ${String(slideIndex + 1)}: ${slideTitle(slide.content)}`;
  const shapeId = slidesCommentShapeId(comment);
  if (shapeId === null) {
    return slideLabel;
  }
  const shapes = slide === undefined ? [] : slideShapes(slide.content);
  const shapeIndex = shapes.findIndex((shape) => shape.id === shapeId);
  const shape =
    slide === undefined || shapeIndex < 0
      ? (stringValue(comment.anchor.shapeLabel) ?? shapeId)
      : shapeLabel(shapes[shapeIndex] as SlideShape, shapeIndex);
  return `${slideLabel} / ${shape}`;
}

function slidesCommentSlideId(comment: SlidesDriveComment): string | null {
  return stringValue(comment.anchor.slideId);
}

function slidesCommentShapeId(comment: SlidesDriveComment): string | null {
  return stringValue(comment.anchor.shapeId);
}

function normalizeMentionToken(value: string): string {
  return value.trim().replace(/^@/u, "").toLowerCase();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function cloneSlideContent(content: SlideContent): SlideContent {
  return typeof structuredClone === "function"
    ? structuredClone(content)
    : (JSON.parse(JSON.stringify(content)) as SlideContent);
}

function initials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return "?";
  }
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function NumberField({
  label,
  value,
  min = 0,
  max = 100,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <label style={FIELD_STYLE}>
      <span style={LABEL_STYLE}>{label.replace("Shape ", "")}</span>
      <input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        value={String(value)}
        onChange={(event) => onChange(Number(event.target.value))}
        style={INPUT_STYLE}
      />
    </label>
  );
}

function MediaAssetTable({
  shapes,
  selectedShapeId,
  onSelectShape,
}: {
  readonly shapes: readonly SlideShape[];
  readonly selectedShapeId: string | null;
  readonly onSelectShape: (shapeId: string) => void;
}) {
  return (
    <div style={MEDIA_ASSET_TABLE_WRAP_STYLE}>
      <span style={LABEL_STYLE}>Media assets</span>
      <table aria-label="Slide media assets" style={MEDIA_ASSET_TABLE_STYLE}>
        <thead>
          <tr>
            <th style={MEDIA_ASSET_HEADER_STYLE} scope="col">
              Asset
            </th>
            <th style={MEDIA_ASSET_HEADER_STYLE} scope="col">
              Source
            </th>
            <th style={MEDIA_ASSET_HEADER_STYLE} scope="col">
              Playback
            </th>
          </tr>
        </thead>
        <tbody>
          {shapes.map((shape, index) => (
            <tr
              key={shape.id}
              aria-selected={shape.id === selectedShapeId}
              style={shape.id === selectedShapeId ? MEDIA_ASSET_ROW_SELECTED_STYLE : undefined}
            >
              <td style={MEDIA_ASSET_CELL_STYLE}>
                <button
                  className="btn ghost sm"
                  type="button"
                  aria-label={`Select media asset ${mediaAssetTitle(shape, index)}`}
                  onClick={() => onSelectShape(shape.id)}
                >
                  {mediaAssetTitle(shape, index)}
                </button>
                <span style={MEDIA_ASSET_META_STYLE}>
                  {shape.mediaType === "audio" ? "Audio" : "Video"}
                </span>
              </td>
              <td style={MEDIA_ASSET_CELL_STYLE}>{mediaAssetSource(shape)}</td>
              <td style={MEDIA_ASSET_CELL_STYLE}>{mediaAssetPlayback(shape)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShapeAnimationTimeline({
  rows,
  selectedShapeId,
  onSelectShape,
}: {
  readonly rows: readonly ShapeAnimationTimelineRow[];
  readonly selectedShapeId: string | null;
  readonly onSelectShape: (shapeId: string) => void;
}) {
  return (
    <div style={MEDIA_ASSET_TABLE_WRAP_STYLE}>
      <span style={LABEL_STYLE}>Animation timeline</span>
      <table aria-label="Shape animation timeline" style={MEDIA_ASSET_TABLE_STYLE}>
        <thead>
          <tr>
            <th style={MEDIA_ASSET_HEADER_STYLE} scope="col">
              Phase
            </th>
            <th style={MEDIA_ASSET_HEADER_STYLE} scope="col">
              Shape
            </th>
            <th style={MEDIA_ASSET_HEADER_STYLE} scope="col">
              Timing
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              aria-selected={row.shapeId === selectedShapeId}
              style={row.shapeId === selectedShapeId ? MEDIA_ASSET_ROW_SELECTED_STYLE : undefined}
            >
              <td style={MEDIA_ASSET_CELL_STYLE}>
                {shapeAnimationPhaseLabel(row.phase)}
                <span style={MEDIA_ASSET_META_STYLE}>{shapeAnimationTypeLabel(row)}</span>
              </td>
              <td style={MEDIA_ASSET_CELL_STYLE}>
                <button
                  className="btn ghost sm"
                  type="button"
                  aria-label={`Select animation ${shapeAnimationPhaseLabel(row.phase).toLowerCase()} ${row.shapeLabel}`}
                  onClick={() => onSelectShape(row.shapeId)}
                >
                  {row.shapeLabel}
                </button>
              </td>
              <td style={MEDIA_ASSET_CELL_STYLE}>
                {`Order ${String(row.order)}`}
                <span style={MEDIA_ASSET_META_STYLE}>
                  {`${String(row.durationMs)}ms / ${shapeAnimationEasingLabel(row.easing)}`}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeckMediaAssetTable({
  slides,
  activeSlideId,
  driveImageAssets,
  driveMediaAssets,
  onOpenMediaAsset,
  onApplyDeckMediaAction,
  onUpdateMediaPlayback,
  onReplaceMediaSource,
  onReplaceMediaPoster,
  onReplaceBlockingSources,
  onReplaceDuplicateSources,
}: {
  readonly slides: readonly SlidesApiSlide[];
  readonly activeSlideId: string | null;
  readonly driveImageAssets: readonly DriveApiEntry[];
  readonly driveMediaAssets: readonly DriveApiEntry[];
  readonly onOpenMediaAsset: (slideId: string, shapeId: string) => void;
  readonly onApplyDeckMediaAction: (action: DeckMediaAction) => void;
  readonly onUpdateMediaPlayback: (
    slide: SlidesApiSlide,
    shapeId: string,
    playback: DeckMediaPlaybackUpdate,
  ) => void;
  readonly onReplaceMediaSource: (slide: SlidesApiSlide, shapeId: string, objectId: string) => void;
  readonly onReplaceMediaPoster: (slide: SlidesApiSlide, shapeId: string, objectId: string) => void;
  readonly onReplaceBlockingSources: (mediaType: SlideMediaType, objectId: string) => void;
  readonly onReplaceDuplicateSources: (mediaType: SlideMediaType, objectId: string) => void;
}) {
  const [mediaFilter, setMediaFilter] = useState<DeckMediaFilter>("all");
  const [bulkVideoAssetId, setBulkVideoAssetId] = useState("");
  const [bulkAudioAssetId, setBulkAudioAssetId] = useState("");
  const [duplicateVideoAssetId, setDuplicateVideoAssetId] = useState("");
  const [duplicateAudioAssetId, setDuplicateAudioAssetId] = useState("");
  const assets = deckMediaAssetRows(slides);
  const readiness = mediaAssetReadiness(assets);
  const visibleAssets = assets.filter((row) => matchesDeckMediaFilter(row, mediaFilter));
  const driveVideoAssets = driveMediaAssets.filter(
    (asset) => driveEntryMediaType(asset) === "video",
  );
  const driveAudioAssets = driveMediaAssets.filter(
    (asset) => driveEntryMediaType(asset) === "audio",
  );
  const videoBlockingSources = mediaBlockingSourceCount(assets, "video");
  const audioBlockingSources = mediaBlockingSourceCount(assets, "audio");
  const duplicateVideoSources = mediaDuplicateReplacementRows(assets, "video").length;
  const duplicateAudioSources = mediaDuplicateReplacementRows(assets, "audio").length;
  if (assets.length === 0) {
    return null;
  }

  return (
    <div style={DECK_MEDIA_ASSET_TABLE_WRAP_STYLE}>
      <span style={LABEL_STYLE}>Deck media</span>
      <div style={DECK_MEDIA_ASSET_ACTION_BAR_STYLE}>
        <label style={DECK_MEDIA_FILTER_LABEL_STYLE}>
          Filter
          <select
            aria-label="Deck media filter"
            value={mediaFilter}
            onChange={(event) => setMediaFilter(event.currentTarget.value as DeckMediaFilter)}
            style={DECK_MEDIA_FILTER_SELECT_STYLE}
          >
            <option value="all">All media</option>
            <option value="video">Video</option>
            <option value="audio">Audio</option>
            <option value="needs-attention">Needs attention</option>
            <option value="external">External source</option>
            <option value="missing-poster">Missing poster</option>
            <option value="duplicate">Duplicate source</option>
          </select>
        </label>
      </div>
      <span style={MEDIA_ASSET_META_STYLE} aria-label="Deck media readiness">
        Ready {String(readiness.ready)}/{String(readiness.total)} · Needs attention{" "}
        {String(readiness.needsAttention)} · External {String(readiness.external)} · Missing poster{" "}
        {String(readiness.missingPoster)} · Duplicates {String(readiness.duplicates)}
      </span>
      <span style={MEDIA_ASSET_META_STYLE} aria-label="Deck media export readiness">
        Export blockers {String(readiness.exportBlockers)} · Export warnings{" "}
        {String(readiness.exportWarnings)}
      </span>
      <span style={DECK_MEDIA_ASSET_ACTION_BAR_STYLE}>
        <button
          className="btn ghost sm"
          type="button"
          onClick={() => onApplyDeckMediaAction("muteVideo")}
        >
          Mute all video
        </button>
        <button
          className="btn ghost sm"
          type="button"
          onClick={() => onApplyDeckMediaAction("disableAutoplay")}
        >
          Disable autoplay
        </button>
        <button
          className="btn ghost sm"
          type="button"
          onClick={() => onApplyDeckMediaAction("disableLoop")}
        >
          Disable loop
        </button>
        <button
          className="btn ghost sm"
          type="button"
          onClick={() => onApplyDeckMediaAction("resetTrims")}
        >
          Reset trims
        </button>
      </span>
      <span style={DECK_MEDIA_ASSET_ACTION_BAR_STYLE}>
        <label style={DECK_MEDIA_FILTER_LABEL_STYLE}>
          Video source
          <select
            aria-label="Bulk deck video source"
            value={bulkVideoAssetId}
            disabled={driveVideoAssets.length === 0 || videoBlockingSources === 0}
            onChange={(event) => setBulkVideoAssetId(event.target.value)}
            style={DECK_MEDIA_REPLACE_SELECT_STYLE}
          >
            <option value="">
              {videoBlockingSources === 0
                ? "No blocked video"
                : driveVideoAssets.length === 0
                  ? "No Drive video"
                  : "Choose video"}
            </option>
            {driveVideoAssets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn ghost sm"
          type="button"
          disabled={bulkVideoAssetId.length === 0 || videoBlockingSources === 0}
          onClick={() => onReplaceBlockingSources("video", bulkVideoAssetId)}
        >
          Replace {String(videoBlockingSources)} blocked video source
          {videoBlockingSources === 1 ? "" : "s"}
        </button>
        <label style={DECK_MEDIA_FILTER_LABEL_STYLE}>
          Audio source
          <select
            aria-label="Bulk deck audio source"
            value={bulkAudioAssetId}
            disabled={driveAudioAssets.length === 0 || audioBlockingSources === 0}
            onChange={(event) => setBulkAudioAssetId(event.target.value)}
            style={DECK_MEDIA_REPLACE_SELECT_STYLE}
          >
            <option value="">
              {audioBlockingSources === 0
                ? "No blocked audio"
                : driveAudioAssets.length === 0
                  ? "No Drive audio"
                  : "Choose audio"}
            </option>
            {driveAudioAssets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn ghost sm"
          type="button"
          disabled={bulkAudioAssetId.length === 0 || audioBlockingSources === 0}
          onClick={() => onReplaceBlockingSources("audio", bulkAudioAssetId)}
        >
          Replace {String(audioBlockingSources)} blocked audio source
          {audioBlockingSources === 1 ? "" : "s"}
        </button>
      </span>
      <span style={DECK_MEDIA_ASSET_ACTION_BAR_STYLE}>
        <label style={DECK_MEDIA_FILTER_LABEL_STYLE}>
          Duplicate video source
          <select
            aria-label="Duplicate deck video source"
            value={duplicateVideoAssetId}
            disabled={driveVideoAssets.length === 0 || duplicateVideoSources === 0}
            onChange={(event) => setDuplicateVideoAssetId(event.target.value)}
            style={DECK_MEDIA_REPLACE_SELECT_STYLE}
          >
            <option value="">
              {duplicateVideoSources === 0
                ? "No duplicate video"
                : driveVideoAssets.length === 0
                  ? "No Drive video"
                  : "Choose video"}
            </option>
            {driveVideoAssets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn ghost sm"
          type="button"
          disabled={duplicateVideoAssetId.length === 0 || duplicateVideoSources === 0}
          onClick={() => onReplaceDuplicateSources("video", duplicateVideoAssetId)}
        >
          Replace {String(duplicateVideoSources)} duplicate video source
          {duplicateVideoSources === 1 ? "" : "s"}
        </button>
        <label style={DECK_MEDIA_FILTER_LABEL_STYLE}>
          Duplicate audio source
          <select
            aria-label="Duplicate deck audio source"
            value={duplicateAudioAssetId}
            disabled={driveAudioAssets.length === 0 || duplicateAudioSources === 0}
            onChange={(event) => setDuplicateAudioAssetId(event.target.value)}
            style={DECK_MEDIA_REPLACE_SELECT_STYLE}
          >
            <option value="">
              {duplicateAudioSources === 0
                ? "No duplicate audio"
                : driveAudioAssets.length === 0
                  ? "No Drive audio"
                  : "Choose audio"}
            </option>
            {driveAudioAssets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn ghost sm"
          type="button"
          disabled={duplicateAudioAssetId.length === 0 || duplicateAudioSources === 0}
          onClick={() => onReplaceDuplicateSources("audio", duplicateAudioAssetId)}
        >
          Replace {String(duplicateAudioSources)} duplicate audio source
          {duplicateAudioSources === 1 ? "" : "s"}
        </button>
      </span>
      <table aria-label="Deck media assets" style={MEDIA_ASSET_TABLE_STYLE}>
        <thead>
          <tr>
            <th style={MEDIA_ASSET_HEADER_STYLE} scope="col">
              Slide
            </th>
            <th style={MEDIA_ASSET_HEADER_STYLE} scope="col">
              Asset
            </th>
            <th style={MEDIA_ASSET_HEADER_STYLE} scope="col">
              Playback
            </th>
            <th style={MEDIA_ASSET_HEADER_STYLE} scope="col">
              Issues
            </th>
            <th style={MEDIA_ASSET_HEADER_STYLE} scope="col">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {visibleAssets.length === 0 ? (
            <tr>
              <td style={MEDIA_ASSET_CELL_STYLE} colSpan={5}>
                No media assets match this filter.
              </td>
            </tr>
          ) : null}
          {visibleAssets.map(({ slide, slideNumber, shape, shapeIndex, issues }) => {
            const title = mediaAssetTitle(shape, shapeIndex);
            const shapeMediaType = shape.mediaType ?? "video";
            const duplicateReplacementAssets = driveMediaAssets.filter(
              (asset) =>
                driveEntryMediaType(asset) === shapeMediaType &&
                driveObjectContentUrl(asset.id) !== (shape.mediaUrl?.trim() ?? ""),
            );
            return (
              <tr
                key={`${slide.id}:${shape.id}`}
                aria-selected={slide.id === activeSlideId}
                style={slide.id === activeSlideId ? MEDIA_ASSET_ROW_SELECTED_STYLE : undefined}
              >
                <td style={MEDIA_ASSET_CELL_STYLE}>{slideNumber}</td>
                <td style={MEDIA_ASSET_CELL_STYLE}>
                  <button
                    className="btn ghost sm"
                    type="button"
                    aria-label={`Open slide ${String(slideNumber)} media asset ${title}`}
                    onClick={() => onOpenMediaAsset(slide.id, shape.id)}
                  >
                    {title}
                  </button>
                  <span style={MEDIA_ASSET_META_STYLE}>
                    {shape.mediaType === "audio" ? "Audio" : "Video"} · {mediaAssetSource(shape)}
                  </span>
                </td>
                <td style={MEDIA_ASSET_CELL_STYLE}>{mediaAssetPlayback(shape)}</td>
                <td style={MEDIA_ASSET_CELL_STYLE}>
                  {issues.length === 0 ? "Ready" : issues.join(", ")}
                </td>
                <td style={MEDIA_ASSET_CELL_STYLE}>
                  {shape.mediaType === "audio" ? (
                    <span style={MEDIA_ASSET_ACTIONS_STYLE}>
                      <span style={MEDIA_ASSET_META_STYLE}>Audio controls</span>
                      {issues.includes("Duplicate source") ? (
                        <select
                          aria-label={`Resolve duplicate deck media source ${title}`}
                          value=""
                          disabled={duplicateReplacementAssets.length === 0}
                          onChange={(event) =>
                            onReplaceMediaSource(slide, shape.id, event.target.value)
                          }
                          style={DECK_MEDIA_REPLACE_SELECT_STYLE}
                        >
                          <option value="">
                            {duplicateReplacementAssets.length === 0
                              ? "No alternate audio"
                              : "Choose unique audio"}
                          </option>
                          {duplicateReplacementAssets.map((asset) => (
                            <option key={asset.id} value={asset.id}>
                              {asset.name}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      <select
                        aria-label={`Replace deck media source ${title}`}
                        value={driveAssetSelectValue(shape.mediaUrl, driveMediaAssets)}
                        disabled={driveMediaAssets.length === 0}
                        onChange={(event) =>
                          onReplaceMediaSource(slide, shape.id, event.target.value)
                        }
                        style={DECK_MEDIA_REPLACE_SELECT_STYLE}
                      >
                        <option value="">
                          {driveMediaAssets.length === 0 ? "No Drive media" : "Replace source"}
                        </option>
                        {driveMediaAssets.map((asset) => (
                          <option key={asset.id} value={asset.id}>
                            {asset.name}
                          </option>
                        ))}
                      </select>
                    </span>
                  ) : (
                    <span style={MEDIA_ASSET_ACTIONS_STYLE}>
                      {issues.includes("Duplicate source") ? (
                        <select
                          aria-label={`Resolve duplicate deck media source ${title}`}
                          value=""
                          disabled={duplicateReplacementAssets.length === 0}
                          onChange={(event) =>
                            onReplaceMediaSource(slide, shape.id, event.target.value)
                          }
                          style={DECK_MEDIA_REPLACE_SELECT_STYLE}
                        >
                          <option value="">
                            {duplicateReplacementAssets.length === 0
                              ? "No alternate video"
                              : "Choose unique video"}
                          </option>
                          {duplicateReplacementAssets.map((asset) => (
                            <option key={asset.id} value={asset.id}>
                              {asset.name}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      <label style={MEDIA_ASSET_CHECKBOX_LABEL_STYLE}>
                        <input
                          aria-label={`Deck media ${title} autoplay`}
                          type="checkbox"
                          checked={shape.mediaAutoplay === true}
                          onChange={(event) =>
                            onUpdateMediaPlayback(slide, shape.id, {
                              mediaAutoplay: event.target.checked,
                            })
                          }
                        />
                        Autoplay
                      </label>
                      <label style={MEDIA_ASSET_CHECKBOX_LABEL_STYLE}>
                        <input
                          aria-label={`Deck media ${title} loop`}
                          type="checkbox"
                          checked={shape.mediaLoop === true}
                          onChange={(event) =>
                            onUpdateMediaPlayback(slide, shape.id, {
                              mediaLoop: event.target.checked,
                            })
                          }
                        />
                        Loop
                      </label>
                      <label style={MEDIA_ASSET_CHECKBOX_LABEL_STYLE}>
                        <input
                          aria-label={`Deck media ${title} muted`}
                          type="checkbox"
                          checked={shape.mediaMuted === true}
                          onChange={(event) =>
                            onUpdateMediaPlayback(slide, shape.id, {
                              mediaMuted: event.target.checked,
                            })
                          }
                        />
                        Muted
                      </label>
                      <select
                        aria-label={`Replace deck media source ${title}`}
                        value={driveAssetSelectValue(shape.mediaUrl, driveMediaAssets)}
                        disabled={driveMediaAssets.length === 0}
                        onChange={(event) =>
                          onReplaceMediaSource(slide, shape.id, event.target.value)
                        }
                        style={DECK_MEDIA_REPLACE_SELECT_STYLE}
                      >
                        <option value="">
                          {driveMediaAssets.length === 0 ? "No Drive media" : "Replace source"}
                        </option>
                        {driveMediaAssets.map((asset) => (
                          <option key={asset.id} value={asset.id}>
                            {asset.name}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label={`Replace deck media poster ${title}`}
                        value={driveAssetSelectValue(shape.mediaPosterUrl, driveImageAssets)}
                        disabled={driveImageAssets.length === 0}
                        onChange={(event) =>
                          onReplaceMediaPoster(slide, shape.id, event.target.value)
                        }
                        style={DECK_MEDIA_REPLACE_SELECT_STYLE}
                      >
                        <option value="">
                          {driveImageAssets.length === 0 ? "No Drive images" : "Replace poster"}
                        </option>
                        {driveImageAssets.map((asset) => (
                          <option key={asset.id} value={asset.id}>
                            {asset.name}
                          </option>
                        ))}
                      </select>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DeckAnimationTimelineTable({
  slides,
  activeSlideId,
  onSelectSlide,
}: {
  readonly slides: readonly SlidesApiSlide[];
  readonly activeSlideId: string | null;
  readonly onSelectSlide: (slideId: string) => void;
}) {
  const rows = deckShapeAnimationTimeline(slides);
  if (rows.length === 0) {
    return null;
  }

  return (
    <div style={DECK_MEDIA_ASSET_TABLE_WRAP_STYLE}>
      <span style={LABEL_STYLE}>Deck animation timeline</span>
      <table aria-label="Deck animation timeline" style={MEDIA_ASSET_TABLE_STYLE}>
        <thead>
          <tr>
            <th style={MEDIA_ASSET_HEADER_STYLE} scope="col">
              Slide
            </th>
            <th style={MEDIA_ASSET_HEADER_STYLE} scope="col">
              Build
            </th>
            <th style={MEDIA_ASSET_HEADER_STYLE} scope="col">
              Timing
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              aria-selected={row.slideId === activeSlideId}
              style={row.slideId === activeSlideId ? MEDIA_ASSET_ROW_SELECTED_STYLE : undefined}
            >
              <td style={MEDIA_ASSET_CELL_STYLE}>
                {`Slide ${String(row.slideNumber)}`}
                <span style={MEDIA_ASSET_META_STYLE}>{row.slideTitle}</span>
              </td>
              <td style={MEDIA_ASSET_CELL_STYLE}>
                <button
                  className="btn ghost sm"
                  type="button"
                  aria-label={`Open slide ${String(row.slideNumber)} animation ${shapeAnimationPhaseLabel(row.phase).toLowerCase()} ${row.shapeLabel}`}
                  onClick={() => onSelectSlide(row.slideId)}
                >
                  {row.shapeLabel}
                </button>
                <span style={MEDIA_ASSET_META_STYLE}>
                  {shapeAnimationPhaseLabel(row.phase)} · {shapeAnimationTypeLabel(row)}
                </span>
              </td>
              <td style={MEDIA_ASSET_CELL_STYLE}>
                {`Order ${String(row.order)}`}
                <span style={MEDIA_ASSET_META_STYLE}>
                  {`${String(row.durationMs)}ms / ${shapeAnimationEasingLabel(row.easing)}`}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface SlideDraft {
  readonly layout: SlideLayout;
  readonly title: string;
  readonly eyebrow: string;
  readonly subtitle: string;
  readonly items: string;
  readonly stats: string;
  readonly left: string;
  readonly rightKind: "list" | "quote";
  readonly rightContent: string;
  readonly quoteWho: string;
  readonly note: string;
  readonly bg: SlideBackground;
  readonly shapes: readonly SlideShape[];
  readonly transition?: SlideTransition;
  readonly speakerNotes: string;
}

interface SlideLayoutSuggestion {
  readonly layout: SlideLayout;
  readonly reason: string;
}

function suggestSlideLayout(draft: SlideDraft): SlideLayoutSuggestion {
  const itemLines = linesFromText(draft.items, []);
  const rightLines = linesFromText(draft.rightContent, []);
  const noteLines = linesFromText(draft.note, []);
  const hasMediaOrImageShape = draft.shapes.some(
    (shape) =>
      (shape.kind === "image" && (shape.imageUrl?.trim().length ?? 0) > 0) ||
      (shape.kind === "media" && (shape.mediaUrl?.trim().length ?? 0) > 0),
  );

  if (hasMediaOrImageShape || noteLines.length > 0) {
    return {
      layout: "image",
      reason: "Media or image notes are present, so a visual-forward slide fits best.",
    };
  }

  const statLines = [...itemLines, ...rightLines, ...linesFromText(draft.stats, [])];
  if (statLines.some((line) => parseStructuredMetricLine(line) !== null)) {
    return {
      layout: "stats",
      reason: "The content includes structured metric values that should be highlighted.",
    };
  }

  if (itemLines.length >= 4 || /\bagenda\b|\btopics?\b|\bplan\b/iu.test(draft.title)) {
    return {
      layout: "agenda",
      reason: "Several ordered points read like a discussion flow.",
    };
  }

  if (draft.left.trim().length > 0 || rightLines.length >= 2 || draft.quoteWho.trim().length > 0) {
    return {
      layout: "split",
      reason: "Two complementary blocks are available for a side-by-side layout.",
    };
  }

  if (draft.subtitle.trim().length > 0 && itemLines.length === 0) {
    return {
      layout: "title",
      reason: "The slide is mostly headline and supporting copy.",
    };
  }

  return {
    layout: "bullets",
    reason: "Concise bullets are the clearest fit for the available text.",
  };
}

function layoutSuggestedDraft(draft: SlideDraft, layout: SlideLayout): SlideDraft {
  const next = draftFromSlide(emptySlideContent(layout), draft.speakerNotes);
  const itemLines = linesFromText(draft.items, []);
  const rightLines = linesFromText(draft.rightContent, []);
  const noteText = firstNonEmpty(draft.note, draft.subtitle, draft.items, draft.left);
  return {
    ...next,
    title: draft.title.trim().length > 0 ? draft.title : next.title,
    shapes: draft.shapes,
    ...(layout === "agenda" || layout === "bullets"
      ? {
          items: [...itemLines, ...rightLines].join("\n") || next.items,
        }
      : {}),
    ...(layout === "stats"
      ? {
          subtitle: draft.subtitle,
          stats: statsSuggestionText([
            ...itemLines,
            ...rightLines,
            ...linesFromText(draft.stats, []),
          ]),
        }
      : {}),
    ...(layout === "split"
      ? {
          left: firstNonEmpty(draft.left, draft.subtitle, itemLines[0] ?? ""),
          rightKind: "list" as const,
          rightContent:
            rightLines.length > 0
              ? rightLines.join("\n")
              : itemLines.slice(1).join("\n") || next.rightContent,
        }
      : {}),
    ...(layout === "image"
      ? {
          note: noteText.trim().length > 0 ? noteText : next.note,
        }
      : {}),
    ...(layout === "title"
      ? {
          subtitle: firstNonEmpty(draft.subtitle, draft.items, draft.note),
          bg: draft.bg,
        }
      : {}),
  };
}

function rewriteSlideItems(draft: SlideDraft): string {
  const items = linesFromText(draft.items, []);
  const source = items.length > 0 ? items : [draft.title];
  const verbs =
    draft.layout === "agenda"
      ? ["Frame", "Explore", "Decide", "Align on", "Close with"]
      : ["Clarify", "Show", "Connect", "Quantify", "Close with"];
  return source
    .slice(0, 7)
    .map((item, index) =>
      rewriteSlideItem(item, verbs[index % verbs.length] ?? "Clarify", draft.title),
    )
    .join("\n");
}

function rewriteSlideItem(item: string, verb: string, title: string): string {
  const clean = item
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/u, "")
    .trim()
    .replace(/[.!?]+$/u, "");
  const subject = clean.length > 0 ? clean : title;
  if (subject.length < 28) {
    return `${verb} ${lowercaseFirst(subject)} for ${lowercaseFirst(title)}.`;
  }
  return `${uppercaseFirst(subject)}.`;
}

function draftSpeakerNotes(draft: SlideDraft): string {
  const title = draft.title.trim() || "this slide";
  switch (draft.layout) {
    case "title":
      return compactSentences([
        `Open by framing ${title}.`,
        draft.subtitle.trim().length > 0
          ? `Use the subtitle to set context: ${draft.subtitle}.`
          : "",
        "Pause before moving into the supporting details.",
      ]);
    case "agenda":
      return `Set up ${title}, then walk the audience through ${naturalList(
        linesFromText(draft.items, ["the discussion flow"]),
      )}. Close by confirming the decision path.`;
    case "bullets":
      return `Lead with ${title}. Emphasize ${naturalList(
        linesFromText(draft.items, ["the key points"]),
      )}, then close with the next step.`;
    case "stats":
      return `Anchor ${title} on the metrics: ${naturalList(
        linesFromText(draft.stats, ["the headline numbers"]),
      )}. Call out what changed and why it matters.`;
    case "split":
      return compactSentences([
        `Use ${title} to compare the two sides of the story.`,
        draft.left.trim().length > 0 ? `Start with ${draft.left}.` : "",
        draft.rightContent.trim().length > 0 ? `Then connect it to ${draft.rightContent}.` : "",
      ]);
    case "image":
      return compactSentences([
        `Use ${title} as a visual proof point.`,
        draft.note.trim().length > 0
          ? `Explain what the audience should notice: ${draft.note}.`
          : "",
        "Tie the visual back to the decision or takeaway.",
      ]);
  }
}

function firstNonEmpty(...values: readonly string[]): string {
  return values.find((value) => value.trim().length > 0)?.trim() ?? "";
}

function statsSuggestionText(lines: readonly string[]): string {
  const metrics = lines.map(parseStructuredMetricLine).filter((metric) => metric !== null);
  const source =
    metrics.length > 0 ? metrics : [{ value: "0", label: "Metric", note: "Suggested" }];
  return (
    source
      .slice(0, 4)
      .map((metric) => `${metric.value} | ${metric.label} | ${metric.note}`)
      .join("\n") || "0 | Metric | Suggested"
  );
}

function parseStructuredMetricLine(
  line: string,
): { readonly value: string; readonly label: string; readonly note: string } | null {
  const parts = line
    .split(/\s*[-:|]\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  const metricIndex = parts.findIndex(isMetricValue);
  if (metricIndex < 0) {
    return null;
  }
  const value = parts[metricIndex] ?? "0";
  if (metricIndex === 0) {
    return {
      value,
      label: parts[1] ?? "Metric",
      note: parts.slice(2).join(" | ") || "Suggested",
    };
  }
  return {
    value,
    label: parts.slice(0, metricIndex).join(" | ") || "Metric",
    note: parts.slice(metricIndex + 1).join(" | ") || "Suggested",
  };
}

function isMetricValue(value: string): boolean {
  return /^(?:[$]?\d+(?:\.\d+)?%?|[+-]?\d+(?:\.\d+)?x)$/u.test(value);
}

function slideLayoutLabel(layout: SlideLayout): string {
  return SLIDE_LAYOUT_OPTIONS.find((option) => option.value === layout)?.label ?? layout;
}

function compactSentences(values: readonly string[]): string {
  return values.filter((value) => value.trim().length > 0).join(" ");
}

function naturalList(values: readonly string[]): string {
  const clean = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, 4);
  if (clean.length === 0) {
    return "the main takeaway";
  }
  if (clean.length === 1) {
    return clean[0] ?? "the main takeaway";
  }
  return `${clean.slice(0, -1).join(", ")} and ${clean.at(-1) ?? ""}`;
}

function lowercaseFirst(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toLowerCase() ?? ""}${value.slice(1)}`;
}

function uppercaseFirst(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function draftFromSlide(content: SlideContent, speakerNotes: string): SlideDraft {
  const base = {
    layout: content.layout,
    title: content.title,
    eyebrow: "",
    subtitle: "",
    items: "",
    stats: "",
    left: "",
    rightKind: "list" as const,
    rightContent: "",
    quoteWho: "",
    note: "",
    bg: "accent" as const,
    shapes: slideShapes(content),
    transition: slideTransition(content),
    speakerNotes,
  };

  switch (content.layout) {
    case "title":
      return {
        ...base,
        eyebrow: content.eyebrow ?? "",
        subtitle: content.subtitle ?? "",
        bg: content.bg ?? "accent",
      };
    case "agenda":
    case "bullets":
      return {
        ...base,
        items: content.items.join("\n"),
      };
    case "stats":
      return {
        ...base,
        subtitle: content.subtitle ?? "",
        stats: content.stats
          .map((stat) => [stat.value, stat.label, stat.note].join(" | "))
          .join("\n"),
      };
    case "split":
      return {
        ...base,
        left: content.left,
        rightKind: content.rightKind,
        rightContent:
          typeof content.rightContent === "string"
            ? content.rightContent
            : content.rightContent.join("\n"),
        quoteWho: content.quoteWho ?? "",
      };
    case "image":
      return {
        ...base,
        note: content.note,
      };
  }
}

function contentWithEditableFields(content: SlideContent, draft: SlideDraft): SlideContent {
  const fallback = content.layout === draft.layout ? content : emptySlideContent(draft.layout);
  const nextTitle = draft.title.trim().length > 0 ? draft.title.trim() : fallback.title;

  switch (draft.layout) {
    case "title":
      return {
        layout: "title",
        title: nextTitle,
        ...optionalField("eyebrow", draft.eyebrow),
        ...optionalField("subtitle", draft.subtitle),
        bg: draft.bg,
        ...optionalShapes(draft.shapes),
        ...optionalTransition(draft.transition),
      };
    case "agenda":
      return {
        layout: "agenda",
        title: nextTitle,
        items: linesFromText(
          draft.items,
          fallback.layout === "agenda" ? fallback.items : ["First topic"],
        ),
        ...optionalShapes(draft.shapes),
        ...optionalTransition(draft.transition),
      };
    case "bullets":
      return {
        layout: "bullets",
        title: nextTitle,
        items: linesFromText(
          draft.items,
          fallback.layout === "bullets" ? fallback.items : ["First point"],
        ),
        ...optionalShapes(draft.shapes),
        ...optionalTransition(draft.transition),
      };
    case "stats":
      return {
        layout: "stats",
        title: nextTitle,
        ...optionalField("subtitle", draft.subtitle),
        stats: statsFromText(draft.stats, fallback.layout === "stats" ? fallback.stats : []),
        ...optionalShapes(draft.shapes),
        ...optionalTransition(draft.transition),
      };
    case "split":
      return {
        layout: "split",
        title: nextTitle,
        left:
          draft.left.trim().length > 0
            ? draft.left.trim()
            : fallback.layout === "split"
              ? fallback.left
              : "Left column copy.",
        rightKind: draft.rightKind,
        rightContent:
          draft.rightKind === "list"
            ? linesFromText(
                draft.rightContent,
                fallback.layout === "split" && Array.isArray(fallback.rightContent)
                  ? fallback.rightContent
                  : ["First point"],
              )
            : draft.rightContent.trim().length > 0
              ? draft.rightContent.trim()
              : fallback.layout === "split" && typeof fallback.rightContent === "string"
                ? fallback.rightContent
                : "Quote",
        ...optionalField("quoteWho", draft.quoteWho),
        ...optionalShapes(draft.shapes),
        ...optionalTransition(draft.transition),
      };
    case "image":
      return {
        layout: "image",
        title: nextTitle,
        note:
          draft.note.trim().length > 0
            ? draft.note.trim()
            : fallback.layout === "image"
              ? fallback.note
              : "Describe the image",
        ...optionalShapes(draft.shapes),
        ...optionalTransition(draft.transition),
      };
  }
}

function slideContentWithUpdatedShape(
  content: SlideContent,
  shapeId: string,
  updateShape: (shape: SlideShape) => SlideShape,
): SlideContent {
  const shapes = slideShapes(content).map((shape) =>
    shape.id === shapeId ? updateShape(shape) : shape,
  );
  return slideContentWithShapes(content, shapes);
}

function slideContentWithUpdatedMediaShapes(
  content: SlideContent,
  updateShape: (shape: SlideShape) => SlideShape,
): SlideContent | null {
  let changed = false;
  const shapes = slideShapes(content).map((shape) => {
    const nextShape = updateShape(shape);
    if (nextShape !== shape) {
      changed = true;
    }
    return nextShape;
  });

  return changed ? slideContentWithShapes(content, shapes) : null;
}

function slideContentWithShapes(
  content: SlideContent,
  shapes: readonly SlideShape[],
): SlideContent {
  switch (content.layout) {
    case "title":
      return { ...content, shapes };
    case "agenda":
      return { ...content, shapes };
    case "bullets":
      return { ...content, shapes };
    case "stats":
      return { ...content, shapes };
    case "split":
      return { ...content, shapes };
    case "image":
      return { ...content, shapes };
  }
}

function shapeWithoutMediaTrim(shape: SlideShape): SlideShape {
  const next: { -readonly [Key in keyof SlideShape]: SlideShape[Key] } = { ...shape };
  delete next.mediaStartSeconds;
  delete next.mediaEndSeconds;
  return next;
}

function linesFromText(text: string, fallback: readonly string[]): readonly string[] {
  const lines = text
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return lines.length > 0 ? lines : fallback;
}

function statsFromText(
  text: string,
  fallback: readonly { readonly value: string; readonly label: string; readonly note: string }[],
) {
  const stats = text
    .split("\n")
    .map((line) => line.split("|").map((part) => part.trim()))
    .map(([value, label, note]) => ({
      value: value?.length ? value : "0",
      label: label?.length ? label : "Metric",
      note: note ?? "",
    }))
    .filter((stat) => stat.value.length > 0 || stat.label.length > 0);
  return stats.length > 0
    ? stats
    : fallback.length > 0
      ? fallback
      : [{ value: "0", label: "Metric", note: "" }];
}

function optionalField<Key extends "eyebrow" | "subtitle" | "quoteWho">(
  key: Key,
  value: string,
): Partial<Record<Key, string>> {
  const trimmed = value.trim();
  return trimmed.length > 0 ? ({ [key]: trimmed } as Record<Key, string>) : {};
}

function optionalShapes(shapes: readonly SlideShape[]): {
  readonly shapes?: readonly SlideShape[];
} {
  return shapes.length > 0 ? { shapes } : {};
}

function optionalTransition(transition: SlideTransition | undefined): {
  readonly transition?: SlideTransition;
} {
  return transition === undefined ? {} : { transition };
}

function slideShapes(content: SlideContent): readonly SlideShape[] {
  return (content.shapes ?? []).map(normalizeSlideShape);
}

function slideTransition(content: SlideContent): SlideTransition | undefined {
  return content.transition === undefined
    ? undefined
    : normalizeSlideTransition(content.transition);
}

function slideAnimatedShapeCount(slide: SlidesApiSlide): number {
  return slideShapeBuildEntries(slideShapes(slide.content)).length;
}

function shapesForBuildStep(
  shapes: readonly SlideShape[],
  buildStep: number,
): readonly { readonly shape: SlideShape; readonly exiting: boolean }[] {
  const entries = slideShapeBuildEntries(shapes);
  const activeEntries = entries.slice(0, Math.max(0, buildStep));
  const visibleEntranceIds = new Set(
    activeEntries.filter((entry) => entry.kind === "entrance").map((entry) => entry.id),
  );
  const exitingIds = new Set(
    activeEntries.filter((entry) => entry.kind === "exit").map((entry) => entry.id),
  );
  return shapes
    .filter((shape) => shape.animation === undefined || visibleEntranceIds.has(shape.id))
    .map((shape) => ({ shape, exiting: exitingIds.has(shape.id) }));
}

function slideShapeBuildEntries(shapes: readonly SlideShape[]): readonly {
  readonly id: string;
  readonly kind: "entrance" | "exit";
  readonly order: number;
  readonly index: number;
}[] {
  const entrances = shapes
    .filter((shape) => shape.animation !== undefined)
    .map((shape, index) => ({
      id: shape.id,
      kind: "entrance" as const,
      order: normalizeSlideShapeAnimation(shape.animation ?? {}).order ?? index,
      index,
    }))
    .sort(compareShapeBuildEntries);
  const exits = shapes
    .filter((shape) => shape.exitAnimation !== undefined)
    .map((shape, index) => ({
      id: shape.id,
      kind: "exit" as const,
      order: normalizeSlideShapeAnimation(shape.exitAnimation ?? {}).order ?? index,
      index,
    }))
    .sort(compareShapeBuildEntries);
  return [...entrances, ...exits];
}

function slideShapeAnimationTimeline(
  shapes: readonly SlideShape[],
): readonly ShapeAnimationTimelineRow[] {
  return shapes
    .flatMap((shape, index) => {
      const label = shapeLabel(shape, index);
      const rows: ShapeAnimationTimelineRow[] = [];
      if (shape.animation !== undefined) {
        rows.push(
          shapeAnimationTimelineRow(
            shape,
            label,
            "entrance",
            normalizeSlideShapeAnimation(shape.animation),
            index,
          ),
        );
      }
      if (shape.exitAnimation !== undefined) {
        rows.push(
          shapeAnimationTimelineRow(
            shape,
            label,
            "exit",
            normalizeSlideShapeAnimation(shape.exitAnimation),
            index,
          ),
        );
      }
      return rows;
    })
    .sort(compareShapeAnimationTimelineRows);
}

function deckShapeAnimationTimeline(
  slides: readonly SlidesApiSlide[],
): readonly DeckShapeAnimationTimelineRow[] {
  return slides.flatMap((slide, slideIndex) =>
    slideShapeAnimationTimeline(slideShapes(slide.content)).map((row) => ({
      ...row,
      key: `${slide.id}:${row.key}`,
      slideId: slide.id,
      slideNumber: slideIndex + 1,
      slideTitle: slideTitle(slide.content),
    })),
  );
}

function shapeAnimationTimelineRow(
  shape: SlideShape,
  label: string,
  phase: "entrance" | "exit",
  animation: SlideShapeAnimation,
  shapeIndex: number,
): ShapeAnimationTimelineRow {
  return {
    key: `${shape.id}:${phase}`,
    shapeId: shape.id,
    shapeLabel: label,
    phase,
    type: animation.type,
    ...(animation.motionPath === undefined ? {} : { motionPath: animation.motionPath }),
    order: animation.order ?? shapeIndex,
    durationMs: animation.durationMs ?? 620,
    easing: animation.easing ?? "standard",
    shapeIndex,
  };
}

function compareShapeAnimationTimelineRows(
  left: ShapeAnimationTimelineRow,
  right: ShapeAnimationTimelineRow,
): number {
  if (left.phase !== right.phase) {
    return left.phase === "entrance" ? -1 : 1;
  }
  if (left.order !== right.order) {
    return left.order - right.order;
  }
  return left.shapeIndex - right.shapeIndex;
}

function compareShapeBuildEntries(
  left: { readonly order: number; readonly index: number },
  right: { readonly order: number; readonly index: number },
): number {
  return left.order === right.order ? left.index - right.index : left.order - right.order;
}

function createSlideShape(shapes: readonly SlideShape[], kind: SlideShapeKind): SlideShape {
  const nextNumber =
    shapes.reduce((highest, shape) => {
      const match = /^shape-(\d+)$/u.exec(shape.id);
      return match?.[1] === undefined ? highest : Math.max(highest, Number(match[1]));
    }, 0) + 1;
  return normalizeSlideShape({
    id: `shape-${String(nextNumber)}`,
    kind,
    x: kind === "text" ? 14 : kind === "connector" ? 36 : kind === "image" ? 52 : 46,
    y: kind === "text" ? 18 : kind === "connector" ? 38 : kind === "image" ? 16 : 42,
    width: kind === "text" ? 34 : kind === "connector" ? 28 : kind === "image" ? 32 : 34,
    height: kind === "text" ? 14 : kind === "connector" ? 18 : kind === "image" ? 24 : 20,
    text: kind === "text" ? "Text box" : "",
    tone: kind === "text" ? "light" : kind === "connector" ? "dark" : "accent",
    ...(kind === "connector" ? { connectorDirection: "up", connectorArrow: "end" } : {}),
    ...(kind === "image"
      ? {
          imageUrl:
            "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 360'%3E%3Crect width='640' height='360' fill='%23e2e8f0'/%3E%3Cpath d='M80 290 250 130l110 100 80-70 120 130H80z' fill='%2394a3b8'/%3E%3Ccircle cx='490' cy='95' r='42' fill='%23f8fafc'/%3E%3C/svg%3E",
          imageAlt: "Slide image",
        }
      : {}),
    ...(kind === "media"
      ? {
          mediaUrl: "",
          mediaType: "video" as const,
          mediaTitle: "Embedded media",
        }
      : {}),
  });
}

function normalizeSlideShape(shape: SlideShape): SlideShape {
  const width = clampShapeNumber(shape.width, 6, 100);
  const height = clampShapeNumber(shape.height, 6, 100);
  const kind =
    shape.kind === "rectangle" ||
    shape.kind === "connector" ||
    shape.kind === "image" ||
    shape.kind === "media"
      ? shape.kind
      : "text";
  return {
    id: shape.id,
    kind,
    x: clampShapeNumber(shape.x, 0, 100 - width),
    y: clampShapeNumber(shape.y, 0, 100 - height),
    width,
    height,
    ...(shape.text === undefined ? {} : { text: shape.text }),
    tone: shape.tone === "light" || shape.tone === "dark" ? shape.tone : "accent",
    ...(kind === "connector"
      ? {
          connectorDirection: shape.connectorDirection === "down" ? "down" : "up",
          connectorArrow: normalizeConnectorArrow(shape.connectorArrow),
        }
      : {}),
    ...(kind === "image"
      ? {
          ...(shape.imageUrl === undefined ? {} : { imageUrl: shape.imageUrl }),
          ...(shape.imageAlt === undefined ? {} : { imageAlt: shape.imageAlt }),
          ...(shape.imageFit === "contain" || shape.imageFit === "cover"
            ? { imageFit: shape.imageFit }
            : {}),
          ...(shape.imageMask === "rectangle" ||
          shape.imageMask === "rounded" ||
          shape.imageMask === "circle"
            ? { imageMask: shape.imageMask }
            : {}),
        }
      : {}),
    ...(kind === "media"
      ? {
          mediaType: shape.mediaType === "audio" ? "audio" : "video",
          ...(shape.mediaUrl === undefined ? {} : { mediaUrl: shape.mediaUrl }),
          ...(shape.mediaTitle === undefined ? {} : { mediaTitle: shape.mediaTitle }),
          ...(shape.mediaCaptionUrl === undefined
            ? {}
            : { mediaCaptionUrl: shape.mediaCaptionUrl }),
          ...(shape.mediaCaptionLabel === undefined
            ? {}
            : { mediaCaptionLabel: shape.mediaCaptionLabel }),
          ...(shape.mediaType === "audio"
            ? {}
            : {
                ...(shape.mediaPosterUrl === undefined
                  ? {}
                  : { mediaPosterUrl: shape.mediaPosterUrl }),
                ...normalizedMediaTrim(shape),
                ...(shape.mediaAutoplay === true ? { mediaAutoplay: true } : {}),
                ...(shape.mediaLoop === true ? { mediaLoop: true } : {}),
                ...(shape.mediaMuted === true ? { mediaMuted: true } : {}),
              }),
        }
      : {}),
    ...(shape.animation === undefined
      ? {}
      : { animation: normalizeSlideShapeAnimation(shape.animation) }),
    ...(shape.exitAnimation === undefined
      ? {}
      : { exitAnimation: normalizeSlideShapeAnimation(shape.exitAnimation) }),
  };
}

function animationFromSelection(
  value: string,
  current: SlideShapeAnimation | undefined,
  selectedShapeIndex: number,
): SlideShapeAnimation | undefined {
  if (value === "none") {
    return undefined;
  }
  return normalizeSlideShapeAnimation({
    type: value as SlideShapeAnimationType,
    motionPath: current?.motionPath,
    order: current?.order ?? Math.max(selectedShapeIndex, 0),
    durationMs: current?.durationMs,
    easing: current?.easing,
  });
}

function transitionFromSelection(
  value: string,
  current: SlideTransition | undefined,
): SlideTransition | undefined {
  if (value === "none") {
    return undefined;
  }
  const type = value === "slide" || value === "zoom" || value === "fade" ? value : "fade";
  return normalizeSlideTransition({
    type,
    durationMs: current?.durationMs ?? 420,
    ...(type === "slide" ? { direction: normalizeTransitionDirection(current?.direction) } : {}),
  });
}

function normalizeSlideTransition(transition: Partial<SlideTransition>): SlideTransition {
  const type =
    transition.type === "slide" || transition.type === "zoom" || transition.type === "fade"
      ? transition.type
      : "fade";
  return {
    type,
    ...(type === "slide" ? { direction: normalizeTransitionDirection(transition.direction) } : {}),
    ...(transition.durationMs === undefined
      ? {}
      : { durationMs: clampShapeNumber(transition.durationMs, 120, 3_000) }),
  };
}

function normalizeSlideShapeAnimation(
  animation: Partial<SlideShapeAnimation>,
): SlideShapeAnimation {
  const type =
    animation.type === "fly" || animation.type === "zoom" || animation.type === "fade"
      ? animation.type
      : "fade";
  return {
    type,
    ...(type === "fly" ? { motionPath: normalizeMotionPath(animation.motionPath) } : {}),
    order: clampShapeNumber(animation.order ?? 0, 0, 199),
    ...(animation.durationMs === undefined
      ? {}
      : { durationMs: clampShapeNumber(animation.durationMs, 120, 5_000) }),
    ...(animation.easing === undefined
      ? {}
      : { easing: normalizeAnimationEasing(animation.easing) }),
  };
}

function normalizeMotionPath(path: SlideShapeMotionPath | undefined): SlideShapeMotionPath {
  return path === "up" || path === "down" || path === "right" ? path : "left";
}

function normalizeTransitionDirection(
  direction: SlideTransitionDirection | undefined,
): SlideTransitionDirection {
  return direction === "left" || direction === "up" || direction === "down" ? direction : "right";
}

function normalizeAnimationEasing(
  easing: SlideShapeAnimationEasing | undefined,
): SlideShapeAnimationEasing {
  return easing === "linear" ||
    easing === "easeIn" ||
    easing === "easeOut" ||
    easing === "easeInOut"
    ? easing
    : "standard";
}

function clampShapeNumber(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(Math.max(Math.round(value), minimum), maximum);
}

function imageAltFromFilename(filename: string): string {
  const name = labelFromFilename(filename);
  return name.length > 0 ? name : "Slide image";
}

function mediaTitleFromFilename(filename: string): string {
  const name = labelFromFilename(filename);
  return name.length > 0 ? name : "Embedded media";
}

function labelFromFilename(filename: string): string {
  const name = filename
    .trim()
    .replace(/\.[^.]+$/u, "")
    .replace(/[-_]+/gu, " ")
    .trim();
  return name;
}

function mediaTypeFromFile(file: File, fallback: SlideMediaType): SlideMediaType {
  if (file.type.startsWith("audio/")) {
    return "audio";
  }
  if (file.type.startsWith("video/")) {
    return "video";
  }
  return fallback;
}

function driveObjectContentUrl(objectId: string): string {
  return `/api/drive/objects/${encodeURIComponent(objectId)}/content`;
}

function driveAssetSelectValue(url: string | undefined, assets: readonly DriveApiEntry[]): string {
  if (url === undefined) {
    return "";
  }
  return assets.find((asset) => driveObjectContentUrl(asset.id) === url)?.id ?? "";
}

function isDriveImageAsset(entry: DriveApiEntry): boolean {
  const mimeType = entry.mimeType ?? "";
  return mimeType.startsWith("image/") || /\.(avif|gif|jpe?g|png|svg|webp)$/iu.test(entry.name);
}

function driveEntryMediaType(entry: DriveApiEntry): SlideMediaType | null {
  const mimeType = entry.mimeType ?? "";
  const name = entry.name.toLowerCase();
  if (mimeType.startsWith("audio/") || /\.(aac|flac|m4a|mp3|oga|ogg|opus|wav|weba)$/iu.test(name)) {
    return "audio";
  }
  if (mimeType.startsWith("video/") || /\.(m4v|mov|mp4|mpeg|ogv|webm)$/iu.test(name)) {
    return "video";
  }
  return null;
}

function downloadSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return slug.length > 0 ? slug : "deck";
}

function shapeLabel(shape: SlideShape, index: number): string {
  const text = shapeLabelText(shape);
  if (text !== undefined && text.length > 0) {
    return text;
  }
  return `${shapeKindLabel(shape.kind, false)} ${String(index + 1)}`;
}

function shapeLabelText(shape: SlideShape): string {
  if (shape.kind === "image") {
    return shape.imageAlt?.trim() || shape.text?.trim() || "";
  }
  if (shape.kind === "media") {
    return shape.mediaTitle?.trim() || shape.text?.trim() || "";
  }
  return shape.text?.trim() ?? "";
}

function shapeKindLabel(kind: SlideShapeKind, aria: boolean): string {
  if (kind === "text") {
    return aria ? "Text box" : "Text";
  }
  if (kind === "connector") {
    return "Connector";
  }
  if (kind === "image") {
    return "Image";
  }
  if (kind === "media") {
    return "Media";
  }
  return "Rectangle";
}

function mediaAssetTitle(shape: SlideShape, index: number): string {
  return shape.mediaTitle?.trim() || shape.text?.trim() || `Media ${String(index + 1)}`;
}

function deckMediaAssetRows(slides: readonly SlidesApiSlide[]): readonly DeckMediaAssetRow[] {
  const rows = slides.flatMap((slide, slideIndex) =>
    slideShapes(slide.content)
      .filter((shape) => shape.kind === "media")
      .map((shape, shapeIndex) => ({
        slide,
        slideNumber: slideIndex + 1,
        shape,
        shapeIndex,
        issues: [] as readonly string[],
      })),
  );
  const sourceCounts = new Map<string, number>();
  for (const row of rows) {
    const source = duplicateMediaSourceKey(row.shape);
    if (source !== null) {
      sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    }
  }
  return rows.map((row) => {
    const source = duplicateMediaSourceKey(row.shape);
    return {
      ...row,
      issues: mediaAssetIssues(row.shape, source !== null && (sourceCounts.get(source) ?? 0) > 1),
    };
  });
}

function mediaAssetIssues(shape: SlideShape, duplicateSource = false): readonly string[] {
  const issues: string[] = [];
  const source = mediaAssetSource(shape);
  if (source === "Missing") {
    issues.push("Missing source");
  } else if (source === "URL") {
    issues.push("External source");
  }
  if ((shape.mediaType ?? "video") === "video") {
    if ((shape.mediaPosterUrl?.trim() ?? "").length === 0) {
      issues.push("Missing poster");
    }
    if (shape.mediaAutoplay === true && shape.mediaMuted !== true) {
      issues.push("Autoplay should be muted");
    }
  }
  if (duplicateSource) {
    issues.push("Duplicate source");
  }
  return issues;
}

function mediaAssetReadiness(rows: readonly DeckMediaAssetRow[]): DeckMediaReadiness {
  return rows.reduce<DeckMediaReadiness>(
    (readiness, row) => ({
      total: readiness.total + 1,
      ready: readiness.ready + (row.issues.length === 0 ? 1 : 0),
      needsAttention: readiness.needsAttention + (row.issues.length > 0 ? 1 : 0),
      external: readiness.external + (row.issues.includes("External source") ? 1 : 0),
      missingPoster: readiness.missingPoster + (row.issues.includes("Missing poster") ? 1 : 0),
      duplicates: readiness.duplicates + (row.issues.includes("Duplicate source") ? 1 : 0),
      exportBlockers:
        readiness.exportBlockers +
        (row.issues.some((issue) => MEDIA_EXPORT_BLOCKING_ISSUES.has(issue)) ? 1 : 0),
      exportWarnings:
        readiness.exportWarnings +
        (row.issues.some((issue) => MEDIA_EXPORT_WARNING_ISSUES.has(issue)) ? 1 : 0),
    }),
    {
      total: 0,
      ready: 0,
      needsAttention: 0,
      external: 0,
      missingPoster: 0,
      duplicates: 0,
      exportBlockers: 0,
      exportWarnings: 0,
    },
  );
}

function deckExportBlockedTitle(readiness: DeckMediaReadiness): string {
  return `Resolve ${String(readiness.exportBlockers)} media export blocker${
    readiness.exportBlockers === 1 ? "" : "s"
  } before export.`;
}

function mediaBlockingSourceCount(
  rows: readonly DeckMediaAssetRow[],
  mediaType: SlideMediaType,
): number {
  return rows.filter(
    (row) =>
      (row.shape.mediaType ?? "video") === mediaType &&
      row.issues.some((issue) => MEDIA_EXPORT_BLOCKING_ISSUES.has(issue)),
  ).length;
}

function mediaDuplicateReplacementRows(
  rows: readonly DeckMediaAssetRow[],
  mediaType: SlideMediaType,
): readonly DeckMediaAssetRow[] {
  const seenSources = new Set<string>();
  const replacementRows: DeckMediaAssetRow[] = [];
  for (const row of rows) {
    if ((row.shape.mediaType ?? "video") !== mediaType) {
      continue;
    }
    const source = duplicateMediaSourceKey(row.shape);
    if (source === null || !row.issues.includes("Duplicate source")) {
      continue;
    }
    if (seenSources.has(source)) {
      replacementRows.push(row);
      continue;
    }
    seenSources.add(source);
  }
  return replacementRows;
}

function matchesDeckMediaFilter(row: DeckMediaAssetRow, filter: DeckMediaFilter): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "video" || filter === "audio") {
    return (row.shape.mediaType ?? "video") === filter;
  }
  if (filter === "needs-attention") {
    return row.issues.length > 0;
  }
  if (filter === "external") {
    return row.issues.includes("External source");
  }
  if (filter === "duplicate") {
    return row.issues.includes("Duplicate source");
  }
  return row.issues.includes("Missing poster");
}

const MEDIA_EXPORT_BLOCKING_ISSUES = new Set(["Missing source", "External source"]);
const MEDIA_EXPORT_WARNING_ISSUES = new Set([
  "Missing poster",
  "Autoplay should be muted",
  "Duplicate source",
]);

function duplicateMediaSourceKey(shape: SlideShape): string | null {
  const url = shape.mediaUrl?.trim();
  return url === undefined || url.length === 0 ? null : url;
}

function mediaAssetSource(shape: SlideShape): string {
  const url = shape.mediaUrl?.trim() ?? "";
  if (url.length === 0) {
    return "Missing";
  }
  if (url.startsWith("/api/drive/objects/")) {
    return "Drive";
  }
  return "URL";
}

function mediaAssetPlayback(shape: SlideShape): string {
  if ((shape.mediaType ?? "video") === "audio") {
    return "Controls";
  }
  const playback = [
    mediaAssetTrimLabel(shape),
    shape.mediaAutoplay === true ? "Autoplay" : "",
    shape.mediaLoop === true ? "Loop" : "",
    shape.mediaMuted === true ? "Muted" : "",
    (shape.mediaCaptionUrl?.trim() ?? "").length > 0 ? "Captions" : "",
  ].filter((value) => value.length > 0);
  return playback.length === 0 ? "Controls" : playback.join(", ");
}

function shapeAnimationPhaseLabel(phase: "entrance" | "exit"): string {
  return phase === "entrance" ? "Entrance" : "Exit";
}

function shapeAnimationTypeLabel(
  row: Pick<ShapeAnimationTimelineRow, "type" | "motionPath">,
): string {
  if (row.type === "fly") {
    return `Fly ${row.motionPath ?? "left"}`;
  }
  return row.type === "zoom" ? "Zoom" : "Fade";
}

function shapeAnimationEasingLabel(easing: SlideShapeAnimationEasing): string {
  switch (easing) {
    case "linear":
      return "Linear";
    case "easeIn":
      return "Ease in";
    case "easeOut":
      return "Ease out";
    case "easeInOut":
      return "Ease in/out";
    case "standard":
      return "Standard";
  }
}

function mediaAssetTrimLabel(shape: SlideShape): string {
  const trim = normalizedMediaTrim(shape);
  if (trim.mediaStartSeconds === undefined && trim.mediaEndSeconds === undefined) {
    return "";
  }
  const start = trim.mediaStartSeconds ?? 0;
  return trim.mediaEndSeconds === undefined
    ? `${String(start)}s+`
    : `${String(start)}-${String(trim.mediaEndSeconds)}s`;
}

function connectorLineProps(shape: SlideShape): {
  readonly x1: string;
  readonly y1: string;
  readonly x2: string;
  readonly y2: string;
  readonly arrow: SlideConnectorArrow;
} {
  const direction = shape.connectorDirection ?? "up";
  return {
    x1: "4",
    y1: direction === "down" ? "8" : "92",
    x2: "96",
    y2: direction === "down" ? "92" : "8",
    arrow: normalizeConnectorArrow(shape.connectorArrow),
  };
}

function normalizeConnectorArrow(arrow: SlideConnectorArrow | undefined): SlideConnectorArrow {
  return arrow === "none" || arrow === "start" || arrow === "both" ? arrow : "end";
}

function nextShapeFromDrag(drag: ShapeDragState, point: ShapeDragPoint): SlideShape {
  if (drag.mode === "move") {
    return normalizeSlideShape({
      ...drag.startShape,
      x: drag.startShape.x + point.deltaX,
      y: drag.startShape.y + point.deltaY,
    });
  }

  if (drag.mode === "resize") {
    return normalizeSlideShape({
      ...drag.startShape,
      width: drag.startShape.width + point.deltaX,
      height: drag.startShape.height + point.deltaY,
    });
  }

  return shapeFromConnectorEndpoint(
    drag.startShape,
    drag.mode === "connector-left" ? "left" : "right",
    point,
  );
}

function connectorEndpoints(shape: SlideShape): {
  readonly left: { readonly x: number; readonly y: number };
  readonly right: { readonly x: number; readonly y: number };
} {
  const direction = shape.connectorDirection ?? "up";
  return {
    left: {
      x: shape.x,
      y: direction === "down" ? shape.y : shape.y + shape.height,
    },
    right: {
      x: shape.x + shape.width,
      y: direction === "down" ? shape.y + shape.height : shape.y,
    },
  };
}

function shapeFromConnectorEndpoint(
  shape: SlideShape,
  endpoint: "left" | "right",
  point: Pick<ShapeDragPoint, "x" | "y">,
): SlideShape {
  const endpoints = connectorEndpoints(shape);
  const nextLeft = endpoint === "left" ? { x: point.x, y: point.y } : endpoints.left;
  const nextRight = endpoint === "right" ? { x: point.x, y: point.y } : endpoints.right;
  const left = nextLeft.x <= nextRight.x ? nextLeft : nextRight;
  const right = nextLeft.x <= nextRight.x ? nextRight : nextLeft;
  const width = Math.max(Math.abs(right.x - left.x), 6);
  const height = Math.max(Math.abs(right.y - left.y), 6);
  return normalizeSlideShape({
    ...shape,
    x: Math.min(left.x, 100 - width),
    y: Math.min(left.y, right.y),
    width,
    height,
    connectorDirection: left.y <= right.y ? "down" : "up",
  });
}

function themeFromMetadata(metadata: Record<string, unknown> | undefined): SlideTheme {
  const theme = metadata?.theme;
  return theme === "midnight" || theme === "meadow" ? theme : "classic";
}

function metadataWithTheme(
  metadata: Record<string, unknown>,
  theme: SlideTheme,
): Record<string, unknown> {
  return { ...metadata, theme };
}

function slideBackgroundStyle(content: SlideContent, theme: SlideTheme): CSSProperties {
  if (content.layout === "title" && content.bg === "neutral") {
    return slideThemeNeutralStyle(theme);
  }
  return slideThemeAccentStyle(theme);
}

function slideThemeAccentStyle(theme: SlideTheme): CSSProperties {
  if (theme === "midnight") {
    return { background: "linear-gradient(135deg, #09090f, #312e81)", color: "#f8fafc" };
  }
  if (theme === "meadow") {
    return { background: "linear-gradient(135deg, #064e3b, #65a30d)", color: "#f7fee7" };
  }
  return { background: "linear-gradient(135deg, #101827, #2f3f63)", color: "#fff" };
}

function slideThemeNeutralStyle(theme: SlideTheme): CSSProperties {
  if (theme === "midnight") {
    return { background: "linear-gradient(135deg, #111827, #334155)", color: "#f8fafc" };
  }
  if (theme === "meadow") {
    return { background: "linear-gradient(135deg, #f0fdf4, #ccfbf1)", color: "#14312b" };
  }
  return { background: "linear-gradient(135deg, #f8fafc, #e2e8f0)", color: "#172033" };
}

function shapeBoundsStyle(shape: SlideShape): CSSProperties {
  return {
    left: `${String(shape.x)}%`,
    top: `${String(shape.y)}%`,
    width: `${String(shape.width)}%`,
    height: `${String(shape.height)}%`,
  };
}

function slideTransitionStyle(content: SlideContent, animate: boolean): CSSProperties {
  if (!animate || content.transition === undefined) {
    return {};
  }
  const transition = normalizeSlideTransition(content.transition);
  return {
    animationName: slideTransitionName(transition),
    animationDuration: `${String(transition.durationMs ?? 420)}ms`,
    animationTimingFunction: "cubic-bezier(.22,1,.36,1)",
    animationFillMode: "both",
  };
}

function shapeAnimationStyle(shape: SlideShape, animate: boolean, exiting: boolean): CSSProperties {
  const animationSource = exiting ? shape.exitAnimation : shape.animation;
  if (!animate || animationSource === undefined) {
    return {};
  }
  const animation = normalizeSlideShapeAnimation(animationSource);
  return {
    animationName: exiting ? shapeExitAnimationName(animation) : shapeAnimationName(animation),
    animationDuration: `${String(animation.durationMs ?? 620)}ms`,
    animationDelay: exiting ? "0ms" : `${String((animation.order ?? 0) * 140)}ms`,
    animationTimingFunction: shapeAnimationTimingFunction(animation.easing),
    animationFillMode: "both",
    ...(exiting ? { pointerEvents: "none" as const } : {}),
  };
}

function shapeAnimationTimingFunction(easing: SlideShapeAnimationEasing | undefined): string {
  const normalized = normalizeAnimationEasing(easing);
  if (normalized === "linear") {
    return "linear";
  }
  if (normalized === "easeIn") {
    return "cubic-bezier(.42,0,1,1)";
  }
  if (normalized === "easeOut") {
    return "ease-out";
  }
  if (normalized === "easeInOut") {
    return "ease-in-out";
  }
  return "cubic-bezier(.22,.61,.36,1)";
}

function shapeAnimationName(animation: SlideShapeAnimation): string {
  if (animation.type === "zoom") {
    return "helix-slide-shape-zoom";
  }
  if (animation.type === "fly") {
    return `helix-slide-shape-fly-${animation.motionPath ?? "left"}`;
  }
  return "helix-slide-shape-fade";
}

function shapeExitAnimationName(animation: SlideShapeAnimation): string {
  if (animation.type === "zoom") {
    return "helix-slide-shape-exit-zoom";
  }
  if (animation.type === "fly") {
    return `helix-slide-shape-exit-fly-${animation.motionPath ?? "left"}`;
  }
  return "helix-slide-shape-exit-fade";
}

function slideTransitionName(transition: SlideTransition): string {
  if (transition.type === "zoom") {
    return "helix-slide-transition-zoom";
  }
  if (transition.type === "slide") {
    return `helix-slide-transition-${transition.direction ?? "right"}`;
  }
  return "helix-slide-transition-fade";
}

function shapeToneStyle(shape: SlideShape): CSSProperties {
  const tone = shape.tone ?? "accent";
  if (shape.kind === "image" || shape.kind === "media") {
    return {
      background: "rgba(15,23,42,.16)",
      borderColor:
        tone === "light"
          ? "rgba(255,255,255,.82)"
          : tone === "dark"
            ? "rgba(15,23,42,.86)"
            : "rgba(147,197,253,.92)",
      color: tone === "dark" ? "#f8fafc" : "#111827",
    };
  }
  if (shape.kind === "connector") {
    if (tone === "light") {
      return {
        background: "transparent",
        borderColor: "transparent",
        color: "rgba(255,255,255,.94)",
      };
    }
    if (tone === "dark") {
      return {
        background: "transparent",
        borderColor: "transparent",
        color: "rgba(15,23,42,.92)",
      };
    }
    return {
      background: "transparent",
      borderColor: "transparent",
      color: "#60a5fa",
    };
  }
  if (tone === "light") {
    return {
      background: shape.kind === "text" ? "rgba(255,255,255,.82)" : "rgba(255,255,255,.38)",
      borderColor: "rgba(255,255,255,.8)",
      color: "#111827",
    };
  }
  if (tone === "dark") {
    return {
      background: shape.kind === "text" ? "rgba(15,23,42,.78)" : "rgba(15,23,42,.48)",
      borderColor: "rgba(15,23,42,.92)",
      color: "#f8fafc",
    };
  }
  return {
    background: shape.kind === "text" ? "rgba(37,99,235,.72)" : "rgba(37,99,235,.34)",
    borderColor: "rgba(147,197,253,.92)",
    color: "#fff",
  };
}

function imageShapeStyle(shape: SlideShape): CSSProperties {
  return {
    ...IMAGE_SHAPE_STYLE,
    objectFit: shape.imageFit === "contain" ? "contain" : "cover",
    borderRadius: imageMaskBorderRadius(shape.imageMask),
  };
}

function imageMaskBorderRadius(mask: SlideShape["imageMask"]): CSSProperties["borderRadius"] {
  if (mask === "rectangle") {
    return 0;
  }
  if (mask === "circle") {
    return 9999;
  }
  return 5;
}

function mediaUrlWithVideoTrim(mediaUrl: string, shape: SlideShape): string {
  const trim = normalizedMediaTrim(shape);
  if (trim.mediaStartSeconds === undefined && trim.mediaEndSeconds === undefined) {
    return mediaUrl;
  }
  const start = trim.mediaStartSeconds ?? 0;
  const range =
    trim.mediaEndSeconds === undefined
      ? String(start)
      : `${String(start)},${String(trim.mediaEndSeconds)}`;
  return `${mediaUrl.split("#")[0] ?? mediaUrl}#t=${range}`;
}

function normalizedMediaTrim(shape: Pick<SlideShape, "mediaStartSeconds" | "mediaEndSeconds">): {
  readonly mediaStartSeconds?: number;
  readonly mediaEndSeconds?: number;
} {
  const start = normalizeMediaTrimSeconds(shape.mediaStartSeconds);
  const end = normalizeMediaTrimSeconds(shape.mediaEndSeconds);
  return {
    ...(start === undefined || start === 0 ? {} : { mediaStartSeconds: start }),
    ...(end === undefined || end <= (start ?? 0) ? {} : { mediaEndSeconds: end }),
  };
}

function normalizeMediaTrimSeconds(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(Math.max(Math.round(value), 0), 86_400);
}

function EditorNotice({ icon, text }: { readonly icon: ReactNode; readonly text: string }) {
  return (
    <div role="status" style={NOTICE_STYLE}>
      {icon}
      {text}
    </div>
  );
}

const EDITOR_STYLE = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  flex: 1,
} satisfies CSSProperties;

const SLIDE_SHAPE_ANIMATION_KEYFRAMES = `
@keyframes helix-slide-transition-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes helix-slide-transition-zoom {
  from { opacity: 0; transform: scale(.96); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes helix-slide-transition-right {
  from { opacity: 0; transform: translateX(44px); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes helix-slide-transition-left {
  from { opacity: 0; transform: translateX(-44px); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes helix-slide-transition-up {
  from { opacity: 0; transform: translateY(-44px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes helix-slide-transition-down {
  from { opacity: 0; transform: translateY(44px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes helix-slide-shape-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes helix-slide-shape-zoom {
  from { opacity: 0; transform: scale(.82); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes helix-slide-shape-fly-left {
  from { opacity: 0; transform: translateX(-36px); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes helix-slide-shape-fly-right {
  from { opacity: 0; transform: translateX(36px); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes helix-slide-shape-fly-up {
  from { opacity: 0; transform: translateY(-36px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes helix-slide-shape-fly-down {
  from { opacity: 0; transform: translateY(36px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes helix-slide-shape-exit-fade {
  from { opacity: 1; }
  to { opacity: 0; }
}
@keyframes helix-slide-shape-exit-zoom {
  from { opacity: 1; transform: scale(1); }
  to { opacity: 0; transform: scale(.82); }
}
@keyframes helix-slide-shape-exit-fly-left {
  from { opacity: 1; transform: translateX(0); }
  to { opacity: 0; transform: translateX(-36px); }
}
@keyframes helix-slide-shape-exit-fly-right {
  from { opacity: 1; transform: translateX(0); }
  to { opacity: 0; transform: translateX(36px); }
}
@keyframes helix-slide-shape-exit-fly-up {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(-36px); }
}
@keyframes helix-slide-shape-exit-fly-down {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(36px); }
}
`;

const HEADER_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  background: "var(--surface)",
} satisfies CSSProperties;

const TITLE_STYLE = { fontWeight: 600 } satisfies CSSProperties;
const META_STYLE = {
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const EXPORT_GATE_STATUS_STYLE = {
  maxWidth: 220,
  color: "var(--danger)",
  fontSize: "var(--text-caption)",
  lineHeight: 1.25,
} satisfies CSSProperties;

const COLLABORATOR_ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  minWidth: 0,
} satisfies CSSProperties;

const COLLABORATOR_BADGE_STYLE = {
  display: "inline-grid",
  placeItems: "center",
  width: 28,
  height: 28,
  border: "1px solid var(--border)",
  borderRadius: "50%",
  background: "var(--surface-2)",
  color: "var(--text)",
  fontSize: "var(--text-caption)",
  fontWeight: 700,
} satisfies CSSProperties;

const THEME_CONTROL_STYLE = {
  display: "grid",
  gap: 3,
  minWidth: 120,
} satisfies CSSProperties;

const HEADER_SELECT_STYLE = {
  minWidth: 120,
  height: 32,
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "0 28px 0 9px",
  background: "var(--surface-2)",
  color: "var(--text)",
  font: "inherit",
  fontSize: "var(--text-body-sm)",
} satisfies CSSProperties;

const BODY_STYLE = {
  display: "grid",
  gridTemplateColumns: "280px minmax(0, 1fr)",
  minHeight: 0,
  flex: 1,
} satisfies CSSProperties;

const THUMB_RAIL_STYLE = {
  display: "grid",
  alignContent: "start",
  gap: 8,
  padding: 12,
  borderRight: "1px solid var(--border)",
  background: "var(--surface-2)",
  overflowY: "auto",
} satisfies CSSProperties;

const THUMB_ROW_STYLE = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 6,
  alignItems: "center",
  padding: "6px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface)",
} satisfies CSSProperties;

const THUMB_SELECT_STYLE = {
  display: "grid",
  gridTemplateColumns: "28px minmax(0, 1fr) auto",
  gap: 8,
  alignItems: "center",
  minWidth: 0,
  height: 30,
  padding: "0 4px",
  border: "none",
  background: "transparent",
  color: "var(--text)",
  textAlign: "left",
  font: "inherit",
  cursor: "pointer",
} satisfies CSSProperties;

const THUMB_ACTIONS_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 2,
} satisfies CSSProperties;

const THUMB_INDEX_STYLE = {
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const THUMB_TITLE_STYLE = { minWidth: 0, fontSize: "var(--text-body-sm)" } satisfies CSSProperties;

const THUMB_COMMENT_BADGE_STYLE = {
  display: "inline-grid",
  placeItems: "center",
  minWidth: 20,
  height: 20,
  padding: "0 6px",
  borderRadius: 999,
  background: "var(--accent)",
  color: "#fff",
  fontSize: "var(--text-caption)",
  fontWeight: 800,
} satisfies CSSProperties;

const CANVAS_COLUMN_STYLE = {
  display: "grid",
  gridTemplateColumns: "minmax(360px, 1fr) 320px",
  gap: 16,
  minHeight: 0,
  padding: 16,
  overflow: "auto",
  background: "var(--bg)",
} satisfies CSSProperties;

const SLIDE_CANVAS_STYLE = {
  position: "relative",
  aspectRatio: "16 / 9",
  alignSelf: "start",
  minWidth: 0,
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "linear-gradient(135deg, #101827, #2f3f63)",
  color: "#fff",
  overflow: "hidden",
  boxShadow: "var(--shadow-sm)",
} satisfies CSSProperties;

const SHAPE_LAYER_STYLE = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
} satisfies CSSProperties;

const SHAPE_STYLE = {
  position: "absolute",
  display: "grid",
  placeItems: "center",
  padding: "1.5%",
  border: "1px solid rgba(255,255,255,.84)",
  borderRadius: 6,
  overflow: "hidden",
} satisfies CSSProperties;

const CONNECTOR_SVG_STYLE = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  pointerEvents: "none",
} satisfies CSSProperties;

const CONNECTOR_LINE_STYLE = {
  stroke: "currentColor",
  strokeWidth: 6,
  strokeLinecap: "round",
  vectorEffect: "non-scaling-stroke",
} satisfies CSSProperties;

const IMAGE_SHAPE_STYLE = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  borderRadius: 5,
  userSelect: "none",
  pointerEvents: "none",
} satisfies CSSProperties;

const IMAGE_PLACEHOLDER_STYLE = {
  display: "grid",
  placeItems: "center",
  width: "100%",
  height: "100%",
  border: "1px dashed currentColor",
  borderRadius: 5,
  color: "currentColor",
  fontSize: "var(--text-caption)",
  fontWeight: 700,
} satisfies CSSProperties;

const VIDEO_SHAPE_STYLE = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  borderRadius: 5,
  background: "#020617",
} satisfies CSSProperties;

const AUDIO_SHAPE_WRAPPER_STYLE = {
  display: "grid",
  alignContent: "center",
  gap: 8,
  width: "100%",
  height: "100%",
  padding: 10,
  borderRadius: 5,
  background: "rgba(15,23,42,.58)",
} satisfies CSSProperties;

const AUDIO_SHAPE_STYLE = {
  width: "100%",
} satisfies CSSProperties;

const MEDIA_TITLE_STYLE = {
  color: "currentColor",
  fontSize: "var(--text-caption)",
  fontWeight: 700,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} satisfies CSSProperties;

const MEDIA_PLACEHOLDER_STYLE = {
  ...IMAGE_PLACEHOLDER_STYLE,
  background: "rgba(15,23,42,.26)",
} satisfies CSSProperties;

const SHAPE_EDITABLE_STYLE = {
  pointerEvents: "auto",
  cursor: "move",
} satisfies CSSProperties;

const SHAPE_SELECTED_STYLE = {
  outline: "2px solid #fff",
  outlineOffset: 2,
  boxShadow: "0 0 0 4px rgba(37,99,235,.42)",
} satisfies CSSProperties;

const REMOTE_SHAPE_SELECTION_STYLE = {
  position: "absolute",
  pointerEvents: "none",
  border: "2px solid #f97316",
  borderRadius: 7,
  boxShadow: "0 0 0 3px rgba(249,115,22,.24)",
  zIndex: 250,
} satisfies CSSProperties;

const REMOTE_SHAPE_SELECTION_BADGE_STYLE = {
  position: "absolute",
  top: -16,
  right: -16,
  display: "inline-grid",
  placeItems: "center",
  minWidth: 24,
  height: 24,
  padding: "0 6px",
  border: "2px solid #fff",
  borderRadius: 999,
  background: "#f97316",
  color: "#fff",
  fontSize: "var(--text-caption)",
  fontWeight: 800,
  boxShadow: "var(--shadow-sm)",
} satisfies CSSProperties;

const SHAPE_RESIZE_HANDLE_STYLE = {
  position: "absolute",
  right: 3,
  bottom: 3,
  width: 12,
  height: 12,
  border: "2px solid #fff",
  borderRadius: 3,
  background: "var(--accent)",
  boxShadow: "0 1px 4px rgba(15,23,42,.28)",
  cursor: "nwse-resize",
} satisfies CSSProperties;

const CONNECTOR_ENDPOINT_HANDLE_STYLE = {
  position: "absolute",
  zIndex: 2,
  width: 12,
  height: 12,
  border: "2px solid #fff",
  borderRadius: 999,
  background: "var(--accent)",
  boxShadow: "0 1px 4px rgba(15,23,42,.28)",
  transform: "translate(-50%, -50%)",
  cursor: "crosshair",
} satisfies CSSProperties;

const SHAPE_TEXT_STYLE = {
  display: "-webkit-box",
  WebkitLineClamp: 3,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
  maxWidth: "100%",
  fontSize: 16,
  lineHeight: 1.2,
  textAlign: "center",
  overflowWrap: "anywhere",
} satisfies CSSProperties;

const TITLE_LAYOUT_STYLE = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "flex-end",
  height: "100%",
  padding: "7%",
} satisfies CSSProperties;

const CONTENT_LAYOUT_STYLE = {
  display: "grid",
  alignContent: "center",
  gap: 18,
  height: "100%",
  padding: "7%",
} satisfies CSSProperties;

const SPLIT_LAYOUT_STYLE = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 24,
  alignItems: "center",
  height: "100%",
  padding: "7%",
} satisfies CSSProperties;

const SPLIT_RIGHT_STYLE = {
  borderLeft: "1px solid rgba(255,255,255,.3)",
  paddingLeft: 24,
} satisfies CSSProperties;

const EYEBROW_STYLE = {
  textTransform: "uppercase",
  fontSize: 12,
  opacity: 0.75,
} satisfies CSSProperties;

const SLIDE_TITLE_STYLE = {
  margin: 0,
  fontSize: 44,
  lineHeight: 1.05,
  letterSpacing: 0,
} satisfies CSSProperties;

const SLIDE_SUBTITLE_STYLE = {
  margin: "12px 0 0",
  fontSize: 18,
  opacity: 0.78,
} satisfies CSSProperties;

const BULLET_LIST_STYLE = {
  display: "grid",
  gap: 10,
  margin: 0,
  paddingInlineStart: 24,
  fontSize: 20,
} satisfies CSSProperties;

const STATS_GRID_STYLE = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 12,
} satisfies CSSProperties;

const STAT_STYLE = {
  display: "grid",
  gap: 4,
  padding: 12,
  border: "1px solid rgba(255,255,255,.25)",
  borderRadius: 8,
} satisfies CSSProperties;

const INSPECTOR_STYLE = {
  display: "grid",
  alignContent: "start",
  gap: 12,
  minWidth: 0,
  padding: 12,
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--surface)",
} satisfies CSSProperties;

const COMMENTS_RAIL_STYLE = {
  display: "grid",
  alignContent: "start",
  gap: 12,
  minWidth: 0,
  padding: 12,
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--surface)",
} satisfies CSSProperties;

const COMMENTS_HEADER_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  minWidth: 0,
} satisfies CSSProperties;

const COMMENT_COMPOSER_STYLE = {
  display: "grid",
  gap: 8,
  padding: 10,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
} satisfies CSSProperties;

const COMMENT_THREAD_LIST_STYLE = {
  display: "grid",
  gap: 10,
  margin: 0,
  padding: 0,
  listStyle: "none",
} satisfies CSSProperties;

const COMMENT_THREAD_STYLE = {
  display: "grid",
  gap: 8,
} satisfies CSSProperties;

const COMMENT_THREAD_SELECTED_STYLE = {
  ...COMMENT_THREAD_STYLE,
  padding: 8,
  border: "1px solid var(--accent)",
  borderRadius: 8,
  background: "color-mix(in srgb, var(--accent) 8%, transparent)",
} satisfies CSSProperties;

const COMMENT_CARD_STYLE = {
  display: "grid",
  gap: 8,
  minWidth: 0,
  padding: 10,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
} satisfies CSSProperties;

const COMMENT_CARD_HEADER_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  minWidth: 0,
} satisfies CSSProperties;

const COMMENT_HEADER_ACTIONS_STYLE = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  flex: "0 0 auto",
} satisfies CSSProperties;

const COMMENT_STATUS_STYLE = {
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
  textTransform: "capitalize",
} satisfies CSSProperties;

const COMMENT_BODY_STYLE = {
  margin: 0,
  color: "var(--text-2)",
  fontSize: "var(--text-body-sm)",
  overflowWrap: "anywhere",
  whiteSpace: "pre-wrap",
} satisfies CSSProperties;

const COMMENT_ACTION_ROW_STYLE = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "flex-end",
  gap: 6,
} satisfies CSSProperties;

const COMMENT_REPLY_LIST_STYLE = {
  display: "grid",
  gap: 8,
  margin: 0,
  padding: "0 0 0 12px",
  listStyle: "none",
  borderLeft: "2px solid var(--border)",
} satisfies CSSProperties;

const COMMENT_REPLY_FORM_STYLE = {
  display: "grid",
  gap: 6,
} satisfies CSSProperties;

const COMMENT_EDIT_FORM_STYLE = {
  display: "grid",
  gap: 6,
} satisfies CSSProperties;

const COMMENT_LINK_NOTICE_STYLE = {
  display: "grid",
  gap: 8,
  padding: 10,
  border: "1px solid var(--warning)",
  borderRadius: 6,
  background: "color-mix(in srgb, var(--warning) 12%, var(--surface))",
  color: "var(--text-2)",
  fontSize: "var(--text-body-sm)",
} satisfies CSSProperties;

const MENTION_TEXTAREA_WRAP_STYLE = {
  display: "grid",
  gap: 6,
  minWidth: 0,
} satisfies CSSProperties;

const MENTION_PICKER_STYLE = {
  display: "grid",
  gap: 4,
  padding: 6,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface)",
  boxShadow: "var(--shadow-sm)",
} satisfies CSSProperties;

const MENTION_PICKER_OPTION_STYLE = {
  display: "grid",
  gap: 2,
  padding: "6px 8px",
  border: "none",
  borderRadius: 5,
  background: "transparent",
  color: "var(--text)",
  font: "inherit",
  textAlign: "left",
  cursor: "pointer",
} satisfies CSSProperties;

const MENTION_PICKER_NAME_STYLE = {
  fontSize: "var(--text-body-sm)",
  fontWeight: 600,
} satisfies CSSProperties;

const MENTION_PICKER_EMAIL_STYLE = {
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
  overflowWrap: "anywhere",
} satisfies CSSProperties;

const FIELD_STYLE = { display: "grid", gap: 6 } satisfies CSSProperties;
const LABEL_STYLE = {
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const LAYOUT_SUGGESTION_STYLE = {
  display: "grid",
  gap: 8,
  padding: 10,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
} satisfies CSSProperties;

const LAYOUT_SUGGESTION_RESULT_STYLE = {
  display: "grid",
  gap: 8,
  fontSize: "var(--text-body-sm)",
  color: "var(--text-2)",
} satisfies CSSProperties;

const SHAPE_FIELDSET_STYLE = {
  display: "grid",
  gap: 10,
  minWidth: 0,
  margin: 0,
  padding: 10,
  border: "1px solid var(--border)",
  borderRadius: 6,
} satisfies CSSProperties;

const SHAPE_LEGEND_STYLE = {
  padding: "0 4px",
  fontSize: "var(--text-caption)",
  color: "var(--text-2)",
  fontWeight: 700,
} satisfies CSSProperties;

const SHAPE_ACTION_ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 6,
} satisfies CSSProperties;

const SHAPE_GRID_STYLE = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 8,
} satisfies CSSProperties;

const TRANSITION_PREVIEW_BUTTON_STYLE = {
  alignSelf: "end",
  minHeight: 34,
} satisfies CSSProperties;

const CHECKBOX_LABEL_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
  fontSize: "var(--text-caption)",
  color: "var(--text-2)",
} satisfies CSSProperties;

const MEDIA_ASSET_TABLE_WRAP_STYLE = {
  display: "grid",
  gap: 6,
  minWidth: 0,
} satisfies CSSProperties;

const DECK_MEDIA_ASSET_TABLE_WRAP_STYLE = {
  ...MEDIA_ASSET_TABLE_WRAP_STYLE,
  marginTop: 16,
} satisfies CSSProperties;

const DECK_MEDIA_ASSET_ACTION_BAR_STYLE = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  minWidth: 0,
} satisfies CSSProperties;

const DECK_MEDIA_FILTER_LABEL_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const DECK_MEDIA_FILTER_SELECT_STYLE = {
  height: 30,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface)",
  color: "var(--text)",
  font: "inherit",
  padding: "0 8px",
} satisfies CSSProperties;

const DECK_MEDIA_REPLACE_SELECT_STYLE = {
  ...DECK_MEDIA_FILTER_SELECT_STYLE,
  minWidth: 150,
} satisfies CSSProperties;

const MEDIA_ASSET_TABLE_STYLE = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const MEDIA_ASSET_HEADER_STYLE = {
  padding: "6px 4px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-3)",
  fontWeight: 700,
  textAlign: "left",
} satisfies CSSProperties;

const MEDIA_ASSET_CELL_STYLE = {
  padding: "6px 4px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-2)",
  verticalAlign: "top",
} satisfies CSSProperties;

const MEDIA_ASSET_ROW_SELECTED_STYLE = {
  background: "var(--surface-2)",
} satisfies CSSProperties;

const MEDIA_PREVIEW_ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  minWidth: 0,
} satisfies CSSProperties;

const MEDIA_ASSET_META_STYLE = {
  display: "block",
  marginTop: 2,
  color: "var(--text-3)",
} satisfies CSSProperties;

const MEDIA_ASSET_ACTIONS_STYLE = {
  display: "grid",
  gap: 4,
  minWidth: 0,
} satisfies CSSProperties;

const MEDIA_ASSET_CHECKBOX_LABEL_STYLE = {
  ...CHECKBOX_LABEL_STYLE,
  fontSize: "var(--text-caption)",
  color: "var(--text-2)",
} satisfies CSSProperties;

const INPUT_STYLE = {
  minWidth: 0,
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "8px 10px",
  background: "var(--surface-2)",
  color: "var(--text)",
  font: "inherit",
} satisfies CSSProperties;

const TEXTAREA_STYLE = {
  ...INPUT_STYLE,
  resize: "vertical",
} satisfies CSSProperties;

const ACTION_ROW_STYLE = {
  display: "flex",
  justifyContent: "flex-end",
} satisfies CSSProperties;

const EMPTY_STYLE = {
  margin: 0,
  color: "var(--text-3)",
  fontSize: "var(--text-body-sm)",
} satisfies CSSProperties;

const EMPTY_CANVAS_STYLE = {
  display: "grid",
  placeItems: "center",
  minHeight: 240,
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--surface)",
} satisfies CSSProperties;

const PRESENTER_STYLE = {
  position: "fixed",
  inset: 0,
  zIndex: 60,
  display: "grid",
  gridTemplateRows: "auto minmax(0, 1fr) auto",
  gap: 14,
  padding: 18,
  background: "#0b1020",
  color: "#fff",
} satisfies CSSProperties;

const PRESENTER_TOPBAR_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  minWidth: 0,
} satisfies CSSProperties;

const PRESENTER_TITLE_STYLE = {
  fontWeight: 700,
} satisfies CSSProperties;

const PRESENTER_META_STYLE = {
  color: "rgba(255,255,255,.68)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const PRESENTER_STAGE_STYLE = {
  position: "relative",
  display: "grid",
  placeItems: "center",
  minHeight: 0,
} satisfies CSSProperties;

const PRESENTER_SLIDE_STYLE = {
  width: "min(100%, calc((100vh - 154px) * 16 / 9))",
  maxHeight: "calc(100vh - 154px)",
  borderColor: "rgba(255,255,255,.16)",
  boxShadow: "0 24px 80px rgba(0,0,0,.42)",
} satisfies CSSProperties;

const PRESENTER_CONTROLS_STYLE = {
  display: "grid",
  gridTemplateColumns: "auto auto auto auto minmax(0, 1fr) minmax(180px, .36fr) auto",
  gap: 12,
  alignItems: "center",
} satisfies CSSProperties;

const PRESENTER_BUILD_STYLE = {
  color: "rgba(255,255,255,.78)",
  fontSize: "var(--text-caption)",
  fontWeight: 700,
  whiteSpace: "nowrap",
} satisfies CSSProperties;

const PRESENTER_RECORDING_STYLE = {
  display: "grid",
  gap: 10,
  minHeight: 34,
  color: "rgba(255,255,255,.82)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const PRESENTER_RECORDING_ACTIONS_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 10,
  minWidth: 0,
} satisfies CSSProperties;

const PRESENTER_RECORDING_REVIEW_STYLE = {
  display: "grid",
  gridTemplateColumns: "minmax(220px, 360px) minmax(0, 1fr)",
  gap: 12,
  alignItems: "start",
  padding: 10,
  border: "1px solid rgba(255,255,255,.14)",
  borderRadius: 8,
  background: "rgba(255,255,255,.05)",
} satisfies CSSProperties;

const PRESENTER_RECORDING_VIDEO_STYLE = {
  width: "100%",
  maxHeight: 160,
  borderRadius: 6,
  background: "#050816",
} satisfies CSSProperties;

const PRESENTER_RECORDING_CUES_STYLE = {
  display: "grid",
  gap: 6,
  maxHeight: 160,
  margin: 0,
  padding: "0 0 0 18px",
  overflow: "auto",
} satisfies CSSProperties;

const PRESENTER_RECORDING_CUE_STYLE = {
  overflowWrap: "anywhere",
  lineHeight: 1.35,
} satisfies CSSProperties;

const PRESENTER_NOTES_STYLE = {
  display: "grid",
  gap: 2,
  minWidth: 0,
  padding: "8px 10px",
  border: "1px solid rgba(255,255,255,.16)",
  borderRadius: 8,
  background: "rgba(255,255,255,.06)",
  color: "rgba(255,255,255,.84)",
} satisfies CSSProperties;

const PRESENTER_CAPTIONS_STYLE = {
  position: "absolute",
  left: "50%",
  transform: "translateX(-50%)",
  width: "min(760px, calc(100% - 96px))",
  display: "grid",
  gap: 4,
  padding: "10px 14px",
  borderRadius: 6,
  background: "rgba(0,0,0,.72)",
  color: "#fff",
  boxShadow: "0 18px 44px rgba(0,0,0,.28)",
  pointerEvents: "none",
  textAlign: "center",
} satisfies CSSProperties;

function presenterCaptionsStyle(position: PresentationCaptionPosition): CSSProperties {
  return {
    ...PRESENTER_CAPTIONS_STYLE,
    ...(position === "top" ? { top: 28 } : { bottom: 28 }),
  };
}

const PRESENTER_CAPTION_META_STYLE = {
  fontSize: "var(--text-caption)",
  textTransform: "uppercase",
  letterSpacing: 0,
  opacity: 0.72,
} satisfies CSSProperties;

const PRESENTER_CAPTION_TEXT_STYLE = {
  fontSize: "var(--text-body)",
  fontWeight: 600,
  lineHeight: 1.35,
  overflowWrap: "anywhere",
} satisfies CSSProperties;

function presenterCaptionTextStyle(size: PresentationCaptionSize): CSSProperties {
  return {
    ...PRESENTER_CAPTION_TEXT_STYLE,
    ...(size === "large" ? { fontSize: "var(--text-title-sm)", lineHeight: 1.28 } : {}),
  };
}

const PRESENTER_CAPTION_SELECT_STYLE = {
  display: "grid",
  gap: 3,
  minWidth: 124,
} satisfies CSSProperties;

const PRESENTER_CAPTION_SPEAKER_STYLE = {
  display: "grid",
  gap: 3,
  minWidth: 160,
} satisfies CSSProperties;

const PRESENTER_TRANSCRIPT_LIBRARY_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
  overflowX: "auto",
} satisfies CSSProperties;

const PRESENTER_SELECT_STYLE = {
  height: 30,
  border: "1px solid rgba(255,255,255,.16)",
  borderRadius: 6,
  background: "rgba(255,255,255,.08)",
  color: "#fff",
  font: "inherit",
  fontSize: "var(--text-caption)",
  padding: "0 8px",
} satisfies CSSProperties;

const PRESENTER_INPUT_STYLE = {
  ...PRESENTER_SELECT_STYLE,
  minWidth: 0,
} satisfies CSSProperties;

const PRESENTER_NEXT_STYLE = {
  ...PRESENTER_NOTES_STYLE,
  minWidth: 180,
} satisfies CSSProperties;

const PRESENTER_MEDIA_ANALYTICS_STYLE = {
  ...PRESENTER_NOTES_STYLE,
  display: "grid",
  gap: 4,
  minWidth: 220,
  maxHeight: 82,
  margin: 0,
  padding: "8px 10px 8px 26px",
  overflow: "auto",
} satisfies CSSProperties;

const PRESENTER_MEDIA_ANALYTICS_ROW_STYLE = {
  display: "grid",
  gap: 2,
  lineHeight: 1.25,
} satisfies CSSProperties;

const PRESENTER_NOTES_LABEL_STYLE = {
  color: "rgba(255,255,255,.52)",
  fontSize: "var(--text-caption)",
  textTransform: "uppercase",
} satisfies CSSProperties;

const NOTICE_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  flex: 1,
  color: "var(--text-3)",
} satisfies CSSProperties;
