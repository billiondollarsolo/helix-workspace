import { useMutation, useQuery } from "@tanstack/react-query";
import { Extension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import * as Y from "yjs";
import { Icons } from "@/components/icons";
import {
  generateDocsSuggestionDraft,
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

type NativeDocumentFormattingCommand =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "paragraph"
  | "heading1"
  | "heading2"
  | "bulletList"
  | "orderedList"
  | "codeBlock";

export type NativeDocumentFieldKind = "date" | "time" | "page" | "author" | "documentTitle";
export type { NativeDocumentSmartChipKind } from "./native-document-commands";

interface NativeDocumentSmartChipEntity {
  readonly kind: NativeDocumentSmartChipKind;
  readonly id: string;
  readonly label: string;
}

export interface NativeDocumentEditorProps {
  readonly session: NativeDocumentSession;
  readonly anchorDecorations?: readonly NativeDocumentAnchorDecoration[];
  readonly columnCount?: 1 | 2;
  readonly generateSuggestionDraft?: typeof generateDocsSuggestionDraft;
  readonly onInspectorSnapshotChange?: (snapshot: NativeDocumentInspectorSnapshot) => void;
  readonly onSelectionAnchorChange?: (selection: NativeDocumentSelectionAnchor | null) => void;
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

export interface NativeDocumentTokenDecorationRange {
  readonly from: number;
  readonly to: number;
  readonly kind: string;
  readonly label: string;
  readonly title: string;
  readonly chipKind?: NativeDocumentSmartChipKind | undefined;
  readonly tokenId?: string | undefined;
  readonly referenceTargetId?: string | undefined;
  readonly hoverCard?: string | undefined;
}

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
  insertContent(value: string): NativeDocumentCommandChain;
  insertContentAt(match: NativeDocumentTextMatch, value: string): NativeDocumentCommandChain;
  toggleBold(): NativeDocumentCommandChain;
  toggleItalic(): NativeDocumentCommandChain;
  toggleUnderline(): NativeDocumentCommandChain;
  toggleStrike(): NativeDocumentCommandChain;
  setParagraph(): NativeDocumentCommandChain;
  toggleHeading(input: { readonly level: 1 | 2 }): NativeDocumentCommandChain;
  toggleBulletList(): NativeDocumentCommandChain;
  toggleOrderedList(): NativeDocumentCommandChain;
  toggleCodeBlock(): NativeDocumentCommandChain;
  run(): boolean;
}

interface NativeDocumentFormattingEditorLike {
  chain(): NativeDocumentCommandChain;
  can(): { chain(): NativeDocumentCommandChain };
  isActive(name: string, attributes?: Record<string, unknown>): boolean;
}

export function NativeDocumentEditor({
  session,
  anchorDecorations = [],
  columnCount = 1,
  generateSuggestionDraft = generateDocsSuggestionDraft,
  onInspectorSnapshotChange,
  onSelectionAnchorChange,
}: NativeDocumentEditorProps) {
  const actorQuery = useQuery(docsSessionQueryOptions());
  const smartChipPickerQuery = useQuery(docsSmartChipPickerQueryOptions());
  const [providerStatus, setProviderStatus] = useState<NativeDocumentProviderStatus>("offline");
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [equationText, setEquationText] = useState("");
  const [equationEdit, setEquationEdit] = useState<NativeDocumentEquationTokenActivation | null>(
    null,
  );
  const [equationEditText, setEquationEditText] = useState("");
  const [smartComposePrompt, setSmartComposePrompt] = useState("");
  const [smartComposeStatus, setSmartComposeStatus] = useState("Select text to compose");
  const [smartComposeDraft, setSmartComposeDraft] = useState("");
  const [smartComposePending, setSmartComposePending] = useState(false);
  const smartComposeDraftRef = useRef("");
  const smartComposePendingRef = useRef(false);
  const smartComposeContextVersionRef = useRef(0);
  const smartComposeRequestIdRef = useRef(0);
  const editorRef = useRef<Editor | null>(null);
  const [matches, setMatches] = useState<readonly NativeDocumentTextMatch[]>([]);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [findStatus, setFindStatus] = useState("No query");
  const [headingReferences, setHeadingReferences] = useState<
    readonly NativeDocumentCrossReferenceOption[]
  >([]);
  const [, setToolbarRevision] = useState(0);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const editorWrapRef = useRef<HTMLElement | null>(null);
  const ydoc = useMemo(() => {
    const doc = new Y.Doc();
    applyNativeDocumentState(doc, session.document.stateBase64);
    return doc;
  }, [session.document.id, session.document.stateBase64]);
  const anchorDecorationExtension = useMemo(
    () => createNativeDocumentAnchorDecorationExtension(),
    [],
  );
  const extensions = useMemo(
    () => [
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({
        document: ydoc,
        field: "default",
      }),
      anchorDecorationExtension,
    ],
    [anchorDecorationExtension, ydoc],
  );
  const refreshNativeDocumentHeadingReferences = useCallback(() => {
    assignNativeDocumentHeadingAnchors(editorWrapRef.current);
    const nextHeadingReferences = nativeDocumentCrossReferenceOptions(editorWrapRef.current);
    setHeadingReferences(nextHeadingReferences);
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
      onSelectionUpdate: ({ editor: updatedEditor }) => {
        invalidateSmartComposeRequest("Selection changed. Compose again");
        setToolbarRevision((revision) => revision + 1);
        onSelectionAnchorChange?.(selectionAnchorFromEditor(updatedEditor));
      },
      onUpdate: ({ editor: updatedEditor }) => {
        invalidateSmartComposeRequest("Document changed. Compose again");
        setToolbarRevision((revision) => revision + 1);
        emitNativeDocumentInspectorSnapshot(onInspectorSnapshotChange, updatedEditor.state.doc);
        queueMicrotask(() => refreshNativeDocumentHeadingReferences());
      },
      shouldRerenderOnTransaction: false,
    },
    [
      extensions,
      onInspectorSnapshotChange,
      onSelectionAnchorChange,
      invalidateSmartComposeRequest,
      refreshNativeDocumentHeadingReferences,
      session.document.title,
    ],
  );

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

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
    provider.connect();
    return () => {
      provider.disconnect();
      ydoc.destroy();
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

  const onInsertCrossReference = (headingId: string) => {
    if (editor === null) {
      return;
    }
    const reference = refreshNativeDocumentHeadingReferences().find(
      (candidate) => candidate.id === headingId,
    );
    if (reference === undefined) {
      return;
    }
    editor
      .chain()
      .focus()
      .insertContent(nativeDocumentCrossReferenceInsertionText(reference))
      .run();
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

  const onInsertEquation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (editor === null || equationText.trim().length === 0) {
      return;
    }
    editor.chain().focus().insertContent(nativeDocumentEquationInsertionText(equationText)).run();
    setEquationText("");
  };

  const onSaveEquationEdit = (event: FormEvent<HTMLFormElement>) => {
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
  };

  const onInsertField = (field: NativeDocumentFieldKind) => {
    if (editor === null) {
      return;
    }
    editor
      .chain()
      .focus()
      .insertContent(
        nativeDocumentFieldInsertionText(field, {
          actorName: actorQuery.data?.name,
          documentTitle: session.document.title,
        }),
      )
      .run();
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

  const onInsertSmartChip = (
    kind: NativeDocumentSmartChipKind,
    entity?: NativeDocumentSmartChipEntity,
  ) => {
    if (editor === null) {
      return;
    }
    editor
      .chain()
      .focus()
      .insertContent(
        nativeDocumentSmartChipInsertionText(kind, {
          actorId: entity?.kind === "person" ? entity.id : actorQuery.data?.actorId,
          actorName: entity?.kind === "person" ? entity.label : actorQuery.data?.name,
          documentId: entity?.kind === "doc" ? entity.id : session.document.id,
          documentTitle: entity?.kind === "doc" ? entity.label : session.document.title,
          eventId: entity?.kind === "event" ? entity.id : undefined,
          eventTitle: entity?.kind === "event" ? entity.label : undefined,
        }),
      )
      .run();
  };

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
      if (event.detail.command === "insert-toc") {
        onInsertTableOfContents();
        return;
      }
      if (event.detail.command === "insert-bookmark") {
        onInsertBookmark();
        return;
      }
      if (event.detail.command === "refresh-fields") {
        onRefreshFields();
        return;
      }
      onInsertSmartChip(event.detail.kind);
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
    <section ref={editorWrapRef} style={EDITOR_WRAP_STYLE} aria-label="Document editor">
      <div style={EDITOR_HEADER_STYLE}>
        <div className="native-document-editor__status" style={EDITOR_STATUS_STYLE}>
          {providerStatus === "connected" ? "Live editing" : "Editing locally"}
        </div>
        <NativeDocumentFormattingToolbar editor={editor} />
        <button
          className="btn sm"
          type="button"
          disabled={editor === null}
          onClick={onInsertTableOfContents}
        >
          <Icons.List />
          TOC
        </button>
        <form
          className="native-document-editor__equation"
          style={EQUATION_FORM_STYLE}
          aria-label="Insert equation"
          onSubmit={onInsertEquation}
        >
          <Icons.Code />
          <input
            id="native-document-equation"
            aria-label="Equation LaTeX"
            value={equationText}
            onChange={(event) => {
              setEquationText(event.target.value);
            }}
            placeholder="E=mc^2"
            style={EQUATION_INPUT_STYLE}
          />
          <button
            className="btn sm"
            type="submit"
            disabled={editor === null || equationText.trim().length === 0}
          >
            Equation
          </button>
        </form>
        {equationEdit === null ? null : (
          <form
            className="native-document-editor__equation"
            style={EQUATION_FORM_STYLE}
            aria-label="Edit equation"
            onSubmit={onSaveEquationEdit}
          >
            <Icons.Code />
            <input
              id="native-document-edit-equation"
              aria-label="Edit equation LaTeX"
              value={equationEditText}
              onChange={(event) => {
                setEquationEditText(event.target.value);
              }}
              style={EQUATION_INPUT_STYLE}
            />
            <button
              className="btn sm"
              type="submit"
              disabled={editor === null || equationEditText.trim().length === 0}
            >
              Save equation
            </button>
            <button
              className="btn ghost sm"
              type="button"
              onClick={() => {
                setEquationEdit(null);
                setEquationEditText("");
              }}
            >
              Cancel
            </button>
          </form>
        )}
        <label style={FIELD_PICKER_STYLE} htmlFor="native-document-field">
          <Icons.Tag />
          <select
            id="native-document-field"
            aria-label="Insert field"
            disabled={editor === null}
            defaultValue=""
            style={FIELD_SELECT_STYLE}
            onChange={(event) => {
              const field = nativeDocumentFieldKindFromValue(event.target.value);
              event.target.value = "";
              if (field !== null) {
                onInsertField(field);
              }
            }}
          >
            <option value="">Fields</option>
            {FIELD_COMMANDS.map((field) => (
              <option key={field.kind} value={field.kind}>
                {field.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn sm"
          type="button"
          disabled={editor === null}
          onClick={onRefreshFields}
        >
          <Icons.Refresh />
          Refresh fields
        </button>
        <button
          className="btn sm"
          type="button"
          disabled={editor === null}
          onClick={onInsertBookmark}
        >
          <Icons.Hash />
          Bookmark
        </button>
        <label style={FIELD_PICKER_STYLE} htmlFor="native-document-cross-reference">
          <Icons.Hash />
          <select
            id="native-document-cross-reference"
            aria-label="Insert cross-reference"
            disabled={editor === null || headingReferences.length === 0}
            defaultValue=""
            style={FIELD_SELECT_STYLE}
            onChange={(event) => {
              const headingId = event.target.value;
              event.target.value = "";
              if (headingId.length > 0) {
                onInsertCrossReference(headingId);
              }
            }}
          >
            <option value="">Refs</option>
            {headingReferences.map((heading) => (
              <option key={heading.id} value={heading.id}>
                {`${"  ".repeat(Math.max(heading.level - 1, 0))}${heading.title}`}
              </option>
            ))}
          </select>
        </label>
        <label style={FIELD_PICKER_STYLE} htmlFor="native-document-smart-chip">
          <Icons.Users />
          <select
            id="native-document-smart-chip"
            aria-label="Insert smart chip"
            disabled={editor === null}
            defaultValue=""
            style={FIELD_SELECT_STYLE}
            onChange={(event) => {
              const rawValue = event.target.value;
              event.target.value = "";
              const selectedEntity = nativeDocumentSmartChipEntityFromSelectValue(
                rawValue,
                smartChipPickerQuery.data,
              );
              if (selectedEntity !== null) {
                onInsertSmartChip(selectedEntity.kind, selectedEntity);
                return;
              }
              const kind = nativeDocumentSmartChipKindFromValue(rawValue);
              if (kind !== null) {
                onInsertSmartChip(kind);
              }
            }}
          >
            <option value="">Chips</option>
            {SMART_CHIP_COMMANDS.map((chip) => (
              <option key={chip.kind} value={chip.kind}>
                {chip.label}
              </option>
            ))}
            {(smartChipPickerQuery.data?.people.length ?? 0) > 0 ? (
              <optgroup label="People">
                {smartChipPickerQuery.data?.people.map((person) => (
                  <option key={person.id} value={`person:${person.id}`}>
                    {person.label}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {(smartChipPickerQuery.data?.documents.length ?? 0) > 0 ? (
              <optgroup label="Documents">
                {smartChipPickerQuery.data?.documents.map((document) => (
                  <option key={document.id} value={`doc:${document.id}`}>
                    {document.label}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {(smartChipPickerQuery.data?.events.length ?? 0) > 0 ? (
              <optgroup label="Events">
                {smartChipPickerQuery.data?.events.map((calendarEvent) => (
                  <option key={calendarEvent.id} value={`event:${calendarEvent.id}`}>
                    {calendarEvent.label}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>
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
          <Icons.Sparkles />
          <input
            id="native-document-smart-compose-prompt"
            aria-label="Smart compose prompt"
            value={smartComposePrompt}
            onChange={(event) => {
              invalidateSmartComposeRequest("Prompt changed. Compose again");
              setSmartComposePrompt(event.target.value);
              if (smartComposeDraft.length > 0) {
                setSmartComposeDraft("");
                setSmartComposeStatus("Draft cleared");
              }
            }}
            placeholder="Improve selected text"
            style={SMART_COMPOSE_INPUT_STYLE}
          />
          <button
            className="btn sm"
            type="submit"
            disabled={editor === null || smartComposePending}
          >
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
              const value = event.target.value;
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
            onChange={(event) => {
              setReplaceText(event.target.value);
            }}
            style={INPUT_STYLE}
          />
          <button
            className="btn sm"
            type="submit"
            disabled={editor === null || findText.length === 0}
          >
            <Icons.Search />
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
      </div>
      <div
        className="native-document-editor__content-layout"
        data-column-count={String(columnCount)}
        style={nativeDocumentContentColumnStyle(columnCount)}
      >
        <EditorContent editor={editor} />
      </div>
    </section>
  );
}

function NativeDocumentFormattingToolbar({
  editor,
}: {
  readonly editor: NativeDocumentFormattingEditorLike | null;
}) {
  return (
    <div
      className="native-document-editor__formatting"
      style={FORMAT_TOOLBAR_STYLE}
      aria-label="Document formatting"
    >
      {FORMAT_COMMANDS.map((item) => {
        const active = isNativeDocumentFormattingActive(editor, item.command);
        return (
          <button
            key={item.command}
            className={active ? "btn primary sm" : "btn sm"}
            type="button"
            aria-label={item.label}
            aria-pressed={active}
            disabled={!canRunNativeDocumentFormattingCommand(editor, item.command)}
            onClick={() => {
              runNativeDocumentFormattingCommand(editor, item.command);
            }}
            title={item.label}
          >
            <item.Icon />
            {item.shortLabel}
          </button>
        );
      })}
    </div>
  );
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

const FORMAT_COMMANDS = [
  { command: "bold", label: "Bold", shortLabel: "B", Icon: Icons.Bold },
  { command: "italic", label: "Italic", shortLabel: "I", Icon: Icons.Italic },
  { command: "underline", label: "Underline", shortLabel: "U", Icon: Icons.Underline },
  {
    command: "strike",
    label: "Strikethrough",
    shortLabel: "S",
    Icon: Icons.Strikethrough,
  },
  { command: "paragraph", label: "Paragraph", shortLabel: "P", Icon: Icons.Doc },
  { command: "heading1", label: "Heading 1", shortLabel: "H1", Icon: Icons.H1 },
  { command: "heading2", label: "Heading 2", shortLabel: "H2", Icon: Icons.H2 },
  { command: "bulletList", label: "Bullet list", shortLabel: "Bullets", Icon: Icons.List },
  {
    command: "orderedList",
    label: "Ordered list",
    shortLabel: "Numbered",
    Icon: Icons.ListNum,
  },
  { command: "codeBlock", label: "Code block", shortLabel: "Code", Icon: Icons.Code },
] satisfies ReadonlyArray<{
  readonly command: NativeDocumentFormattingCommand;
  readonly label: string;
  readonly shortLabel: string;
  readonly Icon: (typeof Icons)[keyof typeof Icons];
}>;

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

function nativeDocumentSmartChipEntityFromSelectValue(
  value: string,
  pickerData:
    | {
        readonly people: readonly { readonly id: string; readonly label: string }[];
        readonly documents: readonly { readonly id: string; readonly label: string }[];
        readonly events: readonly { readonly id: string; readonly label: string }[];
      }
    | undefined,
): NativeDocumentSmartChipEntity | null {
  const [kind, id] = value.split(":", 2);
  if (
    (kind !== "person" && kind !== "doc" && kind !== "event") ||
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
    command === "insert-toc" ||
    command === "insert-bookmark" ||
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
}): string {
  const id = nativeDocumentChipIdValue(input.id);
  const idAttribute = id.length === 0 ? "" : ` id="${id}"`;
  return `{{CHIP ${input.kind} label="${input.label}"${idAttribute}}}`;
}

function nativeDocumentChipIdValue(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/["{}\r\n]/gu, " ")
    .replace(/\s+/gu, "-")
    .replace(/[^A-Za-z0-9_:.@/-]/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function nativeDocumentContentColumnStyle(columnCount: 1 | 2): CSSProperties {
  return columnCount === 2 ? EDITOR_CONTENT_TWO_COLUMN_STYLE : EDITOR_CONTENT_SINGLE_COLUMN_STYLE;
}

function runNativeDocumentFormattingCommand(
  editor: NativeDocumentFormattingEditorLike | null,
  command: NativeDocumentFormattingCommand,
): boolean {
  if (editor === null) {
    return false;
  }
  return applyNativeDocumentFormattingCommand(editor.chain().focus(), command).run();
}

function canRunNativeDocumentFormattingCommand(
  editor: NativeDocumentFormattingEditorLike | null,
  command: NativeDocumentFormattingCommand,
): boolean {
  if (editor === null) {
    return false;
  }
  try {
    return applyNativeDocumentFormattingCommand(editor.can().chain().focus(), command).run();
  } catch {
    return false;
  }
}

function applyNativeDocumentFormattingCommand(
  chain: NativeDocumentCommandChain,
  command: NativeDocumentFormattingCommand,
): NativeDocumentCommandChain {
  switch (command) {
    case "bold":
      return chain.toggleBold();
    case "italic":
      return chain.toggleItalic();
    case "underline":
      return chain.toggleUnderline();
    case "strike":
      return chain.toggleStrike();
    case "paragraph":
      return chain.setParagraph();
    case "heading1":
      return chain.toggleHeading({ level: 1 });
    case "heading2":
      return chain.toggleHeading({ level: 2 });
    case "bulletList":
      return chain.toggleBulletList();
    case "orderedList":
      return chain.toggleOrderedList();
    case "codeBlock":
      return chain.toggleCodeBlock();
  }
}

function isNativeDocumentFormattingActive(
  editor: NativeDocumentFormattingEditorLike | null,
  command: NativeDocumentFormattingCommand,
): boolean {
  if (editor === null) {
    return false;
  }
  switch (command) {
    case "bold":
      return editor.isActive("bold");
    case "italic":
      return editor.isActive("italic");
    case "underline":
      return editor.isActive("underline");
    case "strike":
      return editor.isActive("strike");
    case "paragraph":
      return editor.isActive("paragraph");
    case "heading1":
      return editor.isActive("heading", { level: 1 });
    case "heading2":
      return editor.isActive("heading", { level: 2 });
    case "bulletList":
      return editor.isActive("bulletList");
    case "orderedList":
      return editor.isActive("orderedList");
    case "codeBlock":
      return editor.isActive("codeBlock");
  }
}

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
  /\{\{(?:DATE\s+([^}]+)|TIME\s+([^}]+)|PAGE|AUTHOR\s+([^}]+)|PROPERTY\s+title="([^"]*)"|EQUATION\s+latex="([^"]*)"|BOOKMARK\s+(\S+)\s+"([^"]*)"|REF\s+(\S+)\s+"([^"]*)"|CHIP\s+(person|doc|event)\s+label="([^"]*)"(?:\s+id="([^"]*)")?)\}\}/gu;

function smartChipKindLabel(kind: NativeDocumentSmartChipKind): string {
  switch (kind) {
    case "person":
      return "Person";
    case "doc":
      return "Document";
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

const EDITOR_HEADER_STYLE = {
  display: "grid",
  gap: 10,
} satisfies CSSProperties;

const EDITOR_STATUS_STYLE = {
  justifySelf: "start",
  border: "1px solid var(--border)",
  borderRadius: 999,
  padding: "4px 10px",
  background: "var(--surface-2)",
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const FORMAT_TOOLBAR_STYLE = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 6,
  padding: 10,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
} satisfies CSSProperties;

const EDITOR_CONTENT_SINGLE_COLUMN_STYLE = {
  columnCount: 1,
} satisfies CSSProperties;

const EDITOR_CONTENT_TWO_COLUMN_STYLE = {
  columnCount: 2,
  columnGap: 40,
} satisfies CSSProperties;

const FIELD_PICKER_STYLE = {
  justifySelf: "start",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "4px 8px",
  background: "var(--surface-2)",
  color: "var(--text-2)",
  fontSize: "var(--text-body-sm)",
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

const FIND_STATUS_STYLE = {
  minWidth: 72,
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
  whiteSpace: "nowrap",
} satisfies CSSProperties;
