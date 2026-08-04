/* SlidesList — the Slides surface list view.
   Card grid or table driven by the shared document view preference. Ported from the handoff,
   wired to the Slides backend (`slides.deck.*` tools) via TanStack Query.

   Live backend decks are merged over the typed handoff seed; when the
   backend is unavailable the surface falls back to seed data only. Seed
   rows are read-only — create / rename act on native backend decks; trash
   lifecycle actions operate on Drive-backed presentation files. */

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Avatar } from "@/components/ui/avatar";
import { Icons } from "@/components/icons";
import { ShowMoreButton } from "@/components/show-more-button";
import {
  EDITORS_ALPHA_DISABLED_TITLE,
  EditorsAlphaBadge,
  EditorsAlphaDisabledNotice,
} from "@/features/apps/editors-alpha";
import {
  deleteDriveObject,
  restoreDriveObject,
  setDriveObjectStarred,
  trashDriveObject,
  uploadDriveFile,
} from "@/features/drive/api";
import { setHelixDriveItemDragData } from "@/features/drive/drag-payload";
import { FileNameText } from "@/features/drive/file-name-text";
import { FileThumbnail } from "@/features/drive/file-thumbnail";
import { driveQueryKeys } from "@/features/drive/queries";
import {
  DocumentSurfaceViewToggle,
  useDocumentSurfaceViewPreference,
} from "@/features/drive/view-preference";
import { createSlidesDeck, createSlidesSlide, updateSlidesDeck } from "./api";
import {
  SLIDES_FOLDERS,
  SLIDES_TEMPLATES,
  headingForSlidesFolder,
  type SlidesFolderId,
} from "./list-taxonomy";
import { generatePresentationDeck } from "./presentation-ai";
import { slidesListFromDriveQueryOptions, slidesQueryKeys } from "./queries";
import type { SlideDeck } from "./seed";

interface SlidesListProps {
  /** Open a deck in the editor. */
  readonly onOpen: (deck: Pick<SlideDeck, "id" | "openMode">) => void;
  /** Live search query from the TopBar. */
  readonly query: string;
  /** False when native editing/creation is disabled by Admin > Core apps. */
  readonly editorsEnabled?: boolean;
}

const sectionLabelStyle = {
  padding: "0 0 8px",
} as const;

const tableColumns = "1fr 160px 140px 80px 80px 64px";
const SLIDES_LIST_DEFAULT_LIMIT = 100;
const SLIDES_LIST_MAX_LIMIT = 250;

function sentinelLimit(displayLimit: number, maxLimit: number): number {
  return displayLimit < maxLimit ? displayLimit + 1 : displayLimit;
}

const menuItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 10px",
  fontSize: "var(--text-meta)",
  textAlign: "left",
  border: "none",
  borderRadius: 6,
  background: "transparent",
  cursor: "pointer",
  font: "inherit",
};

const GENERATE_PANEL_STYLE = {
  display: "grid",
  gap: 12,
  padding: 16,
  marginBottom: 20,
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--surface)",
} satisfies CSSProperties;

const GENERATE_FIELD_STYLE = {
  display: "grid",
  gap: 6,
} satisfies CSSProperties;

const GENERATE_LABEL_STYLE = {
  fontSize: "var(--text-meta)",
  color: "var(--text-3)",
  fontWeight: 600,
} satisfies CSSProperties;

const GENERATE_TEXTAREA_STYLE = {
  width: "100%",
  minHeight: 72,
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: 10,
  background: "var(--surface-2)",
  color: "var(--text)",
  font: "inherit",
  resize: "vertical",
} satisfies CSSProperties;

const GENERATE_PREVIEW_STYLE = {
  display: "grid",
  gap: 4,
  fontSize: "var(--text-meta)",
  color: "var(--text-2)",
} satisfies CSSProperties;

const PRESENTATION_IMPORT_ACCEPT = [
  ".pptx",
  ".pptm",
  ".potx",
  ".ppsx",
  ".pps",
  ".ppt",
  ".odp",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.presentationml.template",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  "application/vnd.ms-powerpoint",
  "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
  "application/vnd.ms-powerpoint.slideshow.macroEnabled.12",
  "application/vnd.oasis.opendocument.presentation",
].join(",");

function RecentCard({
  deck,
  onOpen,
}: {
  readonly deck: SlideDeck;
  readonly onOpen: (deck: Pick<SlideDeck, "id" | "openMode">) => void;
}) {
  return (
    <button
      type="button"
      draggable
      onDragStart={(event) => {
        setHelixDriveItemDragData(event.dataTransfer, {
          id: deck.id,
          name: deck.title,
          href: deckDragHref(deck),
          mimeType: deck.mimeType,
          app: "slides",
        });
      }}
      onClick={() => onOpen(deck)}
      title={deck.title}
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 0,
        textAlign: "left",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        cursor: "pointer",
      }}
    >
      <FileThumbnail
        objectId={deck.id}
        name={deck.title}
        mimeType={deck.mimeType}
        preview={deck.preview}
        aspectRatio="16 / 9"
        icon="Image"
        color="#ea580c"
        fallback={<DeckThumbnailPlaceholder deck={deck} />}
      />
      <div style={{ padding: "8px 10px", borderTop: "1px solid var(--border)" }}>
        <FileNameText name={deck.title} style={{ fontSize: "var(--text-meta)", fontWeight: 500 }} />
        <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}>
          {deck.modified}
        </div>
      </div>
    </button>
  );
}

function DeckThumbnailPlaceholder({ deck }: { readonly deck: SlideDeck }) {
  return (
    <div
      style={{
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        color: "white",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-overline)",
          opacity: 0.7,
          textTransform: "uppercase",
          letterSpacing: ".08em",
          marginBottom: 4,
        }}
      >
        {deck.slides} slides
      </div>
      <FileNameText
        name={deck.title}
        style={{ fontSize: "var(--text-body)", fontWeight: 700, letterSpacing: 0, minWidth: 0 }}
      />
    </div>
  );
}

/** Case-insensitive title/owner filter over the merged deck list. */
export function filterDecks(decks: readonly SlideDeck[], query: string): readonly SlideDeck[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return decks;
  }
  return decks.filter(
    (deck) =>
      deck.title.toLowerCase().includes(normalized) ||
      deck.owner.toLowerCase().includes(normalized),
  );
}

export function SlidesList({ onOpen, query, editorsEnabled = true }: SlidesListProps) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const renameInputId = useId();
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [listLimit, setListLimit] = useState(SLIDES_LIST_DEFAULT_LIMIT);
  const fetchListLimit = sentinelLimit(listLimit, SLIDES_LIST_MAX_LIMIT);
  const decksQuery = useQuery(slidesListFromDriveQueryOptions({ limit: fetchListLimit, query }));
  const isBackendUnavailable = decksQuery.isError;
  const [menuDeckId, setMenuDeckId] = useState<string | null>(null);
  const [renameDeck, setRenameDeck] = useState<SlideDeck | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generatePrompt, setGeneratePrompt] = useState(
    "Product launch, customer proof, rollout risks",
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [folder, setFolder] = useState<SlidesFolderId>("all");
  const [view, setView] = useDocumentSurfaceViewPreference();

  useEffect(() => {
    setListLimit(SLIDES_LIST_DEFAULT_LIMIT);
  }, [query]);

  const allDecks = useMemo(
    () => filterDecks((decksQuery.data ?? []).slice(0, listLimit), query),
    [decksQuery.data, listLimit, query],
  );
  const decks = useMemo(() => filterDecksByFolder(allDecks, folder), [allDecks, folder]);
  const heading = headingForSlidesFolder(folder);
  const generatedDeck = useMemo(() => generatePresentationDeck(generatePrompt), [generatePrompt]);
  const hasMore = (decksQuery.data?.length ?? 0) > listLimit && listLimit < SLIDES_LIST_MAX_LIMIT;
  const showMore = () =>
    setListLimit((current) => Math.min(current + SLIDES_LIST_DEFAULT_LIMIT, SLIDES_LIST_MAX_LIMIT));

  const clearError = () => setActionError(null);

  const createMutation = useMutation({
    mutationFn: (title: string) => createSlidesDeck({ title }),
    onMutate: clearError,
    onError: () => setActionError("Could not create a new deck. Please try again."),
    onSuccess: async (deck) => {
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.all });
      onOpen({ id: deck.id, openMode: "native" });
    },
  });

  const generateMutation = useMutation({
    mutationFn: async (prompt: string) => {
      const generated = generatePresentationDeck(prompt);
      const deck = await createSlidesDeck({
        title: generated.title,
        metadata: {
          generatedBy: "helix.presentation-assist.local",
          prompt: prompt.trim(),
        },
      });
      for (const [position, slide] of generated.slides.entries()) {
        await createSlidesSlide({
          deckId: deck.id,
          content: slide.content,
          speakerNotes: slide.speakerNotes,
          position,
        });
      }
      return deck;
    },
    onMutate: clearError,
    onError: () => setActionError("Could not generate that deck. Please try again."),
    onSuccess: async (deck) => {
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.all });
      setGenerateOpen(false);
      onOpen({ id: deck.id, openMode: "native" });
    },
  });

  const renameMutation = useMutation({
    mutationFn: (input: { readonly deckId: string; readonly title: string }) =>
      updateSlidesDeck(input),
    onMutate: clearError,
    onError: () => setActionError("Could not rename the deck. Please try again."),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.all });
      setRenameDeck(null);
    },
  });

  const invalidateLists = () => {
    void queryClient.invalidateQueries({ queryKey: slidesQueryKeys.all });
    void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
  };

  const trashMutation = useMutation({
    mutationFn: (objectId: string) => trashDriveObject(objectId),
    onMutate: clearError,
    onError: () => setActionError("Could not move that presentation to trash. Please try again."),
    onSettled: () => {
      setMenuDeckId(null);
      invalidateLists();
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (objectId: string) => restoreDriveObject(objectId),
    onMutate: clearError,
    onError: () => setActionError("Could not restore that presentation. Please try again."),
    onSettled: () => {
      setMenuDeckId(null);
      invalidateLists();
    },
  });

  const deleteForeverMutation = useMutation({
    mutationFn: (objectId: string) => deleteDriveObject(objectId),
    onMutate: clearError,
    onError: () =>
      setActionError("Could not permanently delete that presentation. Please try again."),
    onSettled: () => {
      setMenuDeckId(null);
      invalidateLists();
    },
  });

  const starMutation = useMutation({
    mutationFn: (vars: { readonly objectId: string; readonly starred: boolean }) =>
      setDriveObjectStarred(vars.objectId, vars.starred),
    onMutate: clearError,
    onError: () => setActionError("Could not update that presentation star. Please try again."),
    onSettled: () => {
      setMenuDeckId(null);
      invalidateLists();
    },
  });

  const importMutation = useMutation({
    mutationFn: (file: File) => uploadDriveFile({ file, folderId: null }),
    onMutate: clearError,
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(`Could not import presentation: ${message}`);
    },
    onSuccess: async (uploaded) => {
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.all });
      void router.navigate({
        to: "/open/$objectId",
        params: { objectId: uploaded.objectId },
      });
    },
  });

  function handleNewDeck() {
    if (createMutation.isPending || !editorsEnabled) {
      return;
    }
    createMutation.mutate("Untitled deck");
  }

  function handleImportPptx() {
    if (importMutation.isPending) {
      return;
    }
    importInputRef.current?.click();
  }

  function importPresentationFile(file: File | undefined) {
    if (file === undefined || importMutation.isPending) {
      return;
    }
    importMutation.mutate(file);
  }

  return (
    <>
      <input
        ref={importInputRef}
        type="file"
        accept={PRESENTATION_IMPORT_ACCEPT}
        aria-label="Import presentation"
        hidden
        onChange={(event) => {
          importPresentationFile(event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      <SlidesSidebar
        folder={folder}
        onFolder={setFolder}
        onNewPresentation={handleNewDeck}
        onImportPptx={handleImportPptx}
        isCreating={createMutation.isPending}
        isImporting={importMutation.isPending}
        editorsEnabled={editorsEnabled}
      />
      <div
        style={{
          padding: "24px 32px",
          overflowY: "auto",
          flex: 1,
          background: "var(--bg)",
          minWidth: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 20 }}>
          <h1 style={{ margin: 0, fontSize: "var(--text-h2)", fontWeight: 600 }}>{heading}</h1>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <DocumentSurfaceViewToggle view={view} onViewChange={setView} />
            <button type="button" className="btn">
              <Icons.Filter /> Filter
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setGenerateOpen((current) => !current)}
              disabled={generateMutation.isPending || !editorsEnabled}
              title={editorsEnabled ? undefined : EDITORS_ALPHA_DISABLED_TITLE}
            >
              <Icons.Sparkles /> Generate deck
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={handleNewDeck}
              disabled={createMutation.isPending || !editorsEnabled}
              title={editorsEnabled ? undefined : EDITORS_ALPHA_DISABLED_TITLE}
            >
              <Icons.Plus /> {createMutation.isPending ? "Creating…" : "New deck"}
            </button>
            {editorsEnabled ? <EditorsAlphaBadge /> : null}
          </div>
        </div>

        {editorsEnabled ? null : <EditorsAlphaDisabledNotice surface="Slides" />}

        {isBackendUnavailable ? (
          <div
            role="status"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              marginBottom: 16,
              fontSize: "var(--text-meta)",
              color: "var(--text-2)",
              background: "var(--warning-soft)",
              borderRadius: 6,
            }}
          >
            <Icons.Globe />
            Slides backend unavailable — showing seeded presentations only.
          </div>
        ) : null}

        {actionError !== null ? <ErrorBanner message={actionError} /> : null}

        {generateOpen && editorsEnabled ? (
          <section aria-label="Generate deck" style={GENERATE_PANEL_STYLE}>
            <label style={GENERATE_FIELD_STYLE}>
              <span style={GENERATE_LABEL_STYLE}>Prompt</span>
              <textarea
                aria-label="Deck prompt"
                value={generatePrompt}
                onChange={(event) => setGeneratePrompt(event.target.value)}
                rows={3}
                style={GENERATE_TEXTAREA_STYLE}
              />
            </label>
            <div style={GENERATE_PREVIEW_STYLE}>
              <strong>{generatedDeck.title}</strong>
              <span>
                {generatedDeck.slides.length} slides ·{" "}
                {generatedDeck.slides.map((slide) => slide.content.title).join(", ")}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn" onClick={() => setGenerateOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={generateMutation.isPending || generatePrompt.trim().length === 0}
                onClick={() => generateMutation.mutate(generatePrompt)}
              >
                {generateMutation.isPending ? "Generating…" : "Create generated deck"}
              </button>
            </div>
          </section>
        ) : null}

        {decksQuery.isPending ? (
          <div
            role="status"
            style={{
              padding: "64px 0",
              textAlign: "center",
              color: "var(--text-3)",
              fontSize: "var(--text-body-sm)",
            }}
          >
            Loading presentations…
          </div>
        ) : decks.length === 0 ? (
          <EmptyState folder={folder} query={query} onNewDeck={handleNewDeck} />
        ) : view === "grid" ? (
          <>
            <div className="section-label" style={sectionLabelStyle}>
              Presentations
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                gap: 12,
                marginBottom: 24,
              }}
            >
              {decks.map((deck) => (
                <RecentCard key={deck.id} deck={deck} onOpen={onOpen} />
              ))}
            </div>
            {hasMore ? <ShowMoreButton label="Show more presentations" onClick={showMore} /> : null}
          </>
        ) : (
          <>
            <div className="section-label" style={sectionLabelStyle}>
              All presentations
            </div>
            <div className="panel">
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: tableColumns,
                  padding: "8px 16px",
                  fontSize: "var(--text-caption)",
                  color: "var(--text-3)",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: ".06em",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <span>Name</span>
                <span>Owner</span>
                <span>Modified</span>
                <span>Slides</span>
                <span>Shared</span>
                <span />
              </div>
              {decks.map((deck) => (
                <DeckRow
                  key={deck.id}
                  deck={deck}
                  onOpen={onOpen}
                  menuOpen={menuDeckId === deck.id}
                  onToggleMenu={() =>
                    setMenuDeckId((current) => (current === deck.id ? null : deck.id))
                  }
                  onRename={() => {
                    setRenameDeck(deck);
                    setMenuDeckId(null);
                  }}
                  isTrash={folder === "trash"}
                  onTrash={() => trashMutation.mutate(deck.id)}
                  onRestore={() => restoreMutation.mutate(deck.id)}
                  onDeleteForever={() => deleteForeverMutation.mutate(deck.id)}
                  onSetStarred={() =>
                    starMutation.mutate({ objectId: deck.id, starred: !deck.starred })
                  }
                  busy={
                    (trashMutation.isPending && trashMutation.variables === deck.id) ||
                    (restoreMutation.isPending && restoreMutation.variables === deck.id) ||
                    (deleteForeverMutation.isPending &&
                      deleteForeverMutation.variables === deck.id) ||
                    (starMutation.isPending && starMutation.variables?.objectId === deck.id)
                  }
                />
              ))}
            </div>
            {hasMore ? <ShowMoreButton label="Show more presentations" onClick={showMore} /> : null}
          </>
        )}

        {renameDeck ? (
          <RenameDialog
            deck={renameDeck}
            inputId={renameInputId}
            pending={renameMutation.isPending}
            error={renameMutation.isError}
            onCancel={() => setRenameDeck(null)}
            onSubmit={(title) => renameMutation.mutate({ deckId: renameDeck.id, title })}
          />
        ) : null}
      </div>
    </>
  );
}

function SlidesSidebar({
  folder,
  onFolder,
  onNewPresentation,
  onImportPptx,
  isCreating = false,
  isImporting = false,
  editorsEnabled = true,
}: {
  readonly folder: SlidesFolderId;
  readonly onFolder: (folder: SlidesFolderId) => void;
  readonly onNewPresentation: () => void;
  readonly onImportPptx: () => void;
  readonly isCreating?: boolean;
  readonly isImporting?: boolean;
  readonly editorsEnabled?: boolean;
}) {
  return (
    <aside aria-label="Slides navigation" className="surf-sidebar">
      <button
        className="btn primary lg"
        type="button"
        onClick={onNewPresentation}
        disabled={isCreating || !editorsEnabled}
        title={editorsEnabled ? undefined : EDITORS_ALPHA_DISABLED_TITLE}
        style={{ width: "100%", marginBottom: 12 }}
      >
        <Icons.Plus /> {isCreating ? "Creating…" : "New presentation"}
      </button>
      <button
        className="btn lg"
        type="button"
        onClick={onImportPptx}
        disabled={isImporting}
        style={{ width: "100%", marginBottom: 12 }}
      >
        <Icons.Upload /> {isImporting ? "Importing..." : "Import"}
      </button>
      <nav aria-label="Presentation folders" style={{ overflowY: "auto", flex: 1 }}>
        {SLIDES_FOLDERS.map((entry) => {
          const Icon = entry.icon;
          const selected = folder === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              aria-current={selected ? "page" : undefined}
              onClick={() => onFolder(entry.id)}
              className="surf-nav-row"
            >
              <Icon />
              <span className="label">{entry.label}</span>
            </button>
          );
        })}

        <div className="surf-section-label">Templates</div>
        {SLIDES_TEMPLATES.map((template) => (
          <button key={template} type="button" className="surf-nav-row">
            <Icons.Image />
            <span className="label">{template}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

/** Apply the active folder selection to the deck list using Drive metadata. */
export function filterDecksByFolder(
  decks: readonly SlideDeck[],
  folder: SlidesFolderId,
): readonly SlideDeck[] {
  const scopedDecks =
    folder === "trash"
      ? decks.filter((deck) => deck.deletedAt !== null && deck.deletedAt !== undefined)
      : decks.filter((deck) => deck.deletedAt === null || deck.deletedAt === undefined);
  if (folder === "mine") {
    return scopedDecks.filter((deck) => deck.mine ?? deck.owner.toLowerCase() === "you");
  }
  if (folder === "recent") {
    return scopedDecks.slice(0, 5);
  }
  if (folder === "shared") {
    return scopedDecks.filter((deck) => deck.mine === false);
  }
  if (folder === "starred") {
    return scopedDecks.filter((deck) => deck.starred === true);
  }
  return scopedDecks;
}

function DeckRow({
  deck,
  onOpen,
  menuOpen,
  onToggleMenu,
  onRename,
  isTrash,
  onTrash,
  onRestore,
  onDeleteForever,
  onSetStarred,
  busy,
}: {
  readonly deck: SlideDeck;
  readonly onOpen: (deck: Pick<SlideDeck, "id" | "openMode">) => void;
  readonly menuOpen: boolean;
  readonly onToggleMenu: () => void;
  readonly onRename: () => void;
  readonly isTrash: boolean;
  readonly onTrash: () => void;
  readonly onRestore: () => void;
  readonly onDeleteForever: () => void;
  readonly onSetStarred: () => void;
  readonly busy: boolean;
}) {
  const isNativeBackendDeck = deck.source === "backend" && deck.openMode !== "office";
  const canManageDriveObject = deck.source === "backend";
  const passiveLabel = deck.openMode === "office" ? "Office" : "Seed";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: tableColumns,
        padding: "0 16px",
        height: 36,
        alignItems: "center",
        fontSize: "var(--text-meta)",
        borderBottom: "1px solid var(--border)",
        position: "relative",
        opacity: busy ? 0.5 : 1,
      }}
    >
      <button
        type="button"
        draggable
        onDragStart={(event) => {
          setHelixDriveItemDragData(event.dataTransfer, {
            id: deck.id,
            name: deck.title,
            href: deckDragHref(deck),
            mimeType: deck.mimeType,
            app: "slides",
          });
        }}
        onClick={() => onOpen(deck)}
        style={{
          display: "flex",
          alignItems: "center",
          height: 36,
          minWidth: 0,
          textAlign: "left",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          padding: 0,
          font: "inherit",
        }}
      >
        <div className="row gap-2" style={{ minWidth: 0 }}>
          <span style={{ color: "var(--accent)" }}>
            <Icons.Image />
          </span>
          <FileNameText name={deck.title} style={{ minWidth: 0 }} />
        </div>
      </button>
      <div className="row gap-2" style={{ minWidth: 0 }}>
        <Avatar name={deck.owner} size={18} />
        <span className="truncate">{deck.owner}</span>
      </div>
      <span style={{ color: "var(--text-2)" }}>{deck.modified}</span>
      <span style={{ color: "var(--text-2)" }}>{deck.slides}</span>
      <span style={{ color: "var(--text-2)" }}>{deck.shared} people</span>
      <span style={{ display: "flex", justifyContent: "flex-end" }}>
        {canManageDriveObject ? (
          <button
            type="button"
            className="icon-btn"
            aria-label={`More actions for ${deck.title}`}
            aria-expanded={menuOpen}
            disabled={busy}
            onClick={onToggleMenu}
          >
            <Icons.MoreV />
          </button>
        ) : (
          <span
            title={
              deck.openMode === "office" ? "Opens in the Office editor" : "Seeded preview deck"
            }
            style={{ color: "var(--text-3)", fontSize: "var(--text-chip)" }}
          >
            {passiveLabel}
          </span>
        )}
      </span>
      {menuOpen ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 12,
            top: 34,
            zIndex: 5,
            minWidth: 140,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "var(--shadow-md)",
            padding: 4,
          }}
        >
          {isNativeBackendDeck && !isTrash ? (
            <button type="button" role="menuitem" onClick={onRename} style={menuItemStyle}>
              <Icons.EditPen /> Rename
            </button>
          ) : null}
          {isTrash ? (
            <>
              <button type="button" role="menuitem" onClick={onRestore} style={menuItemStyle}>
                <Icons.History /> Restore
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={onDeleteForever}
                style={{ ...menuItemStyle, color: "var(--danger)" }}
              >
                <Icons.Trash /> Delete forever
              </button>
            </>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={onSetStarred} style={menuItemStyle}>
                <Icons.Star fill={deck.starred ? "currentColor" : "none"} />{" "}
                {deck.starred ? "Unstar" : "Star"}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={onTrash}
                style={{ ...menuItemStyle, color: "var(--danger)" }}
              >
                <Icons.Trash /> Move to trash
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function deckDragHref(deck: SlideDeck): string {
  const suffix = deck.openMode === "office" ? "&open=office" : "";
  return `/slides?deck=${encodeURIComponent(deck.id)}${suffix}`;
}

function RenameDialog({
  deck,
  inputId,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  readonly deck: SlideDeck;
  readonly inputId: string;
  readonly pending: boolean;
  readonly error: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (title: string) => void;
}) {
  const [title, setTitle] = useState(deck.title);
  const trimmed = title.trim();
  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "grid",
        placeItems: "center",
        zIndex: 50,
      }}
      onClick={onCancel}
    >
      <form
        aria-label="Rename presentation"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed.length > 0 && !pending) {
            onSubmit(trimmed);
          }
        }}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 20,
          width: 360,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <h2 style={{ margin: 0, fontSize: "var(--text-body-lg)", fontWeight: 600 }}>
          Rename presentation
        </h2>
        <label htmlFor={inputId} style={{ fontSize: "var(--text-meta)", color: "var(--text-3)" }}>
          Title
        </label>
        <input
          id={inputId}
          className="input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        {error ? (
          <span style={{ fontSize: "var(--text-meta)", color: "var(--danger)" }}>
            Could not rename the deck. Please try again.
          </span>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={pending || trimmed.length === 0}>
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ErrorBanner({ message }: { readonly message: string }) {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        marginBottom: 16,
        fontSize: "var(--text-meta)",
        color: "var(--danger)",
        background: "var(--danger-soft)",
        borderRadius: 6,
      }}
    >
      {message}
    </div>
  );
}

function EmptyState({
  query,
  folder = "all",
  onNewDeck,
}: {
  readonly query: string;
  readonly folder?: SlidesFolderId;
  readonly onNewDeck: () => void;
}) {
  const hasQuery = query.trim().length > 0;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        padding: "64px 0",
        color: "var(--text-3)",
      }}
    >
      <Icons.Image size={32} />
      <div style={{ fontSize: "var(--text-body-sm)", fontWeight: 500, color: "var(--text-2)" }}>
        {emptySlidesMessage(folder, hasQuery ? query : null)}
      </div>
      {hasQuery || folder !== "all" ? null : (
        <button type="button" className="btn primary" onClick={onNewDeck}>
          <Icons.Plus /> New deck
        </button>
      )}
    </div>
  );
}

function emptySlidesMessage(folder: SlidesFolderId, query: string | null): string {
  if (query !== null) {
    return `No presentations for “${query}”`;
  }
  if (folder === "shared") {
    return "No shared presentations yet.";
  }
  if (folder === "starred") {
    return "No starred presentations yet.";
  }
  if (folder === "trash") {
    return "Trash is empty.";
  }
  if (folder === "mine") {
    return "No presentations owned by you yet.";
  }
  if (folder === "recent") {
    return "No recent presentations yet.";
  }
  return "No presentations yet";
}
