import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Extension,
  Mark,
  Node,
  mergeAttributes,
  type Content,
  type NodeViewRendererProps,
} from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView, type NodeView } from "@tiptap/pm/view";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FormEvent,
} from "react";
import * as Y from "yjs";
import { Icons } from "@/components/icons";
import { uploadDriveFile } from "@/features/drive/api";
import { parseHelixDriveItemDragData } from "@/features/drive/drag-payload";
import { useUnsavedChangesWarning } from "@/lib/use-unsaved-changes-warning";
import {
  generateDocsSuggestionDraft,
  saveNativeDocumentState,
  type DocsSuggestionDraft,
  type NativeDocumentSession,
} from "./api";
import {
  nativeDocumentInspectorSnapshotFromProseMirrorDoc,
  type NativeDocumentInspectorSnapshot,
} from "./native-document-content";
import { docsSessionQueryOptions, docsSmartChipPickerQueryOptions } from "./queries";
import {
  NATIVE_DOCUMENT_SELECT_ANCHOR_EVENT,
  type NativeDocumentAnchorDecoration,
  type NativeDocumentAnchorSelectionDetail,
  type NativeDocumentSelectionAnchor,
} from "./native-document-anchors";
import {
  NATIVE_DOCUMENT_COMMAND_EVENT,
  type NativeDocumentCommandEventDetail,
  type NativeDocumentSmartChipKind,
} from "./native-document-commands";
import {
  NativeDocumentYjsProvider,
  applyNativeDocumentState,
  type NativeDocumentProviderStatus,
} from "./native-document-yjs-provider";

export type NativeDocumentFieldKind = "date" | "time" | "page" | "author" | "documentTitle";
export type { NativeDocumentSmartChipKind } from "./native-document-commands";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    nativeDocumentTextColor: {
      setNativeTextColor: (color: string) => ReturnType;
      unsetNativeTextColor: () => ReturnType;
    };
    nativeDocumentHighlight: {
      setNativeHighlightColor: (color: string) => ReturnType;
      unsetNativeHighlightColor: () => ReturnType;
    };
    nativeDocumentTextAlign: {
      setNativeTextAlign: (align: NativeDocumentTextAlign) => ReturnType;
    };
    nativeDocumentChecklist: {
      toggleNativeChecklist: () => ReturnType;
    };
  }
}

type NativeDocumentTextAlign = "left" | "center" | "right" | "justify";

interface NativeDocumentSmartChipEntity {
  readonly kind: NativeDocumentSmartChipKind;
  readonly id: string;
  readonly label: string;
}

export interface NativeDocumentEditorProps {
  readonly session: NativeDocumentSession;
  readonly anchorDecorations?: readonly NativeDocumentAnchorDecoration[];
  readonly columnCount?: 1 | 2;
  readonly editable?: boolean;
  readonly showNonPrintingCharacters?: boolean;
  readonly generateSuggestionDraft?: typeof generateDocsSuggestionDraft;
  readonly onContentChange?: (() => void) | undefined;
  readonly onRecoveryStatusChange?: ((recovered: boolean) => void) | undefined;
  readonly onInspectorSnapshotChange?: (snapshot: NativeDocumentInspectorSnapshot) => void;
  readonly onSelectionAnchorChange?: (selection: NativeDocumentSelectionAnchor | null) => void;
  readonly onSelectionRangeChange?: (
    range: { readonly from: number; readonly to: number } | null,
  ) => void;
  /**
   * Notifies the shell when the underlying TipTap editor instance is available so the
   * unified chrome (menu bar + ribbon) can drive formatting commands and read isActive state.
   */
  readonly onEditorReady?: (editor: Editor | null) => void;
}

export interface NativeDocumentTextMatch {
  readonly from: number;
  readonly to: number;
}

export interface NativeDocumentTextReplacement {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

export interface NativeDocumentEquationTokenActivation {
  readonly from: number;
  readonly to: number;
  readonly latex: string;
}

interface NativeDocumentClipboardPayload {
  readonly text: string;
}

export interface NativeDocumentTokenDecorationRange {
  readonly from: number;
  readonly to: number;
  readonly kind: string;
  readonly label: string;
  readonly title: string;
  readonly chipKind?: NativeDocumentSmartChipKind | undefined;
  readonly tokenId?: string | undefined;
  readonly chipHref?: string | undefined;
  readonly referenceTargetId?: string | undefined;
  readonly hoverCard?: string | undefined;
}

const DOCS_YJS_RECOVERY_PREFIX = "helix.docs.unsavedYjs.v1";
const NATIVE_DOCUMENT_LINK_MARK = "link";

export interface NativeDocumentFindDecorationRange {
  readonly from: number;
  readonly to: number;
  readonly active: boolean;
  readonly index: number;
}

export interface NativeDocumentCrossReferenceOption {
  readonly id: string;
  readonly title: string;
  readonly level: number;
}

interface ProseMirrorTextNodeLike {
  readonly isText: boolean;
  readonly text?: string | null | undefined;
}

interface ProseMirrorDocLike {
  descendants(callback: (node: ProseMirrorTextNodeLike, pos: number) => boolean | void): void;
}

interface NativeDocumentEditorLike {
  readonly state: {
    readonly doc: ProseMirrorDocLike;
  };
  chain(): NativeDocumentCommandChain;
}

interface NativeDocumentSelectionEditorLike {
  readonly state: {
    readonly selection: {
      readonly from: number;
      readonly to: number;
      readonly empty: boolean;
    };
    readonly doc: {
      textBetween(from: number, to: number, blockSeparator?: string): string;
    };
  };
}

interface NativeDocumentDecorationDispatchEditorLike {
  readonly state: {
    readonly tr: Transaction;
  };
  readonly view?: {
    dispatch(transaction: Transaction): void;
  };
}

export interface NativeDocumentCommandChain {
  focus(): NativeDocumentCommandChain;
  setTextSelection(match: NativeDocumentTextMatch): NativeDocumentCommandChain;
  scrollIntoView(): NativeDocumentCommandChain;
  insertContent(value: Content): NativeDocumentCommandChain;
  insertContentAt(
    match: NativeDocumentTextMatch | number,
    value: Content,
  ): NativeDocumentCommandChain;
  toggleBold(): NativeDocumentCommandChain;
  toggleItalic(): NativeDocumentCommandChain;
  toggleUnderline(): NativeDocumentCommandChain;
  toggleStrike(): NativeDocumentCommandChain;
  setParagraph(): NativeDocumentCommandChain;
  toggleHeading(input: { readonly level: 1 | 2 }): NativeDocumentCommandChain;
  toggleBulletList(): NativeDocumentCommandChain;
  toggleOrderedList(): NativeDocumentCommandChain;
  toggleCodeBlock(): NativeDocumentCommandChain;
  setNativeTextColor(color: string): NativeDocumentCommandChain;
  setNativeHighlightColor(color: string): NativeDocumentCommandChain;
  setNativeTextAlign(align: NativeDocumentTextAlign): NativeDocumentCommandChain;
  run(): boolean;
}

export function NativeDocumentEditor({
  session,
  anchorDecorations = [],
  columnCount = 1,
  editable = true,
  showNonPrintingCharacters = false,
  generateSuggestionDraft = generateDocsSuggestionDraft,
  onContentChange,
  onRecoveryStatusChange,
  onInspectorSnapshotChange,
  onSelectionAnchorChange,
  onSelectionRangeChange,
  onEditorReady,
}: NativeDocumentEditorProps) {
  const actorQuery = useQuery(docsSessionQueryOptions());
  const smartChipPickerQuery = useQuery(docsSmartChipPickerQueryOptions());
  const [providerStatus, setProviderStatus] = useState<NativeDocumentProviderStatus>("offline");
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [equationDialogOpen, setEquationDialogOpen] = useState(false);
  const [equationText, setEquationText] = useState("");
  const [equationEdit, setEquationEdit] = useState<NativeDocumentEquationTokenActivation | null>(
    null,
  );
  const [equationEditText, setEquationEditText] = useState("");
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkText, setLinkText] = useState("");
  const [linkHref, setLinkHref] = useState("");
  const [linkStatus, setLinkStatus] = useState("");
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [tableRows, setTableRows] = useState(3);
  const [tableColumns, setTableColumns] = useState(3);
  const [fieldDialogOpen, setFieldDialogOpen] = useState(false);
  const [selectedField, setSelectedField] = useState<NativeDocumentFieldKind>("date");
  const [crossReferenceDialogOpen, setCrossReferenceDialogOpen] = useState(false);
  const [selectedCrossReferenceId, setSelectedCrossReferenceId] = useState("");
  const [smartChipDialogOpen, setSmartChipDialogOpen] = useState(false);
  const [selectedSmartChipKind, setSelectedSmartChipKind] =
    useState<NativeDocumentSmartChipKind>("person");
  const [selectedSmartChipEntityValue, setSelectedSmartChipEntityValue] = useState("");
  const [smartComposePrompt, setSmartComposePrompt] = useState("");
  const [smartComposeStatus, setSmartComposeStatus] = useState("Select text to compose");
  const [smartComposeDraft, setSmartComposeDraft] = useState("");
  const [smartComposePending, setSmartComposePending] = useState(false);
  const smartComposeDraftRef = useRef("");
  const smartComposePendingRef = useRef(false);
  const smartComposeContextVersionRef = useRef(0);
  const smartComposeRequestIdRef = useRef(0);
  const editorRef = useRef<Editor | null>(null);
  const documentClipboardRef = useRef<NativeDocumentClipboardPayload | null>(null);
  const [matches, setMatches] = useState<readonly NativeDocumentTextMatch[]>([]);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [findStatus, setFindStatus] = useState("No query");
  const [headingReferences, setHeadingReferences] = useState<
    readonly NativeDocumentCrossReferenceOption[]
  >([]);
  const [, setToolbarRevision] = useState(0);
  const linkHrefInputRef = useRef<HTMLInputElement | null>(null);
  const tableRowsInputRef = useRef<HTMLInputElement | null>(null);
  const fieldSelectRef = useRef<HTMLSelectElement | null>(null);
  const crossReferenceSelectRef = useRef<HTMLSelectElement | null>(null);
  const smartChipKindSelectRef = useRef<HTMLSelectElement | null>(null);
  const equationInputRef = useRef<HTMLInputElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const smartComposeInputRef = useRef<HTMLInputElement | null>(null);
  const imageFileInputRef = useRef<HTMLInputElement | null>(null);
  const editorWrapRef = useRef<HTMLElement | null>(null);
  const mountedRef = useRef(false);
  const onContentChangeRef = useRef(onContentChange);
  const recoveredState = useMemo(
    () => readRecoveredNativeDocumentState(session.document.id, session.document.stateVectorBase64),
    [session.document.id, session.document.stateVectorBase64],
  );
  const [hasRecoveredDocumentDraft, setHasRecoveredDocumentDraft] = useState(
    recoveredState !== null,
  );
  const unsavedChangesWarning = useUnsavedChangesWarning(
    hasRecoveredDocumentDraft,
    "document editor",
  );
  const ydoc = useMemo(() => {
    const doc = new Y.Doc();
    applyNativeDocumentState(doc, session.document.stateBase64);
    if (recoveredState !== null) {
      Y.applyUpdate(doc, recoveredState.update);
    }
    return doc;
  }, [recoveredState, session.document.id, session.document.stateBase64]);
  const saveNativeDocumentModelState = useCallback(
    async (metadata: Record<string, unknown>) => {
      await saveNativeDocumentState({
        docId: session.document.id,
        stateBase64: base64FromUint8Array(Y.encodeStateAsUpdate(ydoc)),
        stateVectorBase64: base64FromUint8Array(Y.encodeStateVector(ydoc)),
        metadata,
      });
      removeRecoveredNativeDocumentState(session.document.id);
      setHasRecoveredDocumentDraft(false);
      onRecoveryStatusChange?.(false);
    },
    [onRecoveryStatusChange, session.document.id, ydoc],
  );
  const anchorDecorationExtension = useMemo(
    () => createNativeDocumentAnchorDecorationExtension(),
    [],
  );
  const imageExtension = useMemo(
    () =>
      createNativeDocumentImageExtension({
        onPersist: (metadata) => {
          void saveNativeDocumentModelState(metadata);
        },
      }),
    [saveNativeDocumentModelState],
  );
  const checklistExtensions = useMemo(
    () =>
      createNativeDocumentChecklistExtensions({
        onPersist: (metadata) => {
          void saveNativeDocumentModelState(metadata);
        },
      }),
    [saveNativeDocumentModelState],
  );
  const extensions = useMemo(
    () => [
      StarterKit.configure({ undoRedo: false }),
      createNativeDocumentTextColorExtension(),
      createNativeDocumentHighlightExtension(),
      createNativeDocumentTextAlignExtension(),
      createNativeDocumentPageBreakExtension(),
      createNativeDocumentFootnoteExtension(),
      ...createNativeDocumentTableExtensions(),
      ...checklistExtensions,
      imageExtension,
      Collaboration.configure({
        document: ydoc,
        field: "default",
      }),
      anchorDecorationExtension,
    ],
    [anchorDecorationExtension, checklistExtensions, imageExtension, ydoc],
  );
  const refreshNativeDocumentHeadingReferences = useCallback(() => {
    assignNativeDocumentHeadingAnchors(editorWrapRef.current);
    const nextHeadingReferences = nativeDocumentCrossReferenceOptions(editorWrapRef.current);
    if (mountedRef.current) {
      setHeadingReferences(nextHeadingReferences);
    }
    return nextHeadingReferences;
  }, []);
  const setSmartComposePendingState = useCallback((pending: boolean) => {
    smartComposePendingRef.current = pending;
    setSmartComposePending(pending);
  }, []);
  const invalidateSmartComposeRequest = useCallback(
    (status: string) => {
      smartComposeContextVersionRef.current += 1;
      smartComposeRequestIdRef.current += 1;
      const hadActiveDraft =
        smartComposePendingRef.current || smartComposeDraftRef.current.length > 0;
      setSmartComposePendingState(false);
      if (hadActiveDraft) {
        setSmartComposeDraft("");
        setSmartComposeStatus(status);
      }
    },
    [setSmartComposePendingState],
  );
  const editor = useEditor(
    {
      extensions,
      editorProps: {
        attributes: {
          "aria-label": session.document.title,
          class: "native-document-editor__content",
        },
        handleKeyDown(_view, event) {
          if (event.key === "Tab" && smartComposeDraftRef.current.length > 0) {
            event.preventDefault();
            acceptSmartComposeDraft();
            return true;
          }
          if (event.key === "Escape" && smartComposeDraftRef.current.length > 0) {
            event.preventDefault();
            dismissSmartComposeDraft();
            return true;
          }
          return false;
        },
      },
      editable,
      onSelectionUpdate: ({ editor: updatedEditor }) => {
        invalidateSmartComposeRequest("Selection changed. Compose again");
        setToolbarRevision((revision) => revision + 1);
        onSelectionAnchorChange?.(selectionAnchorFromEditor(updatedEditor));
        onSelectionRangeChange?.({
          from: updatedEditor.state.selection.from,
          to: updatedEditor.state.selection.to,
        });
      },
      onUpdate: ({ editor: updatedEditor }) => {
        invalidateSmartComposeRequest("Document changed. Compose again");
        setToolbarRevision((revision) => revision + 1);
        emitNativeDocumentInspectorSnapshot(onInspectorSnapshotChange, updatedEditor.state.doc);
        onContentChangeRef.current?.();
        queueMicrotask(() => refreshNativeDocumentHeadingReferences());
      },
      shouldRerenderOnTransaction: false,
    },
    [
      extensions,
      onInspectorSnapshotChange,
      onSelectionAnchorChange,
      onSelectionRangeChange,
      invalidateSmartComposeRequest,
      refreshNativeDocumentHeadingReferences,
      session.document.title,
    ],
  );

  useEffect(() => {
    onContentChangeRef.current = onContentChange;
  }, [onContentChange]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editable, editor]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    editorRef.current = editor;
    onEditorReady?.(editor);
  }, [editor, onEditorReady]);

  useEffect(() => {
    smartComposeDraftRef.current = smartComposeDraft;
  }, [smartComposeDraft]);

  useEffect(() => {
    if (smartComposeDraft.length === 0 || editor === null) {
      dispatchNativeDocumentGhostText(editor, null);
      return;
    }
    dispatchNativeDocumentGhostText(editor, {
      position: editor.state.selection.to,
      text: smartComposeDraft,
    });
  }, [editor, smartComposeDraft]);

  useEffect(() => {
    if (editor?.view !== undefined && editor.state.tr !== undefined) {
      editor.view.dispatch(
        editor.state.tr.setMeta(NATIVE_DOCUMENT_DECORATION_PLUGIN_KEY, { anchorDecorations }),
      );
    }
  }, [anchorDecorations, editor]);

  useEffect(() => {
    if (editor !== null) {
      emitNativeDocumentInspectorSnapshot(onInspectorSnapshotChange, editor.state.doc);
    }
  }, [editor, onInspectorSnapshotChange]);

  useEffect(() => {
    setHasRecoveredDocumentDraft(recoveredState !== null);
    onRecoveryStatusChange?.(recoveredState !== null);
  }, [onRecoveryStatusChange, recoveredState]);

  useEffect(() => {
    const onDocumentUpdate = () => {
      writeRecoveredNativeDocumentState(session.document.id, ydoc);
      setHasRecoveredDocumentDraft(true);
      onRecoveryStatusChange?.(true);
    };
    ydoc.on("update", onDocumentUpdate);
    return () => {
      ydoc.off("update", onDocumentUpdate);
    };
  }, [onRecoveryStatusChange, session.document.id, ydoc]);

  useEffect(() => {
    return () => {
      ydoc.destroy();
    };
  }, [ydoc]);

  useEffect(() => {
    const provider = new NativeDocumentYjsProvider({
      url: session.sync.url,
      doc: ydoc,
      onStatusChange: setProviderStatus,
      onError: () => setProviderStatus("offline"),
    });
    const actor = actorQuery.data;
    if (actor !== undefined) {
      provider.awareness.setLocalState({
        actor: {
          id: actor.actorId,
          name: actor.name,
          color: "#335cff",
        },
      });
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        provider.connect();
      }
    });
    return () => {
      cancelled = true;
      provider.disconnect({ notify: false });
    };
  }, [actorQuery.data, session.sync.url, ydoc]);

  const runFind = (nextIndex = 0) => {
    const nextMatches =
      editor === null ? [] : findNativeDocumentTextMatches(editor.state.doc, findText);
    setMatches(nextMatches);
    if (findText.length === 0) {
      setActiveMatchIndex(0);
      setFindStatus("No query");
      dispatchNativeDocumentFindDecorations(editor, [], 0);
      return;
    }
    if (nextMatches.length === 0) {
      setActiveMatchIndex(0);
      setFindStatus("No matches");
      dispatchNativeDocumentFindDecorations(editor, [], 0);
      return;
    }
    const boundedIndex =
      ((nextIndex % nextMatches.length) + nextMatches.length) % nextMatches.length;
    setActiveMatchIndex(boundedIndex);
    dispatchNativeDocumentFindDecorations(editor, nextMatches, boundedIndex);
    selectNativeDocumentMatch(editor, nextMatches[boundedIndex]);
    setFindStatus(`${String(boundedIndex + 1)} of ${String(nextMatches.length)}`);
  };

  const onFind = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    runFind(0);
  };

  const onFindNext = () => {
    if (matches.length === 0) {
      runFind(0);
      return;
    }
    runFind(activeMatchIndex + 1);
  };

  const onFindPrevious = () => {
    if (matches.length === 0) {
      runFind(0);
      return;
    }
    runFind(activeMatchIndex - 1);
  };

  const onReplaceCurrent = () => {
    const match = matches[activeMatchIndex];
    if (editor === null || match === undefined || findText.length === 0) {
      runFind(0);
      return;
    }
    editor.chain().focus().insertContentAt(match, replaceText).run();
    runFind(activeMatchIndex);
  };

  const onReplaceAll = () => {
    if (editor === null || findText.length === 0) {
      return;
    }
    const currentMatches = findNativeDocumentTextMatches(editor.state.doc, findText);
    for (const match of [...currentMatches].reverse()) {
      editor.chain().focus().insertContentAt(match, replaceText).run();
    }
    setMatches([]);
    setActiveMatchIndex(0);
    dispatchNativeDocumentFindDecorations(editor, [], 0);
    setFindStatus(`Replaced ${String(currentMatches.length)}`);
  };

  const onInsertTableOfContents = () => {
    if (editor === null) {
      return;
    }
    refreshNativeDocumentHeadingReferences();
    const tocText = nativeDocumentTableOfContentsText(editorWrapRef.current);
    if (tocText === null) {
      return;
    }
    editor.chain().focus().insertContent(tocText).run();
  };

  const openInsertCrossReferenceDialog = () => {
    if (editorRef.current === null) {
      return;
    }
    const references = refreshNativeDocumentHeadingReferences();
    setSelectedCrossReferenceId(references[0]?.id ?? "");
    setCrossReferenceDialogOpen(true);
    queueMicrotask(() => {
      crossReferenceSelectRef.current?.focus();
    });
  };

  const onInsertCrossReference = async (targetId: string) => {
    const targetEditor = editorRef.current;
    if (targetEditor === null) {
      return;
    }
    const reference = refreshNativeDocumentHeadingReferences().find(
      (candidate) => candidate.id === targetId,
    );
    if (reference === undefined) {
      return;
    }
    targetEditor
      .chain()
      .focus()
      .insertContent(nativeDocumentCrossReferenceInsertionText(reference))
      .run();
    setCrossReferenceDialogOpen(false);
    await saveNativeDocumentModelState({
      source: "web.native-document-editor.insert-cross-reference",
      targetId: reference.id,
      label: reference.title,
    });
  };

  const onInsertCrossReferenceSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onInsertCrossReference(selectedCrossReferenceId);
  };

  const onInsertBookmark = () => {
    if (editor === null) {
      return;
    }
    const existingReferences = refreshNativeDocumentHeadingReferences();
    const selectedText = selectedNativeDocumentText(editor);
    const label =
      selectedText.length > 0 ? selectedText : `Bookmark ${String(existingReferences.length + 1)}`;
    editor
      .chain()
      .focus()
      .insertContent(nativeDocumentBookmarkInsertionText(label, existingReferences))
      .run();
  };

  const openInsertEquationDialog = () => {
    if (editorRef.current === null) {
      return;
    }
    setEquationDialogOpen(true);
    setEquationText("");
    queueMicrotask(() => {
      equationInputRef.current?.focus();
    });
  };

  const openInsertTableDialog = () => {
    if (editorRef.current === null) {
      return;
    }
    setTableRows(3);
    setTableColumns(3);
    setTableDialogOpen(true);
    queueMicrotask(() => {
      tableRowsInputRef.current?.focus();
      tableRowsInputRef.current?.select();
    });
  };

  const onInsertTable = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const targetEditor = editorRef.current;
    if (targetEditor === null) {
      return;
    }
    const rows = nativeDocumentTableSize(tableRows);
    const columns = nativeDocumentTableSize(tableColumns);
    targetEditor.chain().focus().insertContent(nativeDocumentTableContent(rows, columns)).run();
    setTableDialogOpen(false);
    await saveNativeDocumentModelState({
      source: "web.native-document-editor.insert-table",
      rows,
      columns,
    });
  };

  const onInsertEquation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const targetEditor = editorRef.current;
    if (targetEditor === null || equationText.trim().length === 0) {
      return;
    }
    targetEditor
      .chain()
      .focus()
      .insertContent(nativeDocumentEquationInsertionText(equationText))
      .run();
    const insertedEquation = equationText.trim();
    setEquationText("");
    setEquationDialogOpen(false);
    await saveNativeDocumentModelState({
      source: "web.native-document-editor.insert-equation",
      equationLength: insertedEquation.length,
    });
  };

  const onSaveEquationEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (editor === null || equationEdit === null || equationEditText.trim().length === 0) {
      return;
    }
    editor
      .chain()
      .focus()
      .insertContentAt(
        { from: equationEdit.from, to: equationEdit.to },
        nativeDocumentEquationInsertionText(equationEditText),
      )
      .run();
    setEquationEdit(null);
    setEquationEditText("");
    await saveNativeDocumentModelState({
      source: "web.native-document-editor.edit-equation",
      equationLength: equationEditText.trim().length,
    });
  };

  const openInsertFieldDialog = () => {
    if (editorRef.current === null) {
      return;
    }
    setSelectedField("date");
    setFieldDialogOpen(true);
    queueMicrotask(() => {
      fieldSelectRef.current?.focus();
    });
  };

  const onInsertField = async (field: NativeDocumentFieldKind) => {
    const targetEditor = editorRef.current;
    if (targetEditor === null) {
      return;
    }
    targetEditor
      .chain()
      .focus()
      .insertContent(
        nativeDocumentFieldInsertionText(field, {
          actorName: actorQuery.data?.name,
          documentTitle: session.document.title,
        }),
      )
      .run();
    setFieldDialogOpen(false);
    await saveNativeDocumentModelState({
      source: "web.native-document-editor.insert-field",
      field,
    });
  };

  const onInsertFieldSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onInsertField(selectedField);
  };

  const openInsertLinkDialog = () => {
    const targetEditor = editorRef.current;
    if (targetEditor === null) {
      return;
    }
    const selectedText = selectedNativeDocumentText(targetEditor);
    setLinkText(selectedText);
    setLinkHref("");
    setLinkStatus("");
    setLinkDialogOpen(true);
    queueMicrotask(() => {
      linkHrefInputRef.current?.focus();
    });
  };

  const onInsertLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const targetEditor = editorRef.current;
    if (targetEditor === null) {
      return;
    }
    const href = safeNativeDocumentHref(linkHref);
    if (href === null) {
      setLinkStatus("Enter a safe http, https, or mailto link");
      return;
    }
    const selection = targetEditor.state.selection;
    const text = linkText.trim().length > 0 ? linkText.trim() : href;
    const content: Content = {
      type: "text",
      text,
      marks: [
        {
          type: NATIVE_DOCUMENT_LINK_MARK,
          attrs: { href },
        },
      ],
    };
    const chain = targetEditor.chain().focus();
    if (selection.empty) {
      chain.insertContent(content).run();
    } else {
      chain.insertContentAt({ from: selection.from, to: selection.to }, content).run();
    }
    setLinkDialogOpen(false);
    setLinkText("");
    setLinkHref("");
    setLinkStatus("");
    await saveNativeDocumentModelState({
      source: "web.native-document-editor.insert-link",
      href,
      textLength: text.length,
    });
  };

  const onRefreshFields = () => {
    if (editor === null) {
      return;
    }
    const replacements = nativeDocumentFieldRefreshRanges(editor.state.doc, {
      actorName: actorQuery.data?.name,
      documentTitle: session.document.title,
    });
    if (replacements.length === 0) {
      return;
    }
    const chain = editor.chain().focus();
    for (const replacement of [...replacements].reverse()) {
      chain.insertContentAt({ from: replacement.from, to: replacement.to }, replacement.text);
    }
    chain.run();
  };

  const smartComposeMutation = useMutation({
    onMutate: () => undefined,
    onError: (_error, input) => {
      if (
        input.requestId !== smartComposeRequestIdRef.current ||
        input.contextVersion !== smartComposeContextVersionRef.current
      ) {
        return;
      }
      setSmartComposePendingState(false);
      setSmartComposeStatus("Could not draft");
    },
    mutationFn: (input: {
      readonly selection: string;
      readonly prompt: string;
      readonly contextVersion: number;
      readonly requestId: number;
    }) =>
      generateSuggestionDraft({
        docId: session.document.id,
        slotId: "docs.smart-write",
        selection: input.selection,
        ...(input.prompt.length === 0 ? {} : { prompt: input.prompt }),
      }),
    onSuccess: (draft: DocsSuggestionDraft, input) => {
      if (
        input.requestId !== smartComposeRequestIdRef.current ||
        input.contextVersion !== smartComposeContextVersionRef.current
      ) {
        return;
      }
      setSmartComposePendingState(false);
      const text = draft.text.trim();
      if (text.length === 0) {
        setSmartComposeStatus("No draft returned");
        return;
      }
      setSmartComposeDraft(text);
      setSmartComposeStatus("Draft ready. Press Tab to accept");
    },
  });

  const droppedImageMutation = useMutation({
    mutationFn: async (input: {
      readonly file: File;
      readonly position: number | undefined;
      readonly source?: string;
    }) => {
      const uploaded = await uploadDriveFile({ file: input.file, folderId: null });
      return {
        ...input,
        objectId: uploaded.objectId,
        imageAlt: nativeDocumentImageAltFromFilename(input.file.name),
      };
    },
    onSuccess: async (result) => {
      const targetEditor = editorRef.current;
      if (targetEditor === null) {
        return;
      }
      const content = {
        type: NATIVE_DOCUMENT_IMAGE_NODE,
        attrs: {
          src: `/api/drive/objects/${encodeURIComponent(result.objectId)}/content`,
          alt: result.imageAlt,
          title: result.file.name,
          widthPercent: 80,
          caption: "",
        },
      };
      const chain = targetEditor.chain().focus();
      if (result.position === undefined) {
        chain.insertContent(content).run();
      } else {
        chain.insertContentAt(result.position, content).run();
      }
      await saveNativeDocumentModelState({
        source: result.source ?? "web.native-document-editor.drop-image",
        driveObjectId: result.objectId,
        filename: result.file.name,
      });
    },
    onMutate: () => undefined,
    onError: () => undefined,
  });

  const onSmartCompose = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (editor === null || smartComposePending) {
      return;
    }
    const selection = selectedNativeDocumentText(editor);
    if (selection.length === 0) {
      setSmartComposeStatus("Select text to compose");
      return;
    }
    setSmartComposeStatus("Drafting");
    setSmartComposeDraft("");
    const requestId = smartComposeRequestIdRef.current + 1;
    smartComposeRequestIdRef.current = requestId;
    setSmartComposePendingState(true);
    smartComposeMutation.mutate({
      selection,
      prompt: smartComposePrompt.trim(),
      contextVersion: smartComposeContextVersionRef.current,
      requestId,
    });
  };

  const acceptSmartComposeDraft = () => {
    const targetEditor = editorRef.current;
    const draft = smartComposeDraftRef.current.trim();
    if (targetEditor === null || draft.length === 0) {
      return;
    }
    targetEditor.chain().focus().insertContent(smartComposeDraftRef.current).run();
    setSmartComposeDraft("");
    setSmartComposePrompt("");
    setSmartComposeStatus("Draft inserted");
  };

  const dismissSmartComposeDraft = () => {
    setSmartComposeDraft("");
    setSmartComposeStatus("Draft dismissed");
  };

  const onDocumentDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (
      droppedNativeDocumentImageFile(event.dataTransfer) === undefined &&
      !hasDroppedNativeDocumentText(event.dataTransfer)
    ) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDocumentDrop = (event: ReactDragEvent<HTMLElement>) => {
    const file = droppedNativeDocumentImageFile(event.dataTransfer);
    const targetEditor = editorRef.current;
    if (targetEditor === null) {
      return;
    }
    if (file !== undefined) {
      event.preventDefault();
      droppedImageMutation.mutate({
        file,
        position: nativeDocumentDropPosition(targetEditor, event),
      });
      return;
    }
    const driveItem = parseHelixDriveItemDragData(event.dataTransfer);
    const text = normalizedDroppedNativeDocumentText(
      driveItem?.name ?? droppedNativeDocumentText(event.dataTransfer),
    );
    if (text.length === 0) {
      return;
    }
    event.preventDefault();
    const position = nativeDocumentDropPosition(targetEditor, event);
    const droppedHref = driveItem?.href ?? droppedNativeDocumentHref(event.dataTransfer);
    const smartChip = nativeDocumentDroppedSmartChip(droppedHref, text, smartChipPickerQuery.data);
    const content =
      smartChip === null
        ? nativeDocumentDroppedTextContent(text, droppedHref)
        : nativeDocumentSmartChipInsertionText(smartChip.kind, {
            documentId: smartChip.kind === "doc" ? smartChip.id : undefined,
            documentTitle: smartChip.kind === "doc" ? smartChip.label : undefined,
            fileId: smartChip.kind === "file" ? smartChip.id : undefined,
            fileTitle: smartChip.kind === "file" ? smartChip.label : undefined,
            href: smartChip.href,
          });
    const chain = targetEditor.chain().focus();
    if (position === undefined) {
      chain.insertContent(content).run();
    } else {
      chain.insertContentAt(position, content).run();
    }
    void saveNativeDocumentModelState({
      source:
        smartChip === null
          ? "web.native-document-editor.drop-text"
          : "web.native-document-editor.drop-smart-chip",
      textLength: text.length,
      ...(droppedHref === null ? {} : { href: droppedHref }),
      ...(smartChip === null
        ? {}
        : {
            chipKind: smartChip.kind,
            targetId: smartChip.id,
            label: smartChip.label,
          }),
    });
  };

  const onImageFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.item(0) ?? null;
    event.currentTarget.value = "";
    const targetEditor = editorRef.current;
    if (file === null || targetEditor === null || !isNativeDocumentImageFile(file)) {
      return;
    }
    droppedImageMutation.mutate({
      file,
      position: targetEditor.state.selection.to,
      source: "web.native-document-editor.insert-image",
    });
  };

  const openSmartChipDialog = () => {
    if (editorRef.current === null) {
      return;
    }
    setSelectedSmartChipKind("person");
    setSelectedSmartChipEntityValue("");
    setSmartChipDialogOpen(true);
    queueMicrotask(() => {
      smartChipKindSelectRef.current?.focus();
    });
  };

  const onInsertSmartChip = async (
    kind: NativeDocumentSmartChipKind,
    entity?: NativeDocumentSmartChipEntity,
  ) => {
    const targetEditor = editorRef.current;
    if (targetEditor === null) {
      return;
    }
    targetEditor
      .chain()
      .focus()
      .insertContent(
        nativeDocumentSmartChipInsertionText(kind, {
          actorId: entity?.kind === "person" ? entity.id : actorQuery.data?.actorId,
          actorName: entity?.kind === "person" ? entity.label : actorQuery.data?.name,
          documentId: entity?.kind === "doc" ? entity.id : session.document.id,
          documentTitle: entity?.kind === "doc" ? entity.label : session.document.title,
          fileId: entity?.kind === "file" ? entity.id : session.document.id,
          fileTitle: entity?.kind === "file" ? entity.label : session.document.title,
          href:
            entity?.kind === "doc"
              ? `/docs/${encodeURIComponent(entity.id)}`
              : entity?.kind === "file"
                ? `/open/${encodeURIComponent(entity.id)}`
                : undefined,
          eventId: entity?.kind === "event" ? entity.id : undefined,
          eventTitle: entity?.kind === "event" ? entity.label : undefined,
        }),
      )
      .run();
    setSmartChipDialogOpen(false);
    await saveNativeDocumentModelState({
      source: "web.native-document-editor.insert-smart-chip",
      chipKind: kind,
      ...(entity === undefined ? {} : { targetId: entity.id, label: entity.label }),
    });
  };

  const onInsertSmartChipSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onInsertSmartChip(
      selectedSmartChipKind,
      nativeDocumentSmartChipEntityFromSelectValue(
        selectedSmartChipEntityValue,
        smartChipPickerQuery.data,
      ) ?? undefined,
    );
  };

  const copyNativeDocumentSelection = useCallback(async (): Promise<boolean> => {
    const targetEditor = editorRef.current;
    if (targetEditor === null) {
      return false;
    }
    const text = nativeDocumentSelectedPlainText(targetEditor);
    if (text.length === 0) {
      return false;
    }
    documentClipboardRef.current = { text };
    await writeNativeDocumentPlainClipboardText(text).catch(() => undefined);
    return true;
  }, []);

  const cutNativeDocumentSelection = useCallback(async () => {
    const targetEditor = editorRef.current;
    if (targetEditor === null) {
      return;
    }
    const selection = targetEditor.state.selection;
    if (!(await copyNativeDocumentSelection())) {
      return;
    }
    const deleted = selection.empty
      ? deleteNativeDocumentDomSelection(targetEditor)
      : targetEditor.chain().focus().deleteRange({ from: selection.from, to: selection.to }).run();
    if (!deleted) {
      return;
    }
    await saveNativeDocumentModelState({
      source: "web.native-document-editor.edit-cut",
    });
  }, [copyNativeDocumentSelection, saveNativeDocumentModelState]);

  const pasteNativeDocumentClipboard = useCallback(
    async (plainOnly: boolean) => {
      const targetEditor = editorRef.current;
      if (targetEditor === null) {
        return;
      }
      const text =
        documentClipboardRef.current?.text ?? (await readNativeDocumentPlainClipboardText());
      if (text.length === 0) {
        return;
      }
      targetEditor.chain().focus().insertContent(text).run();
      await saveNativeDocumentModelState({
        source: plainOnly
          ? "web.native-document-editor.edit-paste-plain"
          : "web.native-document-editor.edit-paste",
      });
    },
    [saveNativeDocumentModelState],
  );

  const insertNativeDocumentFootnote = useCallback(async () => {
    const targetEditor = editorRef.current;
    if (targetEditor === null) {
      return;
    }
    const number = nextNativeDocumentFootnoteNumber(targetEditor);
    targetEditor
      .chain()
      .focus()
      .insertContent([
        {
          type: NATIVE_DOCUMENT_FOOTNOTE_NODE,
          attrs: { number, note: "Footnote" },
        },
        { type: "text", text: " " },
      ])
      .run();
    await saveNativeDocumentModelState({
      source: "web.native-document-editor.insert-footnote",
      number,
    });
  }, [saveNativeDocumentModelState]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "f") {
        event.preventDefault();
        findInputRef.current?.focus();
        findInputRef.current?.select();
        return;
      }
      if (key === "g") {
        event.preventDefault();
        if (event.shiftKey) {
          onFindPrevious();
        } else {
          onFindNext();
        }
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => {
      window.removeEventListener("keydown", onShortcut);
    };
  });

  useEffect(() => {
    const onDocumentCommand = (event: Event) => {
      if (!(event instanceof CustomEvent) || !isNativeDocumentCommandEventDetail(event.detail)) {
        return;
      }
      if (event.detail.command === "find") {
        findInputRef.current?.focus();
        findInputRef.current?.select();
        return;
      }
      if (event.detail.command === "smart-compose") {
        smartComposeInputRef.current?.focus();
        smartComposeInputRef.current?.select();
        return;
      }
      if (event.detail.command === "copy") {
        void copyNativeDocumentSelection();
        return;
      }
      if (event.detail.command === "cut") {
        void cutNativeDocumentSelection();
        return;
      }
      if (event.detail.command === "paste") {
        void pasteNativeDocumentClipboard(false);
        return;
      }
      if (event.detail.command === "paste-plain") {
        void pasteNativeDocumentClipboard(true);
        return;
      }
      if (event.detail.command === "insert-link") {
        openInsertLinkDialog();
        return;
      }
      if (event.detail.command === "insert-image") {
        imageFileInputRef.current?.click();
        return;
      }
      if (event.detail.command === "insert-table") {
        openInsertTableDialog();
        return;
      }
      if (event.detail.command === "insert-equation") {
        openInsertEquationDialog();
        return;
      }
      if (event.detail.command === "insert-toc") {
        onInsertTableOfContents();
        return;
      }
      if (event.detail.command === "insert-bookmark") {
        onInsertBookmark();
        return;
      }
      if (event.detail.command === "insert-cross-reference") {
        openInsertCrossReferenceDialog();
        return;
      }
      if (event.detail.command === "insert-field") {
        openInsertFieldDialog();
        return;
      }
      if (event.detail.command === "open-smart-chip-picker") {
        openSmartChipDialog();
        return;
      }
      if (event.detail.command === "insert-page-break") {
        editor?.chain().focus().insertContent({ type: NATIVE_DOCUMENT_PAGE_BREAK_NODE }).run();
        return;
      }
      if (event.detail.command === "insert-footnote") {
        void insertNativeDocumentFootnote();
        return;
      }
      if (event.detail.command === "refresh-fields") {
        onRefreshFields();
        return;
      }
      void onInsertSmartChip(event.detail.kind);
    };
    window.addEventListener(NATIVE_DOCUMENT_COMMAND_EVENT, onDocumentCommand);
    return () => {
      window.removeEventListener(NATIVE_DOCUMENT_COMMAND_EVENT, onDocumentCommand);
    };
  });

  useEffect(() => {
    const root = editorWrapRef.current;
    assignNativeDocumentHeadingAnchors(root);
    setHeadingReferences(nativeDocumentCrossReferenceOptions(root));
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        assignNativeDocumentHeadingAnchors(root);
        setHeadingReferences(nativeDocumentCrossReferenceOptions(root));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [editor, session.document.id]);

  useEffect(() => {
    const onSelectAnchor = (event: Event) => {
      if (!(event instanceof CustomEvent)) {
        return;
      }
      const detail = event.detail as Partial<NativeDocumentAnchorSelectionDetail> | undefined;
      if (typeof detail?.documentId !== "string" || detail.selection === undefined) {
        return;
      }
      selectNativeDocumentAnchorRange(
        editor,
        session.document.id,
        detail as NativeDocumentAnchorSelectionDetail,
      );
    };
    window.addEventListener(NATIVE_DOCUMENT_SELECT_ANCHOR_EVENT, onSelectAnchor);
    return () => {
      window.removeEventListener(NATIVE_DOCUMENT_SELECT_ANCHOR_EVENT, onSelectAnchor);
    };
  }, [editor, session.document.id]);

  useEffect(() => {
    const root = editorWrapRef.current;
    if (root === null) {
      return;
    }
    const onReferenceClick = (event: MouseEvent) => {
      const equation = activateNativeDocumentEquationToken(root, event.target);
      if (equation !== null) {
        event.preventDefault();
        setEquationEdit(equation);
        setEquationEditText(equation.latex);
        return;
      }
      if (activateNativeDocumentReferenceToken(root, event.target)) {
        event.preventDefault();
        return;
      }
      const href = nativeDocumentSmartChipNavigationHref(event.target);
      if (href !== null) {
        event.preventDefault();
        window.location.assign(href);
      }
    };
    const onReferenceKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      const equation = activateNativeDocumentEquationToken(root, event.target);
      if (equation !== null) {
        event.preventDefault();
        setEquationEdit(equation);
        setEquationEditText(equation.latex);
        return;
      }
      if (activateNativeDocumentReferenceToken(root, event.target)) {
        event.preventDefault();
        return;
      }
      const href = nativeDocumentSmartChipNavigationHref(event.target);
      if (href !== null) {
        event.preventDefault();
        window.location.assign(href);
      }
    };
    root.addEventListener("click", onReferenceClick);
    root.addEventListener("keydown", onReferenceKeyDown);
    return () => {
      root.removeEventListener("click", onReferenceClick);
      root.removeEventListener("keydown", onReferenceKeyDown);
    };
  }, []);

  return (
    <section
      ref={editorWrapRef}
      style={EDITOR_WRAP_STYLE}
      aria-label="Document editor"
      onDragOver={onDocumentDragOver}
      onDrop={onDocumentDrop}
    >
      {unsavedChangesWarning}
      <input
        ref={imageFileInputRef}
        aria-label="Choose document image"
        type="file"
        accept="image/*,.avif,.bmp,.gif,.heic,.heif,.jfif,.jpeg,.jpg,.jpe,.png,.svg,.tif,.tiff,.webp"
        onChange={onImageFileChange}
        hidden
      />
      <span data-testid="native-document-editor-status" hidden>
        {hasRecoveredDocumentDraft
          ? "Recovered local changes"
          : providerStatus === "connected"
            ? "Live editing"
            : "Editing locally"}
      </span>
      <form
        className="native-document-editor__smart-compose"
        style={SMART_COMPOSE_STYLE}
        aria-label="Smart compose"
        onSubmit={onSmartCompose}
        onKeyDown={(event) => {
          if (event.key === "Tab" && smartComposeDraft.length > 0) {
            event.preventDefault();
            acceptSmartComposeDraft();
          }
          if (event.key === "Escape" && smartComposeDraft.length > 0) {
            event.preventDefault();
            dismissSmartComposeDraft();
          }
        }}
      >
        <Icons.Sparkles aria-hidden="true" />
        <input
          ref={smartComposeInputRef}
          id="native-document-smart-compose-prompt"
          aria-label="Smart compose prompt"
          value={smartComposePrompt}
          onChange={(event) => {
            invalidateSmartComposeRequest("Prompt changed. Compose again");
            setSmartComposePrompt(event.currentTarget.value);
            if (smartComposeDraft.length > 0) {
              setSmartComposeDraft("");
              setSmartComposeStatus("Draft cleared");
            }
          }}
          placeholder="Improve selected text"
          style={SMART_COMPOSE_INPUT_STYLE}
        />
        <button className="btn sm" type="submit" disabled={editor === null || smartComposePending}>
          {smartComposePending ? "Drafting..." : "Compose"}
        </button>
        <output style={SMART_COMPOSE_STATUS_STYLE} aria-live="polite">
          {smartComposeStatus}
        </output>
        {smartComposeDraft.length > 0 ? (
          <>
            <span
              className="native-document-editor__smart-compose-ghost"
              style={SMART_COMPOSE_GHOST_STYLE}
              aria-label="Smart compose draft"
            >
              {smartComposeDraft}
            </span>
            <button className="btn primary sm" type="button" onClick={acceptSmartComposeDraft}>
              Accept
            </button>
            <button className="btn ghost sm" type="button" onClick={dismissSmartComposeDraft}>
              Dismiss
            </button>
          </>
        ) : null}
      </form>
      <form
        className="native-document-editor__tools"
        style={FIND_REPLACE_STYLE}
        onSubmit={onFind}
        aria-label="Find and replace"
      >
        <label style={FIELD_LABEL_STYLE} htmlFor="native-document-find">
          Find
        </label>
        <input
          id="native-document-find"
          ref={findInputRef}
          value={findText}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setFindText(value);
            setMatches([]);
            setActiveMatchIndex(0);
            dispatchNativeDocumentFindDecorations(editor, [], 0);
            setFindStatus(value.length === 0 ? "No query" : "Ready");
          }}
          style={INPUT_STYLE}
        />
        <label style={FIELD_LABEL_STYLE} htmlFor="native-document-replace">
          Replace
        </label>
        <input
          id="native-document-replace"
          value={replaceText}
          onChange={(event) => setReplaceText(event.currentTarget.value)}
          style={INPUT_STYLE}
        />
        <button
          className="btn sm"
          type="submit"
          disabled={editor === null || findText.length === 0}
        >
          <Icons.Search aria-hidden="true" />
          Find
        </button>
        <button
          className="btn sm"
          type="button"
          disabled={editor === null || findText.length === 0}
          onClick={onFindPrevious}
        >
          Previous
        </button>
        <button
          className="btn sm"
          type="button"
          disabled={editor === null || findText.length === 0}
          onClick={onFindNext}
        >
          Next
        </button>
        <button
          className="btn sm"
          type="button"
          disabled={editor === null || findText.length === 0}
          onClick={onReplaceCurrent}
        >
          Replace
        </button>
        <button
          className="btn sm"
          type="button"
          disabled={editor === null || findText.length === 0}
          onClick={onReplaceAll}
        >
          Replace all
        </button>
        <output style={FIND_STATUS_STYLE} aria-live="polite">
          {findStatus}
        </output>
      </form>
      {linkDialogOpen ? (
        <form
          aria-label="Insert link"
          onSubmit={(event) => void onInsertLink(event)}
          style={LINK_FORM_STYLE}
        >
          <label style={FIELD_LABEL_STYLE} htmlFor="native-document-link-text">
            Text
          </label>
          <input
            id="native-document-link-text"
            aria-label="Link text"
            value={linkText}
            onChange={(event) => setLinkText(event.currentTarget.value)}
            style={INPUT_STYLE}
          />
          <label style={FIELD_LABEL_STYLE} htmlFor="native-document-link-href">
            Link
          </label>
          <input
            ref={linkHrefInputRef}
            id="native-document-link-href"
            aria-label="Link URL"
            value={linkHref}
            onChange={(event) => setLinkHref(event.currentTarget.value)}
            placeholder="https://example.com"
            style={INPUT_STYLE}
          />
          <button type="submit" className="btn sm">
            Apply link
          </button>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              setLinkDialogOpen(false);
              setLinkStatus("");
            }}
          >
            Cancel
          </button>
          <span role="status" style={FIND_STATUS_STYLE}>
            {linkStatus}
          </span>
        </form>
      ) : null}
      {equationDialogOpen ? (
        <form
          aria-label="Insert equation"
          onSubmit={(event) => void onInsertEquation(event)}
          style={EQUATION_FORM_STYLE}
        >
          <label style={FIELD_LABEL_STYLE} htmlFor="native-document-equation">
            Equation
          </label>
          <input
            ref={equationInputRef}
            id="native-document-equation"
            aria-label="Equation"
            value={equationText}
            onChange={(event) => setEquationText(event.currentTarget.value)}
            placeholder="E=mc^2"
            style={EQUATION_INPUT_STYLE}
          />
          <button type="submit" className="btn sm">
            Insert equation
          </button>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              setEquationDialogOpen(false);
              setEquationText("");
            }}
          >
            Cancel
          </button>
        </form>
      ) : null}
      {tableDialogOpen ? (
        <form
          aria-label="Insert table"
          onSubmit={(event) => void onInsertTable(event)}
          style={TABLE_FORM_STYLE}
        >
          <label style={FIELD_LABEL_STYLE} htmlFor="native-document-table-rows">
            Rows
          </label>
          <input
            ref={tableRowsInputRef}
            id="native-document-table-rows"
            aria-label="Table rows"
            type="number"
            min={1}
            max={12}
            value={tableRows}
            onChange={(event) => setTableRows(Number(event.currentTarget.value))}
            style={SMALL_NUMBER_INPUT_STYLE}
          />
          <label style={FIELD_LABEL_STYLE} htmlFor="native-document-table-columns">
            Columns
          </label>
          <input
            id="native-document-table-columns"
            aria-label="Table columns"
            type="number"
            min={1}
            max={12}
            value={tableColumns}
            onChange={(event) => setTableColumns(Number(event.currentTarget.value))}
            style={SMALL_NUMBER_INPUT_STYLE}
          />
          <button type="submit" className="btn sm">
            Insert table
          </button>
          <button type="button" className="btn sm ghost" onClick={() => setTableDialogOpen(false)}>
            Cancel
          </button>
        </form>
      ) : null}
      {fieldDialogOpen ? (
        <form aria-label="Insert field" onSubmit={onInsertFieldSubmit} style={FIELD_FORM_STYLE}>
          <label style={FIELD_LABEL_STYLE} htmlFor="native-document-field">
            Field
          </label>
          <select
            ref={fieldSelectRef}
            id="native-document-field"
            aria-label="Field"
            value={selectedField}
            onChange={(event) =>
              setSelectedField(
                nativeDocumentFieldKindFromValue(event.currentTarget.value) ?? "date",
              )
            }
            style={FIELD_SELECT_STYLE}
          >
            <option value="date">Date</option>
            <option value="time">Time</option>
            <option value="page">Page number</option>
            <option value="author">Author</option>
            <option value="documentTitle">Document title</option>
          </select>
          <button type="submit" className="btn sm">
            Insert field
          </button>
          <button type="button" className="btn sm ghost" onClick={() => setFieldDialogOpen(false)}>
            Cancel
          </button>
        </form>
      ) : null}
      {crossReferenceDialogOpen ? (
        <form
          aria-label="Insert cross-reference"
          onSubmit={onInsertCrossReferenceSubmit}
          style={CROSS_REFERENCE_FORM_STYLE}
        >
          <label style={FIELD_LABEL_STYLE} htmlFor="native-document-cross-reference">
            Target
          </label>
          <select
            ref={crossReferenceSelectRef}
            id="native-document-cross-reference"
            aria-label="Cross-reference target"
            value={selectedCrossReferenceId}
            onChange={(event) => setSelectedCrossReferenceId(event.currentTarget.value)}
            style={FIELD_SELECT_STYLE}
          >
            {headingReferences.length === 0 ? (
              <option value="">No headings or bookmarks</option>
            ) : (
              headingReferences.map((reference) => (
                <option key={reference.id} value={reference.id}>
                  {reference.title}
                </option>
              ))
            )}
          </select>
          <button type="submit" className="btn sm" disabled={selectedCrossReferenceId.length === 0}>
            Insert reference
          </button>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => setCrossReferenceDialogOpen(false)}
          >
            Cancel
          </button>
        </form>
      ) : null}
      {smartChipDialogOpen ? (
        <form
          aria-label="Insert smart chip"
          onSubmit={onInsertSmartChipSubmit}
          style={SMART_CHIP_FORM_STYLE}
        >
          <label style={FIELD_LABEL_STYLE} htmlFor="native-document-smart-chip-kind">
            Type
          </label>
          <select
            ref={smartChipKindSelectRef}
            id="native-document-smart-chip-kind"
            aria-label="Smart chip type"
            value={selectedSmartChipKind}
            onChange={(event) => {
              setSelectedSmartChipKind(
                nativeDocumentSmartChipKindFromValue(event.currentTarget.value) ?? "person",
              );
              setSelectedSmartChipEntityValue("");
            }}
            style={FIELD_SELECT_STYLE}
          >
            {SMART_CHIP_COMMANDS.map((chip) => (
              <option key={chip.kind} value={chip.kind}>
                {chip.label}
              </option>
            ))}
          </select>
          <label style={FIELD_LABEL_STYLE} htmlFor="native-document-smart-chip">
            Target
          </label>
          <select
            id="native-document-smart-chip"
            aria-label="Smart chip target"
            value={selectedSmartChipEntityValue}
            onChange={(event) => setSelectedSmartChipEntityValue(event.currentTarget.value)}
            style={FIELD_SELECT_STYLE}
          >
            <option value="">Current/default</option>
            {nativeDocumentSmartChipSelectOptions(
              selectedSmartChipKind,
              smartChipPickerQuery.data,
            ).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button type="submit" className="btn sm">
            Insert chip
          </button>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => setSmartChipDialogOpen(false)}
          >
            Cancel
          </button>
        </form>
      ) : null}
      {equationEdit !== null ? (
        <form
          aria-label="Edit equation"
          onSubmit={(event) => void onSaveEquationEdit(event)}
          style={EQUATION_FORM_STYLE}
        >
          <label style={FIELD_LABEL_STYLE} htmlFor="native-document-equation-edit">
            Equation
          </label>
          <input
            id="native-document-equation-edit"
            aria-label="Equation"
            value={equationEditText}
            onChange={(event) => setEquationEditText(event.currentTarget.value)}
            style={EQUATION_INPUT_STYLE}
          />
          <button type="submit" className="btn sm">
            Save equation
          </button>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              setEquationEdit(null);
              setEquationEditText("");
            }}
          >
            Cancel
          </button>
        </form>
      ) : null}
      <div
        className="native-document-editor__content-layout"
        data-column-count={String(columnCount)}
        data-show-nonprinting={showNonPrintingCharacters ? "true" : "false"}
        style={nativeDocumentContentColumnStyle(columnCount)}
      >
        <EditorContent editor={editor} />
      </div>
    </section>
  );
}

const NATIVE_DOCUMENT_IMAGE_NODE = "nativeDocumentImage";
const NATIVE_DOCUMENT_PAGE_BREAK_NODE = "nativeDocumentPageBreak";
const NATIVE_DOCUMENT_FOOTNOTE_NODE = "nativeDocumentFootnote";
const NATIVE_DOCUMENT_TABLE_NODE = "nativeDocumentTable";
const NATIVE_DOCUMENT_TABLE_ROW_NODE = "nativeDocumentTableRow";
const NATIVE_DOCUMENT_TABLE_CELL_NODE = "nativeDocumentTableCell";
const NATIVE_DOCUMENT_CHECKLIST_NODE = "nativeDocumentChecklist";
const NATIVE_DOCUMENT_CHECKLIST_ITEM_NODE = "nativeDocumentChecklistItem";
const NATIVE_DOCUMENT_TEXT_COLOR_MARK = "nativeDocumentTextColor";
const NATIVE_DOCUMENT_HIGHLIGHT_MARK = "nativeDocumentHighlight";
const NATIVE_DOCUMENT_DROPPED_IMAGE_EXTENSION =
  /\.(?:avif|bmp|gif|heic|heif|j2k|jfif|jpeg|jpg|jpe|jp2|jpf|jpm|jpx|jxl|png|svg|tif|tiff|webp)$/iu;

function createNativeDocumentPageBreakExtension() {
  return Node.create({
    name: NATIVE_DOCUMENT_PAGE_BREAK_NODE,
    group: "block",
    atom: true,
    selectable: true,
    draggable: false,
    parseHTML() {
      return [{ tag: "div[data-native-document-page-break]" }];
    },
    renderHTML({ HTMLAttributes }) {
      return [
        "div",
        mergeAttributes(HTMLAttributes, {
          "data-native-document-page-break": "true",
          role: "separator",
          "aria-label": "Page break",
          style:
            "display:flex;align-items:center;gap:12px;margin:24px 0;color:var(--text-3);font-size:12px;text-transform:uppercase;letter-spacing:.08em;page-break-after:always;break-after:page;",
        }),
        ["span", { "aria-hidden": "true", style: "height:1px;flex:1;background:var(--border);" }],
        ["span", { "aria-hidden": "true" }, "Page break"],
        ["span", { "aria-hidden": "true", style: "height:1px;flex:1;background:var(--border);" }],
      ];
    },
  });
}

function createNativeDocumentFootnoteExtension() {
  return Node.create({
    name: NATIVE_DOCUMENT_FOOTNOTE_NODE,
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,
    addAttributes() {
      return {
        number: {
          default: 1,
          parseHTML: (element: HTMLElement) => nativeDocumentFootnoteNumber(element.textContent),
          renderHTML: (attributes: Record<string, unknown>) => ({
            "data-native-document-footnote-number": String(
              nativeDocumentFootnoteNumber(attributes.number),
            ),
          }),
        },
        note: {
          default: "Footnote",
          parseHTML: (element: HTMLElement) =>
            nativeDocumentFootnoteNote(element.getAttribute("data-native-document-footnote-note")),
          renderHTML: (attributes: Record<string, unknown>) => ({
            "data-native-document-footnote-note": nativeDocumentFootnoteNote(attributes.note),
          }),
        },
      };
    },
    parseHTML() {
      return [{ tag: "sup[data-native-document-footnote]" }];
    },
    renderHTML({ HTMLAttributes }) {
      const number = nativeDocumentFootnoteNumber(
        HTMLAttributes["data-native-document-footnote-number"],
      );
      const note = nativeDocumentFootnoteNote(HTMLAttributes["data-native-document-footnote-note"]);
      return [
        "sup",
        mergeAttributes(HTMLAttributes, {
          "data-native-document-footnote": "true",
          role: "note",
          title: note,
          "aria-label": `Footnote ${String(number)}: ${note}`,
        }),
        String(number),
      ];
    },
  });
}

function createNativeDocumentTableExtensions() {
  return [
    Node.create({
      name: NATIVE_DOCUMENT_TABLE_NODE,
      group: "block",
      content: `${NATIVE_DOCUMENT_TABLE_ROW_NODE}+`,
      isolating: true,
      parseHTML() {
        return [{ tag: "table[data-native-document-table]" }];
      },
      renderHTML({ HTMLAttributes }) {
        return [
          "table",
          mergeAttributes(HTMLAttributes, {
            class: "native-document-table",
            "data-native-document-table": "true",
          }),
          ["tbody", 0],
        ];
      },
    }),
    Node.create({
      name: NATIVE_DOCUMENT_TABLE_ROW_NODE,
      content: `${NATIVE_DOCUMENT_TABLE_CELL_NODE}+`,
      parseHTML() {
        return [{ tag: "tr[data-native-document-table-row]" }, { tag: "tr" }];
      },
      renderHTML({ HTMLAttributes }) {
        return [
          "tr",
          mergeAttributes(HTMLAttributes, {
            "data-native-document-table-row": "true",
          }),
          0,
        ];
      },
    }),
    Node.create({
      name: NATIVE_DOCUMENT_TABLE_CELL_NODE,
      content: "block+",
      isolating: true,
      parseHTML() {
        return [
          { tag: "td[data-native-document-table-cell]" },
          { tag: "th[data-native-document-table-cell]" },
          { tag: "td" },
          { tag: "th" },
        ];
      },
      renderHTML({ HTMLAttributes }) {
        return [
          "td",
          mergeAttributes(HTMLAttributes, {
            class: "native-document-table__cell",
            "data-native-document-table-cell": "true",
          }),
          0,
        ];
      },
    }),
  ];
}

export function nativeDocumentTableContent(rows: number, columns: number): Content {
  const rowCount = nativeDocumentTableSize(rows);
  const columnCount = nativeDocumentTableSize(columns);
  return {
    type: NATIVE_DOCUMENT_TABLE_NODE,
    content: Array.from({ length: rowCount }, () => ({
      type: NATIVE_DOCUMENT_TABLE_ROW_NODE,
      content: Array.from({ length: columnCount }, () => ({
        type: NATIVE_DOCUMENT_TABLE_CELL_NODE,
        content: [{ type: "paragraph" }],
      })),
    })),
  };
}

function nativeDocumentTableSize(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Math.min(Math.max(Number.isFinite(parsed) ? Math.round(parsed) : 3, 1), 12);
}

interface NativeDocumentChecklistOptions {
  readonly onPersist?: (metadata: Record<string, unknown>) => void;
}

function createNativeDocumentChecklistExtensions(options: NativeDocumentChecklistOptions = {}) {
  return [
    Node.create({
      name: NATIVE_DOCUMENT_CHECKLIST_NODE,
      group: "block",
      content: `${NATIVE_DOCUMENT_CHECKLIST_ITEM_NODE}+`,
      parseHTML() {
        return [{ tag: "ul[data-native-document-checklist]" }];
      },
      renderHTML({ HTMLAttributes }) {
        return [
          "ul",
          mergeAttributes(HTMLAttributes, {
            class: "native-document-checklist",
            "data-native-document-checklist": "true",
          }),
          0,
        ];
      },
      addCommands() {
        return {
          toggleNativeChecklist:
            () =>
            ({ commands, state }) => {
              const { from, to, empty } = state.selection;
              const selectedText = empty ? "" : state.doc.textBetween(from, to, "\n").trim();
              const content = nativeDocumentChecklistContent(selectedText);
              return empty
                ? commands.insertContent(content)
                : commands.insertContentAt({ from, to }, content);
            },
        };
      },
    }),
    Node.create({
      name: NATIVE_DOCUMENT_CHECKLIST_ITEM_NODE,
      content: "paragraph block*",
      defining: true,
      addAttributes() {
        return {
          checked: {
            default: false,
            parseHTML: (element: HTMLElement) =>
              element.getAttribute("data-checked") === "true" ||
              element.querySelector("input[type='checkbox']")?.hasAttribute("checked") === true,
            renderHTML: (attributes: Record<string, unknown>) => ({
              "data-checked": attributes.checked === true ? "true" : "false",
            }),
          },
        };
      },
      parseHTML() {
        return [{ tag: "li[data-native-document-checklist-item]" }];
      },
      renderHTML({ HTMLAttributes, node }) {
        const checked = node.attrs.checked === true;
        return [
          "li",
          mergeAttributes(HTMLAttributes, {
            class: "native-document-checklist__item",
            "data-native-document-checklist-item": "true",
            "data-checked": checked ? "true" : "false",
          }),
          [
            "label",
            {
              class: "native-document-checklist__control",
              contenteditable: "false",
            },
            [
              "input",
              {
                type: "checkbox",
                ...(checked ? { checked: "checked" } : {}),
                "aria-label": checked
                  ? "Mark checklist item incomplete"
                  : "Mark checklist item complete",
              },
            ],
          ],
          ["div", { class: "native-document-checklist__content" }, 0],
        ];
      },
      addNodeView() {
        return ({ editor, getPos, node }) => {
          const item = document.createElement("li");
          item.className = "native-document-checklist__item";
          item.dataset.nativeDocumentChecklistItem = "true";
          item.dataset.checked = node.attrs.checked === true ? "true" : "false";

          const label = document.createElement("label");
          label.className = "native-document-checklist__control";
          label.contentEditable = "false";

          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = node.attrs.checked === true;
          checkbox.setAttribute(
            "aria-label",
            checkbox.checked ? "Mark checklist item incomplete" : "Mark checklist item complete",
          );
          checkbox.addEventListener("change", () => {
            const position = typeof getPos === "function" ? getPos() : null;
            if (typeof position !== "number") {
              return;
            }
            item.dataset.checked = checkbox.checked ? "true" : "false";
            checkbox.setAttribute(
              "aria-label",
              checkbox.checked ? "Mark checklist item incomplete" : "Mark checklist item complete",
            );
            editor.view.dispatch(
              editor.state.tr.setNodeMarkup(position, undefined, {
                ...node.attrs,
                checked: checkbox.checked,
              }),
            );
            options.onPersist?.({
              source: "web.native-document-editor.toggle-checklist-item",
              checked: checkbox.checked,
            });
          });
          label.append(checkbox);

          const content = document.createElement("div");
          content.className = "native-document-checklist__content";
          item.append(label, content);

          return {
            dom: item,
            contentDOM: content,
            update(updatedNode) {
              if (updatedNode.type.name !== NATIVE_DOCUMENT_CHECKLIST_ITEM_NODE) {
                return false;
              }
              const checked = updatedNode.attrs.checked === true;
              item.dataset.checked = checked ? "true" : "false";
              checkbox.checked = checked;
              checkbox.setAttribute(
                "aria-label",
                checked ? "Mark checklist item incomplete" : "Mark checklist item complete",
              );
              return true;
            },
          };
        };
      },
    }),
  ];
}

export function nativeDocumentChecklistContent(text = ""): Content {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const items = lines.length === 0 ? [""] : lines;
  return {
    type: NATIVE_DOCUMENT_CHECKLIST_NODE,
    content: items.map((line) => ({
      type: NATIVE_DOCUMENT_CHECKLIST_ITEM_NODE,
      attrs: { checked: false },
      content: [
        {
          type: "paragraph",
          content: line.length === 0 ? undefined : [{ type: "text", text: line }],
        },
      ],
    })),
  };
}

function createNativeDocumentTextColorExtension() {
  return Mark.create({
    name: NATIVE_DOCUMENT_TEXT_COLOR_MARK,
    addAttributes() {
      return {
        color: {
          default: null,
          parseHTML: (element: HTMLElement) =>
            element.getAttribute("data-native-text-color") ?? element.style.color,
          renderHTML: (attributes: Record<string, unknown>) => {
            const color =
              typeof attributes.color === "string" && isNativeDocumentHexColor(attributes.color)
                ? attributes.color.toLowerCase()
                : null;
            return color === null
              ? {}
              : { "data-native-text-color": color, style: `color: ${color}` };
          },
        },
      };
    },
    parseHTML() {
      return [{ tag: "span[data-native-text-color]" }, { style: "color" }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["span", mergeAttributes(HTMLAttributes), 0];
    },
    addCommands() {
      return {
        setNativeTextColor:
          (color: string) =>
          ({ commands }) =>
            isNativeDocumentHexColor(color)
              ? commands.setMark(this.name, { color: color.toLowerCase() })
              : false,
        unsetNativeTextColor:
          () =>
          ({ commands }) =>
            commands.unsetMark(this.name),
      };
    },
  });
}

function createNativeDocumentHighlightExtension() {
  return Mark.create({
    name: NATIVE_DOCUMENT_HIGHLIGHT_MARK,
    addAttributes() {
      return {
        color: {
          default: null,
          parseHTML: (element: HTMLElement) =>
            element.getAttribute("data-native-highlight-color") ?? element.style.backgroundColor,
          renderHTML: (attributes: Record<string, unknown>) => {
            const color =
              typeof attributes.color === "string" && isNativeDocumentHexColor(attributes.color)
                ? attributes.color.toLowerCase()
                : null;
            return color === null
              ? {}
              : {
                  "data-native-highlight-color": color,
                  style: `background-color: ${color}`,
                };
          },
        },
      };
    },
    parseHTML() {
      return [{ tag: "span[data-native-highlight-color]" }, { style: "background-color" }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["span", mergeAttributes(HTMLAttributes), 0];
    },
    addCommands() {
      return {
        setNativeHighlightColor:
          (color: string) =>
          ({ commands }) =>
            isNativeDocumentHexColor(color)
              ? commands.setMark(this.name, { color: color.toLowerCase() })
              : false,
        unsetNativeHighlightColor:
          () =>
          ({ commands }) =>
            commands.unsetMark(this.name),
      };
    },
  });
}

function createNativeDocumentTextAlignExtension() {
  return Extension.create({
    name: "nativeDocumentTextAlign",
    addGlobalAttributes() {
      return [
        {
          types: ["paragraph", "heading"],
          attributes: {
            textAlign: {
              default: null,
              parseHTML: (element: HTMLElement) => nativeDocumentTextAlign(element.style.textAlign),
              renderHTML: (attributes: Record<string, unknown>) => {
                const align = nativeDocumentTextAlign(attributes.textAlign);
                return align === null ? {} : { style: `text-align: ${align}` };
              },
            },
          },
        },
      ];
    },
    addCommands() {
      return {
        setNativeTextAlign:
          (align: NativeDocumentTextAlign) =>
          ({ dispatch, state, tr }) => {
            const normalized = nativeDocumentTextAlign(align);
            if (normalized === null) {
              return false;
            }
            const { from, to } = state.selection;
            let changed = false;
            state.doc.nodesBetween(from, to, (node, pos) => {
              if (node.isTextblock && nativeDocumentTextAlignNodeName(node.type.name)) {
                tr.setNodeMarkup(pos, undefined, {
                  ...node.attrs,
                  textAlign: normalized === "left" ? null : normalized,
                });
                changed = true;
              }
            });
            if (!changed) {
              const depth = state.selection.$from.depth;
              const node = state.selection.$from.node(depth);
              if (
                depth > 0 &&
                node.isTextblock &&
                nativeDocumentTextAlignNodeName(node.type.name)
              ) {
                tr.setNodeMarkup(state.selection.$from.before(depth), undefined, {
                  ...node.attrs,
                  textAlign: normalized === "left" ? null : normalized,
                });
                changed = true;
              }
            }
            if (changed) {
              dispatch?.(tr);
            }
            return changed;
          },
      };
    },
  });
}

function nativeDocumentTextAlign(value: unknown): NativeDocumentTextAlign | null {
  return value === "left" || value === "center" || value === "right" || value === "justify"
    ? value
    : null;
}

function nativeDocumentTextAlignNodeName(name: string): boolean {
  return name === "paragraph" || name === "heading";
}

function isNativeDocumentHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/u.test(value);
}
const NATIVE_DOCUMENT_IMAGE_MIN_WIDTH_PERCENT = 20;
const NATIVE_DOCUMENT_IMAGE_MAX_WIDTH_PERCENT = 100;

interface NativeDocumentImageExtensionOptions {
  readonly onPersist: (metadata: Record<string, unknown>) => void;
}

function createNativeDocumentImageExtension(options: NativeDocumentImageExtensionOptions) {
  return Node.create({
    name: NATIVE_DOCUMENT_IMAGE_NODE,
    group: "block",
    atom: true,
    draggable: true,
    selectable: true,
    addAttributes() {
      return {
        src: { default: null },
        alt: { default: "" },
        title: { default: "" },
        widthPercent: {
          default: 80,
          parseHTML: (element) =>
            nativeDocumentImageWidthPercent(element.getAttribute("data-width-percent")),
          renderHTML: (attributes) => ({
            "data-width-percent": String(nativeDocumentImageWidthPercent(attributes.widthPercent)),
          }),
        },
        caption: {
          default: "",
          parseHTML: (element) => element.getAttribute("data-caption") ?? "",
          renderHTML: (attributes) => {
            const caption = typeof attributes.caption === "string" ? attributes.caption : "";
            return caption.trim().length > 0 ? { "data-caption": caption } : {};
          },
        },
      };
    },
    parseHTML() {
      return [
        { tag: "figure[data-native-document-image-frame] img[data-native-document-image][src]" },
        { tag: "img[data-native-document-image][src]" },
      ];
    },
    renderHTML({ HTMLAttributes }) {
      const caption =
        typeof HTMLAttributes.caption === "string" ? HTMLAttributes.caption.trim() : "";
      return [
        "figure",
        {
          class: "native-document-image-frame",
          "data-native-document-image-frame": "true",
        },
        [
          "img",
          mergeAttributes(HTMLAttributes, {
            class: "native-document-image",
            "data-native-document-image": "true",
            style: `width: ${String(nativeDocumentImageWidthPercent(HTMLAttributes.widthPercent))}%;`,
          }),
        ],
        caption.length > 0
          ? ["figcaption", { class: "native-document-image-caption" }, caption]
          : "",
      ];
    },
    addNodeView() {
      return (props) => createNativeDocumentImageNodeView(props, options);
    },
  });
}

function createNativeDocumentImageNodeView(
  props: NodeViewRendererProps,
  options: NativeDocumentImageExtensionOptions,
): NodeView {
  const { node, view, getPos } = props;
  const figure = document.createElement("figure");
  const image = document.createElement("img");
  const resizeHandle = document.createElement("button");
  const caption = document.createElement("input");

  figure.className = "native-document-image-frame";
  figure.dataset.nativeDocumentImageFrame = "true";
  figure.setAttribute("contenteditable", "false");
  image.className = "native-document-image";
  image.dataset.nativeDocumentImage = "true";
  image.draggable = false;
  resizeHandle.type = "button";
  resizeHandle.className = "native-document-image-resize-handle";
  resizeHandle.setAttribute("aria-label", "Resize document image");
  resizeHandle.title = "Resize";
  caption.className = "native-document-image-caption-input";
  caption.setAttribute("aria-label", "Image caption");
  caption.name = "native-document-image-caption";

  figure.append(image, resizeHandle, caption);

  let currentNode = node;

  const render = (nextNode: ProseMirrorNode) => {
    currentNode = nextNode;
    const attrs = nativeDocumentImageAttrs(nextNode);
    image.src = attrs.src;
    image.alt = attrs.alt;
    image.title = attrs.title;
    image.style.width = `${String(attrs.widthPercent)}%`;
    caption.value = attrs.caption;
    caption.placeholder = attrs.alt.length > 0 ? `Caption for ${attrs.alt}` : "Add caption";
  };

  const commitAttrs = (patch: Partial<NativeDocumentImageAttrs>) => {
    updateNativeDocumentImageNodeAttrs(view, getPos, currentNode, patch);
    queueMicrotask(() => {
      options.onPersist({
        source: "web.native-document-editor.image-object",
        ...(patch.widthPercent === undefined ? {} : { widthPercent: patch.widthPercent }),
        ...(patch.caption === undefined ? {} : { captionLength: patch.caption.trim().length }),
      });
    });
  };

  resizeHandle.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const parentWidth = figure.parentElement?.getBoundingClientRect().width ?? 0;
    if (parentWidth <= 0) {
      return;
    }
    const startX = event.clientX;
    const startWidth = nativeDocumentImageAttrs(currentNode).widthPercent;

    const handleMove = (moveEvent: MouseEvent) => {
      const nextWidth = nativeDocumentImageWidthPercent(
        startWidth + ((moveEvent.clientX - startX) / parentWidth) * 100,
      );
      image.style.width = `${String(nextWidth)}%`;
    };

    const handleUp = (upEvent: MouseEvent) => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      const nextWidth = nativeDocumentImageWidthPercent(
        startWidth + ((upEvent.clientX - startX) / parentWidth) * 100,
      );
      if (nextWidth !== nativeDocumentImageAttrs(currentNode).widthPercent) {
        commitAttrs({ widthPercent: nextWidth });
      }
    };

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  });

  caption.addEventListener("blur", () => {
    const nextCaption = caption.value.trim();
    if (nextCaption !== nativeDocumentImageAttrs(currentNode).caption) {
      commitAttrs({ caption: nextCaption });
    }
  });
  caption.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    caption.blur();
  });

  render(node);

  return {
    dom: figure,
    update(nextNode) {
      if (nextNode.type.name !== NATIVE_DOCUMENT_IMAGE_NODE) {
        return false;
      }
      render(nextNode);
      return true;
    },
    stopEvent(event) {
      return event.target instanceof globalThis.Node && figure.contains(event.target);
    },
    ignoreMutation() {
      return true;
    },
  };
}

interface NativeDocumentImageAttrs {
  readonly src: string;
  readonly alt: string;
  readonly title: string;
  readonly widthPercent: number;
  readonly caption: string;
}

function nativeDocumentImageAttrs(node: ProseMirrorNode): NativeDocumentImageAttrs {
  return {
    src: typeof node.attrs.src === "string" ? node.attrs.src : "",
    alt: typeof node.attrs.alt === "string" ? node.attrs.alt : "",
    title: typeof node.attrs.title === "string" ? node.attrs.title : "",
    widthPercent: nativeDocumentImageWidthPercent(node.attrs.widthPercent),
    caption: typeof node.attrs.caption === "string" ? node.attrs.caption.trim() : "",
  };
}

function updateNativeDocumentImageNodeAttrs(
  view: EditorView,
  getPos: NodeViewRendererProps["getPos"],
  node: ProseMirrorNode,
  patch: Partial<NativeDocumentImageAttrs>,
): void {
  if (typeof getPos !== "function") {
    return;
  }
  const pos = getPos();
  if (typeof pos !== "number") {
    return;
  }
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch }));
}

export function nativeDocumentImageWidthPercent(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Math.round(
    Math.min(
      Math.max(Number.isFinite(parsed) ? parsed : 80, NATIVE_DOCUMENT_IMAGE_MIN_WIDTH_PERCENT),
      NATIVE_DOCUMENT_IMAGE_MAX_WIDTH_PERCENT,
    ),
  );
}

function droppedNativeDocumentImageFile(dataTransfer: DataTransfer): File | undefined {
  for (let index = 0; index < dataTransfer.items.length; index += 1) {
    const item = dataTransfer.items[index];
    if (item?.kind !== "file") {
      continue;
    }
    const file = item.getAsFile();
    if (file !== null && isNativeDocumentImageFile(file)) {
      return file;
    }
  }
  for (let index = 0; index < dataTransfer.files.length; index += 1) {
    const file = dataTransfer.files.item(index);
    if (file !== null && isNativeDocumentImageFile(file)) {
      return file;
    }
  }
  return undefined;
}

function isNativeDocumentImageFile(file: File): boolean {
  const mimeType = file.type.trim().toLowerCase();
  return mimeType.startsWith("image/") || NATIVE_DOCUMENT_DROPPED_IMAGE_EXTENSION.test(file.name);
}

function hasDroppedNativeDocumentText(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).some(
    (type) => type === "text/plain" || type === "text/uri-list" || type === "text/html",
  );
}

function droppedNativeDocumentText(dataTransfer: DataTransfer): string {
  const plainText = safeDataTransferText(dataTransfer, "text/plain");
  if (plainText.trim().length > 0) {
    return plainText;
  }
  const uriList = firstDroppedUri(safeDataTransferText(dataTransfer, "text/uri-list"));
  if (uriList.length > 0) {
    return uriList;
  }
  const html = safeDataTransferText(dataTransfer, "text/html");
  return html.trim().length > 0 ? textFromDroppedHtml(html) : "";
}

function droppedNativeDocumentHref(dataTransfer: DataTransfer): string | null {
  const uriList = safeNativeDocumentHref(
    firstDroppedUri(safeDataTransferText(dataTransfer, "text/uri-list")),
  );
  if (uriList !== null) {
    return uriList;
  }
  const htmlHref = safeNativeDocumentHref(
    hrefFromDroppedNativeDocumentHtml(safeDataTransferText(dataTransfer, "text/html")),
  );
  if (htmlHref !== null) {
    return htmlHref;
  }
  return safeNativeDocumentHref(safeDataTransferText(dataTransfer, "text/plain"));
}

function safeDataTransferText(dataTransfer: DataTransfer, type: string): string {
  try {
    return dataTransfer.getData(type);
  } catch {
    return "";
  }
}

function firstDroppedUri(uriList: string): string {
  return (
    uriList
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#")) ?? ""
  );
}

function textFromDroppedHtml(html: string): string {
  try {
    return new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
  } catch {
    return html.replace(/<[^>]*>/gu, " ");
  }
}

function hrefFromDroppedNativeDocumentHtml(html: string): string | null {
  if (html.trim().length === 0) {
    return null;
  }
  try {
    return (
      new DOMParser()
        .parseFromString(html, "text/html")
        .querySelector<HTMLAnchorElement>("a[href]")
        ?.getAttribute("href") ?? null
    );
  } catch {
    return null;
  }
}

function normalizedDroppedNativeDocumentText(text: string): string {
  return text
    .replaceAll("\u0000", "")
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .trim()
    .slice(0, 10_000);
}

function nativeDocumentDroppedTextContent(text: string, droppedHref: string | null): Content {
  const href = droppedHref ?? hrefForNativeDocumentDroppedText(text);
  if (href === null) {
    return text;
  }
  return {
    type: "text",
    text,
    marks: [
      {
        type: NATIVE_DOCUMENT_LINK_MARK,
        attrs: { href },
      },
    ],
  };
}

function hrefForNativeDocumentDroppedText(text: string): string | null {
  return safeNativeDocumentHref(text.trim());
}

interface NativeDocumentDroppedSmartChip {
  readonly kind: Extract<NativeDocumentSmartChipKind, "doc" | "file">;
  readonly id: string;
  readonly label: string;
  readonly href: string;
}

function nativeDocumentDroppedSmartChip(
  href: string | null,
  fallbackText: string,
  pickerData:
    | {
        readonly documents: readonly { readonly id: string; readonly label: string }[];
        readonly files?: readonly { readonly id: string; readonly label: string }[];
      }
    | undefined,
): NativeDocumentDroppedSmartChip | null {
  if (href === null) {
    return null;
  }
  const target = nativeDocumentInternalUrlTarget(href);
  if (target === null) {
    return null;
  }
  const labelText =
    fallbackText.length > 0 && safeNativeDocumentHref(fallbackText) === null
      ? fallbackText
      : undefined;
  if (target.kind === "doc") {
    const label =
      pickerData?.documents.find((document) => document.id === target.id)?.label ??
      labelText ??
      "Document";
    return { kind: "doc", id: target.id, label, href };
  }
  const label =
    pickerData?.files?.find((file) => file.id === target.id)?.label ??
    labelText ??
    target.fallbackLabel;
  return { kind: "file", id: target.id, label, href };
}

function nativeDocumentInternalUrlTarget(href: string):
  | { readonly kind: "doc"; readonly id: string }
  | {
      readonly kind: "file";
      readonly id: string;
      readonly fallbackLabel: string;
    }
  | null {
  let url: URL;
  try {
    url = new URL(href, nativeDocumentUrlBase());
  } catch {
    return null;
  }
  if (!isHelixInternalDroppedUrl(url)) {
    return null;
  }
  const pathParts = url.pathname.split("/").filter((part) => part.length > 0);
  if (pathParts[0] === "docs" && pathParts[1] !== undefined) {
    return { kind: "doc", id: nativeDocumentChipIdValue(decodeURIComponent(pathParts[1])) };
  }
  if (pathParts[0] === "sheets") {
    const sheetId = url.searchParams.get("sheet");
    return sheetId === null
      ? null
      : {
          kind: "file",
          id: nativeDocumentChipIdValue(sheetId),
          fallbackLabel: "Spreadsheet",
        };
  }
  if (pathParts[0] === "slides") {
    const deckId = url.searchParams.get("deck");
    return deckId === null
      ? null
      : {
          kind: "file",
          id: nativeDocumentChipIdValue(deckId),
          fallbackLabel: "Presentation",
        };
  }
  if (
    (pathParts[0] === "open" || pathParts[0] === "pdf" || pathParts[0] === "media") &&
    pathParts[1] !== undefined
  ) {
    return {
      kind: "file",
      id: nativeDocumentChipIdValue(decodeURIComponent(pathParts[1])),
      fallbackLabel: "File",
    };
  }
  return null;
}

function isHelixInternalDroppedUrl(url: URL): boolean {
  if (typeof globalThis.location !== "undefined" && url.origin === globalThis.location.origin) {
    return true;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1")
  );
}

function nativeDocumentUrlBase(): string {
  const href = globalThis.location?.href;
  return href !== undefined && /^https?:/iu.test(href) ? href : "http://localhost";
}

function safeNativeDocumentHref(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const href = value.trim();
  if (href.length === 0 || /\s/u.test(href)) {
    return null;
  }
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function nativeDocumentDropPosition(
  editor: Editor,
  event: ReactDragEvent<HTMLElement>,
): number | undefined {
  if (typeof editor.view.posAtCoords !== "function") {
    return undefined;
  }
  const position = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
  return position?.pos;
}

function nativeDocumentImageAltFromFilename(filename: string): string {
  const name = filename
    .trim()
    .replace(/\.[^.]+$/u, "")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return name.length > 0 ? name : "Document image";
}

function base64FromUint8Array(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
}

interface StoredNativeDocumentRecovery {
  readonly documentId: string;
  readonly stateBase64: string;
  readonly stateVectorBase64: string;
  readonly savedAt: string;
}

interface NativeDocumentRecoveryUpdate {
  readonly update: Uint8Array;
  readonly stateVectorBase64: string;
}

function readRecoveredNativeDocumentState(
  documentId: string,
  serverStateVectorBase64: string | null,
): NativeDocumentRecoveryUpdate | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(recoveredNativeDocumentKey(documentId));
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredNativeDocumentRecovery(parsed) || parsed.documentId !== documentId) {
      removeRecoveredNativeDocumentState(documentId);
      return null;
    }
    if (serverStateVectorBase64 !== null && parsed.stateVectorBase64 === serverStateVectorBase64) {
      removeRecoveredNativeDocumentState(documentId);
      return null;
    }
    const update = uint8ArrayFromBase64(parsed.stateBase64);
    if (update === null || update.byteLength === 0) {
      removeRecoveredNativeDocumentState(documentId);
      return null;
    }
    return { update, stateVectorBase64: parsed.stateVectorBase64 };
  } catch {
    removeRecoveredNativeDocumentState(documentId);
    return null;
  }
}

function writeRecoveredNativeDocumentState(documentId: string, doc: Y.Doc): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      recoveredNativeDocumentKey(documentId),
      JSON.stringify({
        documentId,
        stateBase64: base64FromUint8Array(Y.encodeStateAsUpdate(doc)),
        stateVectorBase64: base64FromUint8Array(Y.encodeStateVector(doc)),
        savedAt: new Date().toISOString(),
      } satisfies StoredNativeDocumentRecovery),
    );
  } catch {
    // Local recovery is best-effort; Yjs realtime remains the authoritative save path.
  }
}

function removeRecoveredNativeDocumentState(documentId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(recoveredNativeDocumentKey(documentId));
  } catch {
    // Ignore storage failures; stale local recovery should never block rendering.
  }
}

function recoveredNativeDocumentKey(documentId: string): string {
  return `${DOCS_YJS_RECOVERY_PREFIX}.${documentId}`;
}

function isStoredNativeDocumentRecovery(value: unknown): value is StoredNativeDocumentRecovery {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<StoredNativeDocumentRecovery>;
  return (
    typeof record.documentId === "string" &&
    typeof record.stateBase64 === "string" &&
    typeof record.stateVectorBase64 === "string" &&
    typeof record.savedAt === "string"
  );
}

function uint8ArrayFromBase64(value: string): Uint8Array | null {
  try {
    const binary = globalThis.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function selectionAnchorFromEditor(editor: {
  readonly state: {
    readonly selection: {
      readonly from: number;
      readonly to: number;
      readonly empty: boolean;
    };
    readonly doc: {
      textBetween(from: number, to: number, blockSeparator?: string): string;
    };
  };
}): NativeDocumentSelectionAnchor | null {
  const { from, to, empty } = editor.state.selection;
  if (empty || to <= from) {
    return null;
  }
  const text = editor.state.doc.textBetween(from, to, " ").trim();
  return text.length === 0 ? null : { from, to, text };
}

function selectedNativeDocumentText(editor: NativeDocumentSelectionEditorLike): string {
  const { from, to, empty } = editor.state.selection;
  if (empty || to <= from) {
    return "";
  }
  return editor.state.doc.textBetween(from, to, " ").replace(/\s+/gu, " ").trim();
}

// FORMAT_COMMANDS has moved to the unified chrome ribbon/menu bar in `native-document-chrome.tsx`.

const FIELD_COMMANDS = [
  { kind: "date", label: "Date" },
  { kind: "time", label: "Time" },
  { kind: "page", label: "Page #" },
  { kind: "author", label: "Author" },
  { kind: "documentTitle", label: "Document title" },
] satisfies ReadonlyArray<{
  readonly kind: NativeDocumentFieldKind;
  readonly label: string;
}>;

const SMART_CHIP_COMMANDS = [
  { kind: "person", label: "@person" },
  { kind: "doc", label: "@doc" },
  { kind: "file", label: "@file" },
  { kind: "event", label: "@event" },
] satisfies ReadonlyArray<{
  readonly kind: NativeDocumentSmartChipKind;
  readonly label: string;
}>;

function nativeDocumentFieldKindFromValue(value: string): NativeDocumentFieldKind | null {
  return FIELD_COMMANDS.some((field) => field.kind === value)
    ? (value as NativeDocumentFieldKind)
    : null;
}

function nativeDocumentSmartChipKindFromValue(value: string): NativeDocumentSmartChipKind | null {
  return SMART_CHIP_COMMANDS.some((chip) => chip.kind === value)
    ? (value as NativeDocumentSmartChipKind)
    : null;
}

function nativeDocumentSmartChipSelectOptions(
  kind: NativeDocumentSmartChipKind,
  pickerData:
    | {
        readonly people: readonly { readonly id: string; readonly label: string }[];
        readonly documents: readonly { readonly id: string; readonly label: string }[];
        readonly files?: readonly { readonly id: string; readonly label: string }[];
        readonly events: readonly { readonly id: string; readonly label: string }[];
      }
    | undefined,
): readonly { readonly value: string; readonly label: string }[] {
  const options =
    kind === "person"
      ? pickerData?.people
      : kind === "doc"
        ? pickerData?.documents
        : kind === "file"
          ? pickerData?.files
          : pickerData?.events;
  return (options ?? []).map((option) => ({
    value: `${kind}:${option.id}`,
    label: option.label,
  }));
}

function nativeDocumentSmartChipEntityFromSelectValue(
  value: string,
  pickerData:
    | {
        readonly people: readonly { readonly id: string; readonly label: string }[];
        readonly documents: readonly { readonly id: string; readonly label: string }[];
        readonly files?: readonly { readonly id: string; readonly label: string }[];
        readonly events: readonly { readonly id: string; readonly label: string }[];
      }
    | undefined,
): NativeDocumentSmartChipEntity | null {
  const [kind, id] = value.split(":", 2);
  if (
    (kind !== "person" && kind !== "doc" && kind !== "file" && kind !== "event") ||
    id === undefined ||
    id.length === 0
  ) {
    return null;
  }
  const options =
    kind === "person"
      ? pickerData?.people
      : kind === "doc"
        ? pickerData?.documents
        : kind === "file"
          ? pickerData?.files
          : pickerData?.events;
  const option = options?.find((candidate) => candidate.id === id);
  if (option === undefined) {
    return null;
  }
  return { kind, id: option.id, label: option.label };
}

function isNativeDocumentCommandEventDetail(
  value: unknown,
): value is NativeDocumentCommandEventDetail {
  if (typeof value !== "object" || value === null || !("command" in value)) {
    return false;
  }
  const command = (value as { readonly command?: unknown }).command;
  if (
    command === "find" ||
    command === "smart-compose" ||
    command === "cut" ||
    command === "copy" ||
    command === "paste" ||
    command === "paste-plain" ||
    command === "insert-link" ||
    command === "insert-image" ||
    command === "insert-table" ||
    command === "insert-equation" ||
    command === "insert-toc" ||
    command === "insert-bookmark" ||
    command === "insert-cross-reference" ||
    command === "insert-field" ||
    command === "open-smart-chip-picker" ||
    command === "insert-page-break" ||
    command === "insert-footnote" ||
    command === "refresh-fields"
  ) {
    return true;
  }
  if (command !== "insert-smart-chip") {
    return false;
  }
  return (
    nativeDocumentSmartChipKindFromValue((value as { readonly kind?: string }).kind ?? "") !== null
  );
}

export function nativeDocumentFieldInsertionText(
  field: NativeDocumentFieldKind,
  input: {
    readonly actorName?: string | null | undefined;
    readonly documentTitle?: string | null | undefined;
    readonly now?: Date | undefined;
  } = {},
): string {
  const now = input.now ?? new Date();
  switch (field) {
    case "date":
      return `{{DATE ${formatNativeDocumentFieldDate(now)}}}`;
    case "time":
      return `{{TIME ${formatNativeDocumentFieldTime(now)}}}`;
    case "page":
      return "{{PAGE}}";
    case "author":
      return `{{AUTHOR ${nativeDocumentFieldTokenValue(input.actorName, "Unknown author")}}}`;
    case "documentTitle":
      return `{{PROPERTY title="${nativeDocumentFieldTokenValue(
        input.documentTitle,
        "Untitled document",
      )}"}}`;
  }
}

function formatNativeDocumentFieldDate(value: Date): string {
  return validNativeDocumentFieldDate(value).toISOString().slice(0, 10);
}

function formatNativeDocumentFieldTime(value: Date): string {
  return `${validNativeDocumentFieldDate(value).toISOString().slice(11, 16)} UTC`;
}

function validNativeDocumentFieldDate(value: Date): Date {
  return Number.isNaN(value.getTime()) ? new Date(0) : value;
}

function nativeDocumentFieldTokenValue(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .replace(/["{}\r\n]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length === 0 ? fallback : normalized;
}

export function nativeDocumentEquationInsertionText(value: string): string {
  return `{{EQUATION latex="${nativeDocumentFieldTokenValue(value, "x")}"}}`;
}

export function nativeDocumentSmartChipInsertionText(
  kind: NativeDocumentSmartChipKind,
  input: {
    readonly actorId?: string | null | undefined;
    readonly actorName?: string | null | undefined;
    readonly documentId?: string | null | undefined;
    readonly documentTitle?: string | null | undefined;
    readonly fileId?: string | null | undefined;
    readonly fileTitle?: string | null | undefined;
    readonly href?: string | null | undefined;
    readonly eventId?: string | null | undefined;
    readonly eventTitle?: string | null | undefined;
  } = {},
): string {
  switch (kind) {
    case "person":
      return nativeDocumentSmartChipToken({
        kind,
        label: nativeDocumentFieldTokenValue(input.actorName, "Unknown person"),
        id: input.actorId,
      });
    case "doc":
      return nativeDocumentSmartChipToken({
        kind,
        label: nativeDocumentFieldTokenValue(input.documentTitle, "Untitled document"),
        id: input.documentId,
        href: input.href ?? (input.documentId == null ? undefined : `/docs/${input.documentId}`),
      });
    case "file":
      return nativeDocumentSmartChipToken({
        kind,
        label: nativeDocumentFieldTokenValue(input.fileTitle, "File"),
        id: input.fileId,
        href: input.href ?? (input.fileId == null ? undefined : `/open/${input.fileId}`),
      });
    case "event":
      return nativeDocumentSmartChipToken({
        kind,
        label: nativeDocumentFieldTokenValue(input.eventTitle, "Event"),
        id: input.eventId,
      });
  }
}

function nativeDocumentSmartChipToken(input: {
  readonly kind: NativeDocumentSmartChipKind;
  readonly label: string;
  readonly id?: string | null | undefined;
  readonly href?: string | null | undefined;
}): string {
  const id = nativeDocumentChipIdValue(input.id);
  const idAttribute = id.length === 0 ? "" : ` id="${id}"`;
  const href = nativeDocumentChipHrefValue(input.href);
  const hrefAttribute = href.length === 0 ? "" : ` href="${href}"`;
  return `{{CHIP ${input.kind} label="${input.label}"${idAttribute}${hrefAttribute}}}`;
}

function nativeDocumentChipIdValue(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/["{}\r\n]/gu, " ")
    .replace(/\s+/gu, "-")
    .replace(/[^A-Za-z0-9_:.@/-]/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function nativeDocumentChipHrefValue(value: string | null | undefined): string {
  const href = value?.trim() ?? "";
  if (href.length === 0 || /["{}\r\n]/u.test(href)) {
    return "";
  }
  return nativeDocumentSmartChipNavigationTarget(href) === null ? "" : href;
}

function nativeDocumentContentColumnStyle(columnCount: 1 | 2): CSSProperties {
  return columnCount === 2 ? EDITOR_CONTENT_TWO_COLUMN_STYLE : EDITOR_CONTENT_SINGLE_COLUMN_STYLE;
}

async function writeNativeDocumentPlainClipboardText(text: string): Promise<void> {
  if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
    return;
  }
  await navigator.clipboard.writeText(text);
}

async function readNativeDocumentPlainClipboardText(): Promise<string> {
  if (
    typeof navigator === "undefined" ||
    navigator.clipboard === undefined ||
    typeof navigator.clipboard.readText !== "function"
  ) {
    return "";
  }
  return navigator.clipboard.readText();
}

function nativeDocumentSelectedPlainText(editor: Editor): string {
  const selection = editor.state.selection;
  if (!selection.empty) {
    return editor.state.doc.textBetween(selection.from, selection.to, "\n");
  }
  return window.getSelection()?.toString() ?? "";
}

function deleteNativeDocumentDomSelection(editor: Editor): boolean {
  if (typeof editor.view.focus === "function") {
    editor.view.focus();
  }
  if (typeof document.execCommand !== "function") {
    return false;
  }
  return document.execCommand("delete");
}

function nextNativeDocumentFootnoteNumber(editor: Editor): number {
  const dom = (editor.view as { readonly dom?: ParentNode }).dom;
  const count = dom?.querySelectorAll?.("[data-native-document-footnote]").length ?? 0;
  return count + 1;
}

function nativeDocumentFootnoteNumber(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function nativeDocumentFootnoteNote(value: unknown): string {
  const note = typeof value === "string" ? value.trim() : "";
  return note.length > 0 ? note : "Footnote";
}

// Formatting command helpers were removed when the toolbar moved to the unified chrome.
// The chrome (see `native-document-chrome.tsx`) calls the editor's chain APIs directly.

export function findNativeDocumentTextMatches(
  doc: ProseMirrorDocLike,
  query: string,
): readonly NativeDocumentTextMatch[] {
  if (query.length === 0) {
    return [];
  }
  const needle = query.toLocaleLowerCase();
  const matches: NativeDocumentTextMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || typeof node.text !== "string" || node.text.length === 0) {
      return;
    }
    const haystack = node.text.toLocaleLowerCase();
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      matches.push({ from: pos + index, to: pos + index + query.length });
      index = haystack.indexOf(needle, index + Math.max(query.length, 1));
    }
  });
  return matches;
}

export function assignNativeDocumentHeadingAnchors(root: ParentNode | null): number {
  if (root === null) {
    return 0;
  }
  const headings = root.querySelectorAll<HTMLElement>(
    ".native-document-editor__content h1, .native-document-editor__content h2, .native-document-editor__content h3, .native-document-editor__content h4, .native-document-editor__content h5, .native-document-editor__content h6",
  );
  let headingCount = 0;
  for (const heading of headings) {
    if ((heading.textContent ?? "").trim().length === 0) {
      heading.removeAttribute("id");
      heading.removeAttribute("tabindex");
      continue;
    }
    headingCount += 1;
    heading.id = `heading-${String(headingCount)}`;
    heading.tabIndex = -1;
    heading.style.scrollMarginTop = "72px";
  }
  return headingCount;
}

export function nativeDocumentTableOfContentsText(root: ParentNode | null): string | null {
  if (root === null) {
    return null;
  }
  const headings = Array.from(
    root.querySelectorAll<HTMLElement>(
      ".native-document-editor__content h1[id], .native-document-editor__content h2[id], .native-document-editor__content h3[id], .native-document-editor__content h4[id], .native-document-editor__content h5[id], .native-document-editor__content h6[id]",
    ),
  )
    .map((heading) => ({
      id: heading.id,
      level: headingLevel(heading.tagName),
      title: (heading.textContent ?? "").trim(),
    }))
    .filter((heading) => heading.id.length > 0 && heading.title.length > 0);
  if (headings.length === 0) {
    return null;
  }
  const minimumLevel = Math.min(...headings.map((heading) => heading.level));
  return [
    "Table of contents",
    "",
    ...headings.map((heading) => {
      const indent = "  ".repeat(Math.max(heading.level - minimumLevel, 0));
      return `${indent}- ${nativeDocumentCrossReferenceInsertionText(heading)}`;
    }),
    "",
  ].join("\n");
}

export function nativeDocumentCrossReferenceOptions(
  root: ParentNode | null,
): readonly NativeDocumentCrossReferenceOption[] {
  return uniqueNativeDocumentReferenceOptions([
    ...nativeDocumentHeadingCrossReferenceOptions(root),
    ...nativeDocumentBookmarkOptions(root),
  ]);
}

function nativeDocumentHeadingCrossReferenceOptions(
  root: ParentNode | null,
): readonly NativeDocumentCrossReferenceOption[] {
  if (root === null) {
    return [];
  }
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      ".native-document-editor__content h1[id], .native-document-editor__content h2[id], .native-document-editor__content h3[id], .native-document-editor__content h4[id], .native-document-editor__content h5[id], .native-document-editor__content h6[id]",
    ),
  )
    .map((heading) => ({
      id: heading.id,
      level: headingLevel(heading.tagName),
      title: (heading.textContent ?? "").trim(),
    }))
    .filter((heading) => heading.id.length > 0 && heading.title.length > 0);
}

export function nativeDocumentBookmarkOptions(
  root: ParentNode | null,
): readonly NativeDocumentCrossReferenceOption[] {
  if (root === null) {
    return [];
  }
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      '.native-document-editor__content [data-native-document-token-kind="bookmark"][data-native-document-bookmark-id]',
    ),
  )
    .map((bookmark) => ({
      id: bookmark.dataset.nativeDocumentBookmarkId ?? "",
      level: 1,
      title: (bookmark.dataset.nativeDocumentTokenLabel ?? bookmark.textContent ?? "").trim(),
    }))
    .filter((bookmark) => bookmark.id.length > 0 && bookmark.title.length > 0);
}

function uniqueNativeDocumentReferenceOptions(
  options: readonly NativeDocumentCrossReferenceOption[],
): readonly NativeDocumentCrossReferenceOption[] {
  return options.filter(
    (option, index) => options.findIndex((candidate) => candidate.id === option.id) === index,
  );
}

export function nativeDocumentCrossReferenceInsertionText(
  option: NativeDocumentCrossReferenceOption,
): string {
  const id = nativeDocumentReferenceId(option.id, "heading");
  return `{{REF ${id} "${nativeDocumentFieldTokenValue(option.title, "Untitled heading")}"}}`;
}

export function nativeDocumentBookmarkInsertionText(
  label: string,
  existingOptions: readonly NativeDocumentCrossReferenceOption[] = [],
): string {
  const id = nativeDocumentBookmarkIdValue(label, existingOptions);
  return `{{BOOKMARK ${id} "${nativeDocumentFieldTokenValue(label, "Bookmark")}"}}`;
}

export function nativeDocumentBookmarkIdValue(
  value: string,
  existingOptions: readonly NativeDocumentCrossReferenceOption[] = [],
): string {
  const base = nativeDocumentReferenceId(value.toLowerCase(), "bookmark");
  const existingIds = new Set(existingOptions.map((option) => option.id));
  if (!existingIds.has(base)) {
    return base;
  }
  for (let index = 2; index < 1_000; index += 1) {
    const candidate = `${base}-${String(index)}`;
    if (!existingIds.has(candidate)) {
      return candidate;
    }
  }
  return `${base}-${String(Date.now())}`;
}

function nativeDocumentReferenceId(value: string, fallback: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9_-]/gu, "-")
      .replace(/-+/gu, "-")
      .replace(/^-|-$/gu, "") || fallback
  );
}

function headingLevel(tagName: string): number {
  const level = Number(tagName.replace(/^H/iu, ""));
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : 1;
}

function selectNativeDocumentMatch(
  editor: NativeDocumentEditorLike | null,
  match: NativeDocumentTextMatch | undefined,
): void {
  if (editor === null || match === undefined) {
    return;
  }
  editor.chain().focus().setTextSelection(match).scrollIntoView().run();
}

export function selectNativeDocumentAnchorRange(
  editor: { chain(): NativeDocumentCommandChain } | null,
  documentId: string,
  detail: NativeDocumentAnchorSelectionDetail,
): boolean {
  if (editor === null || detail.documentId !== documentId) {
    return false;
  }
  const selection = detail.selection as Partial<NativeDocumentSelectionAnchor> | null;
  if (selection === null || typeof selection !== "object") {
    return false;
  }
  const { from, to } = selection;
  if (
    typeof from !== "number" ||
    typeof to !== "number" ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    to <= from
  ) {
    return false;
  }
  return editor.chain().focus().setTextSelection({ from, to }).scrollIntoView().run();
}

export function activateNativeDocumentReferenceToken(
  root: ParentNode | null,
  target: EventTarget | null,
): boolean {
  if (root === null || !(target instanceof Element)) {
    return false;
  }
  const token = target.closest<HTMLElement>(
    '[data-native-document-token-kind="reference"][data-native-document-reference-target]',
  );
  if (token === null) {
    return false;
  }
  const targetId = token.dataset.nativeDocumentReferenceTarget;
  if (targetId === undefined || targetId.length === 0) {
    return false;
  }
  const heading = Array.from(root.querySelectorAll<HTMLElement>("[id]")).find(
    (candidate) => candidate.id === targetId,
  );
  if (heading === undefined) {
    return false;
  }
  if (!heading.hasAttribute("tabindex")) {
    heading.tabIndex = -1;
  }
  heading.scrollIntoView?.({ block: "center" });
  heading.focus({ preventScroll: true });
  return true;
}

function nativeDocumentSmartChipNavigationHref(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const token = target.closest<HTMLElement>(
    "[data-native-document-chip-kind][data-native-document-chip-href]",
  );
  return nativeDocumentSmartChipNavigationTarget(token?.dataset.nativeDocumentChipHref);
}

function nativeDocumentSmartChipNavigationTarget(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const href = value.trim();
  if (href.length === 0 || href.includes("\u0000") || href.includes("\r") || href.includes("\n")) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(href, nativeDocumentUrlBase());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  if (!isHelixInternalDroppedUrl(url)) {
    return null;
  }
  return href.startsWith("/") ? href : url.href;
}

export function activateNativeDocumentEquationToken(
  _root: ParentNode | null,
  target: EventTarget | null,
): NativeDocumentEquationTokenActivation | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const token = target.closest<HTMLElement>(
    '[data-native-document-token-kind="equation"][data-native-document-token-from][data-native-document-token-to]',
  );
  if (token === null) {
    return null;
  }
  const from = Number(token.dataset.nativeDocumentTokenFrom);
  const to = Number(token.dataset.nativeDocumentTokenTo);
  const latex = token.dataset.nativeDocumentEquationLatex ?? token.dataset.nativeDocumentTokenLabel;
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    to <= from ||
    latex === undefined ||
    latex.trim().length === 0
  ) {
    return null;
  }
  return { from, to, latex };
}

export interface NativeDocumentDecorationRange {
  readonly id: string;
  readonly kind: NativeDocumentAnchorDecoration["kind"];
  readonly from: number;
  readonly to: number;
}

export function nativeDocumentDecorationRanges(
  docSize: number,
  anchorDecorations: readonly NativeDocumentAnchorDecoration[],
  textBetween?: (from: number, to: number) => string,
): readonly NativeDocumentDecorationRange[] {
  const ranges: NativeDocumentDecorationRange[] = [];
  for (const anchorDecoration of anchorDecorations) {
    const { from, to, text } = anchorDecoration.selection;
    if (
      typeof from !== "number" ||
      typeof to !== "number" ||
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      to <= from ||
      to > docSize
    ) {
      continue;
    }
    if (
      textBetween !== undefined &&
      normalizeNativeDocumentDecorationText(textBetween(from, to)) !==
        normalizeNativeDocumentDecorationText(text)
    ) {
      continue;
    }
    ranges.push({ id: anchorDecoration.id, kind: anchorDecoration.kind, from, to });
  }
  return ranges;
}

export function nativeDocumentTokenDecorationRanges(
  doc: ProseMirrorDocLike,
): readonly NativeDocumentTokenDecorationRange[] {
  const ranges: NativeDocumentTokenDecorationRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || typeof node.text !== "string" || node.text.length === 0) {
      return;
    }
    for (const match of node.text.matchAll(NATIVE_DOCUMENT_TOKEN_PATTERN)) {
      const token = match[0];
      const index = match.index;
      const rendered = nativeDocumentTokenDecorationText(match);
      if (index === undefined || rendered === null) {
        continue;
      }
      ranges.push({
        from: pos + index,
        to: pos + index + token.length,
        ...rendered,
      });
    }
  });
  return ranges;
}

export function nativeDocumentFindDecorationRanges(
  docSize: number,
  matches: readonly NativeDocumentTextMatch[],
  activeMatchIndex: number,
): readonly NativeDocumentFindDecorationRange[] {
  if (matches.length === 0 || !Number.isSafeInteger(docSize) || docSize <= 0) {
    return [];
  }
  const normalizedActiveIndex =
    ((activeMatchIndex % matches.length) + matches.length) % matches.length;
  const ranges: NativeDocumentFindDecorationRange[] = [];
  matches.forEach((match, index) => {
    if (
      !Number.isSafeInteger(match.from) ||
      !Number.isSafeInteger(match.to) ||
      match.from < 0 ||
      match.to <= match.from ||
      match.to > docSize
    ) {
      return;
    }
    ranges.push({
      from: match.from,
      to: match.to,
      active: index === normalizedActiveIndex,
      index,
    });
  });
  return ranges;
}

export function nativeDocumentFieldRefreshRanges(
  doc: ProseMirrorDocLike,
  input: {
    readonly actorName?: string | null | undefined;
    readonly documentTitle?: string | null | undefined;
    readonly now?: Date | undefined;
  } = {},
): readonly NativeDocumentTextReplacement[] {
  const ranges: NativeDocumentTextReplacement[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || typeof node.text !== "string" || node.text.length === 0) {
      return;
    }
    for (const match of node.text.matchAll(NATIVE_DOCUMENT_TOKEN_PATTERN)) {
      const index = match.index;
      const replacement = nativeDocumentRefreshedFieldToken(match, input);
      if (index === undefined || replacement === null || replacement === match[0]) {
        continue;
      }
      ranges.push({
        from: pos + index,
        to: pos + index + match[0].length,
        text: replacement,
      });
    }
  });
  return ranges;
}

function nativeDocumentRefreshedFieldToken(
  match: RegExpMatchArray,
  input: {
    readonly actorName?: string | null | undefined;
    readonly documentTitle?: string | null | undefined;
    readonly now?: Date | undefined;
  },
): string | null {
  if (match[1] !== undefined) {
    return nativeDocumentFieldInsertionText("date", input);
  }
  if (match[2] !== undefined) {
    return nativeDocumentFieldInsertionText("time", input);
  }
  if (match[3] !== undefined) {
    return nativeDocumentFieldInsertionText("author", input);
  }
  if (match[4] !== undefined) {
    return nativeDocumentFieldInsertionText("documentTitle", input);
  }
  return null;
}

function nativeDocumentTokenDecorationText(
  match: RegExpMatchArray,
): Omit<NativeDocumentTokenDecorationRange, "from" | "to"> | null {
  const token = match[0];
  const date = match[1];
  if (date !== undefined) {
    return { kind: "field", label: date, title: "Date field" };
  }
  const time = match[2];
  if (time !== undefined) {
    return { kind: "field", label: time, title: "Time field" };
  }
  if (token === "{{PAGE}}") {
    return { kind: "field", label: "Page 1", title: "Page field" };
  }
  const author = match[3];
  if (author !== undefined) {
    return { kind: "field", label: author, title: "Author field" };
  }
  const property = match[4];
  if (property !== undefined) {
    return { kind: "field", label: property, title: "Document property field" };
  }
  const equation = match[5];
  if (equation !== undefined) {
    return { kind: "equation", label: equation, title: "Equation" };
  }
  const bookmarkId = match[6];
  const bookmark = match[7];
  if (bookmarkId !== undefined && bookmark !== undefined) {
    return {
      kind: "bookmark",
      label: bookmark,
      title: `Bookmark: ${bookmark}`,
      tokenId: bookmarkId,
    };
  }
  const referenceTargetId = match[8];
  const reference = match[9];
  if (referenceTargetId !== undefined && reference !== undefined) {
    return {
      kind: "reference",
      label: reference,
      title: "Cross-reference",
      tokenId: referenceTargetId,
      referenceTargetId,
    };
  }
  const chipKind = match[10];
  const chipLabel = match[11];
  const chipId = match[12];
  const chipHref = match[13];
  if (chipKind !== undefined && chipLabel !== undefined) {
    const normalizedChipKind = nativeDocumentSmartChipKindFromValue(chipKind);
    if (normalizedChipKind === null) {
      return null;
    }
    const tokenId = chipId === undefined || chipId.trim().length === 0 ? undefined : chipId.trim();
    return {
      kind: `chip-${normalizedChipKind}`,
      label: chipLabel,
      title: `${smartChipKindLabel(normalizedChipKind)} smart chip`,
      chipKind: normalizedChipKind,
      tokenId,
      chipHref: nativeDocumentSmartChipNavigationTarget(chipHref) ?? undefined,
      hoverCard: smartChipHoverCardText(normalizedChipKind, chipLabel, tokenId),
    };
  }
  return null;
}

function emitNativeDocumentInspectorSnapshot(
  onInspectorSnapshotChange: ((snapshot: NativeDocumentInspectorSnapshot) => void) | undefined,
  doc: ProseMirrorNode,
): void {
  if (onInspectorSnapshotChange === undefined) {
    return;
  }
  const snapshot = nativeDocumentInspectorSnapshotFromProseMirrorDoc(doc);
  queueMicrotask(() => {
    onInspectorSnapshotChange(snapshot);
  });
}

function dispatchNativeDocumentFindDecorations(
  editor: NativeDocumentDecorationDispatchEditorLike | null,
  findMatches: readonly NativeDocumentTextMatch[],
  activeFindMatchIndex: number,
): void {
  if (editor?.view === undefined) {
    return;
  }
  editor.view.dispatch(
    editor.state.tr.setMeta(NATIVE_DOCUMENT_DECORATION_PLUGIN_KEY, {
      findMatches,
      activeFindMatchIndex,
    }),
  );
}

function dispatchNativeDocumentGhostText(
  editor: NativeDocumentDecorationDispatchEditorLike | null,
  ghostText: NativeDocumentGhostText | null,
): void {
  if (editor?.view === undefined) {
    return;
  }
  editor.view.dispatch(
    editor.state.tr.setMeta(NATIVE_DOCUMENT_DECORATION_PLUGIN_KEY, {
      ghostText,
    }),
  );
}

function createNativeDocumentAnchorDecorationExtension() {
  return Extension.create({
    name: "nativeDocumentAnchorDecorations",
    addProseMirrorPlugins() {
      return [
        new Plugin<NativeDocumentDecorationPluginState>({
          key: NATIVE_DOCUMENT_DECORATION_PLUGIN_KEY,
          state: {
            init(_config, state) {
              return {
                anchorDecorations: [],
                findMatches: [],
                activeFindMatchIndex: 0,
                ghostText: null,
                decorations: nativeDocumentDecorationSet(state.doc, [], [], 0, null),
              };
            },
            apply(transaction, pluginState, _oldState, newState) {
              const meta = transaction.getMeta(NATIVE_DOCUMENT_DECORATION_PLUGIN_KEY) as
                | NativeDocumentDecorationPluginMeta
                | readonly NativeDocumentAnchorDecoration[]
                | undefined;
              const nextMeta = nativeDocumentDecorationPluginMeta(meta);
              const anchorDecorations = nextMeta.anchorDecorations ?? pluginState.anchorDecorations;
              const findMatches = nextMeta.findMatches ?? pluginState.findMatches;
              const activeFindMatchIndex =
                nextMeta.activeFindMatchIndex ?? pluginState.activeFindMatchIndex;
              const ghostText =
                nextMeta.ghostText !== undefined
                  ? nextMeta.ghostText
                  : transaction.docChanged
                    ? null
                    : pluginState.ghostText;
              return {
                anchorDecorations,
                findMatches,
                activeFindMatchIndex,
                ghostText,
                decorations: nativeDocumentDecorationSet(
                  newState.doc,
                  anchorDecorations,
                  findMatches,
                  activeFindMatchIndex,
                  ghostText,
                ),
              };
            },
          },
          props: {
            decorations(state) {
              return (
                NATIVE_DOCUMENT_DECORATION_PLUGIN_KEY.getState(state)?.decorations ??
                DecorationSet.empty
              );
            },
          },
        }),
      ];
    },
  });
}

interface NativeDocumentDecorationPluginState {
  readonly anchorDecorations: readonly NativeDocumentAnchorDecoration[];
  readonly findMatches: readonly NativeDocumentTextMatch[];
  readonly activeFindMatchIndex: number;
  readonly ghostText: NativeDocumentGhostText | null;
  readonly decorations: DecorationSet;
}

interface NativeDocumentDecorationPluginMeta {
  readonly anchorDecorations?: readonly NativeDocumentAnchorDecoration[];
  readonly findMatches?: readonly NativeDocumentTextMatch[];
  readonly activeFindMatchIndex?: number;
  readonly ghostText?: NativeDocumentGhostText | null | undefined;
}

interface NativeDocumentGhostText {
  readonly position: number;
  readonly text: string;
}

function nativeDocumentDecorationPluginMeta(
  meta: NativeDocumentDecorationPluginMeta | readonly NativeDocumentAnchorDecoration[] | undefined,
): NativeDocumentDecorationPluginMeta {
  if (meta === undefined) {
    return {};
  }
  if (Array.isArray(meta)) {
    return { anchorDecorations: meta };
  }
  return meta as NativeDocumentDecorationPluginMeta;
}

function nativeDocumentDecorationSet(
  doc: ProseMirrorNode,
  anchorDecorations: readonly NativeDocumentAnchorDecoration[],
  findMatches: readonly NativeDocumentTextMatch[],
  activeFindMatchIndex: number,
  ghostText: NativeDocumentGhostText | null,
): DecorationSet {
  const anchorRanges = nativeDocumentDecorationRanges(
    doc.content.size,
    anchorDecorations,
    (from, to) => doc.textBetween(from, to, " "),
  );
  const findRanges = nativeDocumentFindDecorationRanges(
    doc.content.size,
    findMatches,
    activeFindMatchIndex,
  );
  const tokenRanges = nativeDocumentTokenDecorationRanges(doc);
  if (
    anchorRanges.length === 0 &&
    findRanges.length === 0 &&
    tokenRanges.length === 0 &&
    ghostText === null
  ) {
    return DecorationSet.empty;
  }
  const ghostDecoration =
    ghostText === null || ghostText.text.trim().length === 0
      ? []
      : [
          Decoration.widget(
            Math.min(Math.max(ghostText.position, 0), doc.content.size),
            () => {
              const element = document.createElement("span");
              element.className = "native-document-smart-compose-inline-ghost";
              element.dataset.nativeDocumentSmartComposeGhost = "true";
              element.textContent = ghostText.text;
              return element;
            },
            { key: "native-document-smart-compose-ghost", side: 1 },
          ),
        ];
  return DecorationSet.create(doc, [
    ...ghostDecoration,
    ...anchorRanges.map((range) =>
      Decoration.inline(
        range.from,
        range.to,
        {
          class: `native-document-anchor-decoration native-document-anchor-decoration--${range.kind}`,
          "data-native-document-anchor-id": range.id,
          "data-native-document-anchor-kind": range.kind,
          title: range.kind === "comment" ? "Comment" : "Suggestion",
        },
        {
          inclusiveStart: false,
          inclusiveEnd: false,
        },
      ),
    ),
    ...findRanges.map((range) =>
      Decoration.inline(
        range.from,
        range.to,
        {
          class: `native-document-find-decoration${
            range.active ? " native-document-find-decoration--active" : ""
          }`,
          "data-native-document-find-match": "true",
          ...(range.active ? { "data-native-document-find-active": "true" } : {}),
          "data-native-document-find-index": String(range.index),
          title: range.active ? "Active find match" : "Find match",
        },
        {
          inclusiveStart: false,
          inclusiveEnd: false,
        },
      ),
    ),
    ...tokenRanges.map((range) =>
      Decoration.inline(range.from, range.to, nativeDocumentTokenDecorationAttributes(range), {
        inclusiveStart: false,
        inclusiveEnd: false,
      }),
    ),
  ]);
}

export function nativeDocumentTokenDecorationAttributes(
  range: NativeDocumentTokenDecorationRange,
): Record<string, string> {
  return {
    class: `native-document-token-decoration native-document-token-decoration--${range.kind}`,
    "data-native-document-token-kind": range.kind,
    "data-native-document-token-label": range.label,
    "data-native-document-token-from": String(range.from),
    "data-native-document-token-to": String(range.to),
    ...(range.kind === "equation"
      ? {
          "aria-label": `Edit equation ${range.label}`,
          "data-native-document-equation-latex": range.label,
          role: "button",
          tabindex: "0",
        }
      : {}),
    ...(range.chipKind === undefined
      ? {}
      : {
          "data-native-document-chip-kind": range.chipKind,
          "data-native-document-token-card": range.hoverCard ?? range.label,
          tabindex: "0",
        }),
    ...(range.chipHref === undefined
      ? {}
      : {
          "aria-label": `Open ${range.label}`,
          "data-native-document-chip-href": range.chipHref,
          role: "link",
        }),
    ...(range.referenceTargetId === undefined
      ? {}
      : {
          "aria-label": `Go to ${range.label}`,
          "data-native-document-reference-target": range.referenceTargetId,
          role: "button",
          tabindex: "0",
        }),
    ...(range.kind === "bookmark" && range.tokenId !== undefined
      ? {
          "aria-label": `Bookmark ${range.label}`,
          "data-native-document-bookmark-id": range.tokenId,
          id: range.tokenId,
          tabindex: "-1",
        }
      : {}),
    ...(range.tokenId === undefined ? {} : { "data-native-document-token-id": range.tokenId }),
    title: range.title,
  };
}

function normalizeNativeDocumentDecorationText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

const NATIVE_DOCUMENT_TOKEN_PATTERN =
  /\{\{(?:DATE\s+([^}]+)|TIME\s+([^}]+)|PAGE|AUTHOR\s+([^}]+)|PROPERTY\s+title="([^"]*)"|EQUATION\s+latex="([^"]*)"|BOOKMARK\s+(\S+)\s+"([^"]*)"|REF\s+(\S+)\s+"([^"]*)"|CHIP\s+(person|doc|file|event)\s+label="([^"]*)"(?:\s+id="([^"]*)")?(?:\s+href="([^"]*)")?)\}\}/gu;

function smartChipKindLabel(kind: NativeDocumentSmartChipKind): string {
  switch (kind) {
    case "person":
      return "Person";
    case "doc":
      return "Document";
    case "file":
      return "File";
    case "event":
      return "Event";
  }
}

function smartChipHoverCardText(
  kind: NativeDocumentSmartChipKind,
  label: string,
  tokenId: string | undefined,
): string {
  const parts = [smartChipKindLabel(kind), label.trim()];
  if (tokenId !== undefined) {
    parts.push(tokenId);
  }
  return parts.filter((part) => part.length > 0).join(" · ");
}

const NATIVE_DOCUMENT_DECORATION_PLUGIN_KEY = new PluginKey<NativeDocumentDecorationPluginState>(
  "nativeDocumentAnchorDecorations",
);

const EDITOR_WRAP_STYLE = {
  display: "grid",
  gap: 12,
  marginTop: 36,
} satisfies CSSProperties;

// EDITOR_HEADER_STYLE, EDITOR_STATUS_STYLE, FORMAT_TOOLBAR_STYLE removed when the
// formatting toolbar moved into the unified chrome.

const EDITOR_CONTENT_SINGLE_COLUMN_STYLE = {
  columnCount: 1,
} satisfies CSSProperties;

const EDITOR_CONTENT_TWO_COLUMN_STYLE = {
  columnCount: 2,
  columnGap: 40,
} satisfies CSSProperties;

const FIELD_SELECT_STYLE = {
  minWidth: 116,
  border: 0,
  background: "transparent",
  color: "inherit",
  font: "inherit",
} satisfies CSSProperties;

const EQUATION_FORM_STYLE = {
  justifySelf: "start",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "4px 8px",
  background: "var(--surface-2)",
  color: "var(--text-2)",
} satisfies CSSProperties;

const SMART_COMPOSE_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
} satisfies CSSProperties;

const SMART_COMPOSE_INPUT_STYLE = {
  width: 180,
  height: 32,
  border: "1px solid var(--border)",
  borderRadius: 4,
  background: "var(--surface)",
  color: "var(--text)",
  font: "inherit",
  padding: "0 8px",
} satisfies CSSProperties;

const SMART_COMPOSE_STATUS_STYLE = {
  minWidth: 96,
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const SMART_COMPOSE_GHOST_STYLE = {
  maxWidth: 260,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--text-3)",
  fontStyle: "italic",
  borderLeft: "2px solid var(--accent)",
  paddingLeft: 8,
} satisfies CSSProperties;

const EQUATION_INPUT_STYLE = {
  minWidth: 0,
  width: 132,
  height: 28,
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "0 8px",
  background: "var(--surface)",
  color: "var(--text-1)",
  font: "inherit",
  fontSize: "var(--text-body-sm)",
} satisfies CSSProperties;

const FIND_REPLACE_STYLE = {
  display: "grid",
  gridTemplateColumns: "auto minmax(120px, 1fr) auto minmax(120px, 1fr) repeat(5, auto) auto",
  alignItems: "center",
  gap: 8,
  padding: 10,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
} satisfies CSSProperties;

const LINK_FORM_STYLE = {
  display: "grid",
  gridTemplateColumns:
    "auto minmax(140px, 1fr) auto minmax(180px, 1fr) auto auto minmax(120px, auto)",
  alignItems: "center",
  gap: 8,
  padding: 10,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
} satisfies CSSProperties;

const TABLE_FORM_STYLE = {
  justifySelf: "start",
  display: "inline-grid",
  gridTemplateColumns: "auto 72px auto 72px auto auto",
  alignItems: "center",
  gap: 8,
  padding: 10,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
} satisfies CSSProperties;

const FIELD_FORM_STYLE = {
  justifySelf: "start",
  display: "inline-grid",
  gridTemplateColumns: "auto minmax(160px, auto) auto auto",
  alignItems: "center",
  gap: 8,
  padding: 10,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
} satisfies CSSProperties;

const CROSS_REFERENCE_FORM_STYLE = {
  justifySelf: "start",
  display: "inline-grid",
  gridTemplateColumns: "auto minmax(180px, auto) auto auto",
  alignItems: "center",
  gap: 8,
  padding: 10,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
} satisfies CSSProperties;

const SMART_CHIP_FORM_STYLE = {
  justifySelf: "start",
  display: "inline-grid",
  gridTemplateColumns: "auto minmax(116px, auto) auto minmax(180px, auto) auto auto",
  alignItems: "center",
  gap: 8,
  padding: 10,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
} satisfies CSSProperties;

const FIELD_LABEL_STYLE = {
  fontSize: "var(--text-caption)",
  fontWeight: 600,
  color: "var(--text-2)",
} satisfies CSSProperties;

const INPUT_STYLE = {
  minWidth: 0,
  height: 30,
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "0 8px",
  background: "var(--surface)",
  color: "var(--text-1)",
  font: "inherit",
  fontSize: "var(--text-body-sm)",
} satisfies CSSProperties;

const SMALL_NUMBER_INPUT_STYLE = {
  ...INPUT_STYLE,
  width: 72,
} satisfies CSSProperties;

const FIND_STATUS_STYLE = {
  minWidth: 72,
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
  whiteSpace: "nowrap",
} satisfies CSSProperties;
