/**
 * Type definition for the SlideEditor controller object exposed by
 * `useSlideEditorController` in `native-presentation-editor.tsx`.
 *
 * The controller represents the *editable draft* of the currently active
 * slide. State lives in `NativePresentationEditor` so that both the canvas
 * (`SlideEditor`) and the inspector tabs (`SlideInspector`,
 * `FormatInspector`, `NotesInspector`) can share it.
 */
import type { DriveApiEntry } from "@/features/drive/api";
import type {
  SlideBackground,
  SlideLayout,
  SlideShape,
  SlideShapeAnimation,
  SlideShapeAnimationEasing,
  SlideShapeAnimationType,
  SlideShapeKind,
  SlideShapeMotionPath,
  SlideTransition,
} from "./seed";

export interface SlideDraft {
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

export interface SlideLayoutSuggestion {
  readonly layout: SlideLayout;
  readonly reason: string;
}

export interface SlideImageDropPlacement {
  readonly x: number;
  readonly y: number;
}

export interface ShapeAnimationTimelineRow {
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

export interface SlideEditorController {
  readonly draft: SlideDraft;
  readonly selectedShape: SlideShape | null;
  readonly selectedShapeId: string | null;
  readonly selectedShapeIndex: number;
  readonly canPasteShape: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly mediaShapes: readonly SlideShape[];
  readonly animationTimeline: readonly ShapeAnimationTimelineRow[];
  readonly driveImageAssets: readonly DriveApiEntry[];
  readonly driveMediaAssets: readonly DriveApiEntry[];
  readonly imageUploadPending: boolean;
  readonly imageUploadError: boolean;
  readonly mediaUploadPending: boolean;
  readonly mediaUploadError: boolean;
  readonly layoutSuggestion: SlideLayoutSuggestion | null;
  readonly mediaTrimPreviewStatus: string;
  readonly canEditItems: boolean;
  readonly saving: boolean;
  readonly canSave: boolean;
  readonly setSelectedShapeId: (id: string) => void;
  readonly patchDraft: (patch: Partial<SlideDraft>) => void;
  readonly patchShape: (shapeId: string, patch: Partial<SlideShape>) => void;
  readonly patchSelectedShape: (patch: Partial<SlideShape>) => void;
  readonly addShape: (kind: SlideShapeKind) => void;
  readonly insertDroppedImage: (file: File, placement?: SlideImageDropPlacement) => void;
  readonly insertDroppedText: (
    text: string,
    placement?: SlideImageDropPlacement,
    linkUrl?: string,
  ) => void;
  readonly copySelectedShape: () => void;
  readonly cutSelectedShape: () => void;
  readonly pasteShape: () => void;
  readonly deleteShape: (shapeId: string) => void;
  readonly deleteSelectedShape: () => void;
  readonly moveSelectedShape: (direction: -1 | 1) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly changeLayout: (layout: SlideLayout) => void;
  readonly uploadSelectedShapeImage: (file: File | undefined) => void;
  readonly uploadSelectedShapeMedia: (file: File | undefined) => void;
  readonly pickDriveImageAsset: (objectId: string) => void;
  readonly pickDriveMediaAsset: (objectId: string) => void;
  readonly pickDriveMediaPosterAsset: (objectId: string) => void;
  readonly previewTransition: () => void;
  readonly previewSelectedMediaTrim: () => void;
  readonly suggestLayout: () => void;
  readonly applyLayoutSuggestion: () => void;
  readonly rewriteItems: () => void;
  readonly draftNotes: () => void;
  readonly save: () => void;
  readonly transitionFromSelection: (selection: string) => SlideTransition | undefined;
  readonly animationFromSelection: (
    selection: string,
    current: SlideShapeAnimation | undefined,
    shapeIndex: number,
  ) => SlideShapeAnimation | undefined;
}
