/* SlidesList — the Slides surface list view.
   Thumbnail-first Recent grid (16:9 violet-gradient cards) plus an
   "All presentations" table. Ported from the handoff (app-slides.jsx),
   wired to the Slides backend (`slides.deck.*` tools) via TanStack Query.

   Live backend decks are merged over the typed handoff seed; when the
   backend is unavailable the surface falls back to seed data only. Seed
   rows are read-only — create / rename / delete act on backend decks. */

import { useId, useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Avatar } from "@/components/ui/avatar";
import { Icons } from "@/components/icons";
import { createSlidesDeck, deleteSlidesDeck, updateSlidesDeck } from "./api";
import { mergeDriveDecks } from "./mapping";
import { slidesListFromDriveQueryOptions, slidesQueryKeys } from "./queries";
import { DECKS, type SlideDeck } from "./seed";

interface SlidesListProps {
  /** Open a deck in the editor. */
  readonly onOpen: (deckId: string) => void;
  /** Live search query from the TopBar. */
  readonly query: string;
}

const sectionLabelStyle = {
  padding: "0 0 8px",
} as const;

const tableColumns = "1fr 160px 140px 80px 80px 64px";

const menuItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 10px",
  fontSize: 12,
  textAlign: "left",
  border: "none",
  borderRadius: 6,
  background: "transparent",
  cursor: "pointer",
  font: "inherit",
};

function RecentCard({
  deck,
  onOpen,
}: {
  readonly deck: SlideDeck;
  readonly onOpen: (deckId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(deck.id)}
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
      <div
        style={{
          aspectRatio: "16 / 9",
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
            fontSize: 9,
            opacity: 0.7,
            textTransform: "uppercase",
            letterSpacing: ".08em",
            marginBottom: 4,
          }}
        >
          {deck.slides} slides
        </div>
        <div
          className="truncate"
          style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-0.01em" }}
        >
          {deck.title}
        </div>
      </div>
      <div style={{ padding: "8px 10px", borderTop: "1px solid var(--border)" }}>
        <div className="truncate" style={{ fontSize: 12, fontWeight: 500 }}>
          {deck.title}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-3)" }}>{deck.modified}</div>
      </div>
    </button>
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

export function SlidesList({ onOpen, query }: SlidesListProps) {
  const queryClient = useQueryClient();
  const renameInputId = useId();
  const decksQuery = useQuery(slidesListFromDriveQueryOptions({ limit: 100 }));
  const isBackendUnavailable = decksQuery.isError;
  const [menuDeckId, setMenuDeckId] = useState<string | null>(null);
  const [renameDeck, setRenameDeck] = useState<SlideDeck | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const decks = useMemo(
    () => filterDecks(mergeDriveDecks(DECKS, decksQuery.data), query),
    [decksQuery.data, query],
  );
  const recent = decks.slice(0, 4);

  const clearError = () => setActionError(null);

  const createMutation = useMutation({
    mutationFn: (title: string) => createSlidesDeck({ title }),
    onMutate: clearError,
    onError: () => setActionError("Could not create a new deck. Please try again."),
    onSuccess: async (deck) => {
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.all });
      onOpen(deck.id);
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

  const deleteMutation = useMutation({
    mutationFn: (deckId: string) => deleteSlidesDeck({ deckId }),
    onMutate: clearError,
    onError: () => setActionError("Could not delete that deck. Please try again."),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: slidesQueryKeys.all });
      setMenuDeckId(null);
    },
  });

  function handleNewDeck() {
    if (createMutation.isPending) {
      return;
    }
    createMutation.mutate("Untitled deck");
  }

  return (
    <div
      style={{
        padding: "24px 32px",
        overflowY: "auto",
        flex: 1,
        background: "var(--bg)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Presentations</h1>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button type="button" className="btn">
            <Icons.Filter /> Filter
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={handleNewDeck}
            disabled={createMutation.isPending}
          >
            <Icons.Plus /> {createMutation.isPending ? "Creating…" : "New deck"}
          </button>
        </div>
      </div>

      {isBackendUnavailable ? (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            marginBottom: 16,
            fontSize: 12,
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

      {decksQuery.isPending ? (
        <div
          role="status"
          style={{ padding: "64px 0", textAlign: "center", color: "var(--text-3)", fontSize: 13 }}
        >
          Loading presentations…
        </div>
      ) : decks.length === 0 ? (
        <EmptyState query={query} onNewDeck={handleNewDeck} />
      ) : (
        <>
          <div className="section-label" style={sectionLabelStyle}>
            Recent
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
              gap: 12,
              marginBottom: 24,
            }}
          >
            {recent.map((deck) => (
              <RecentCard key={deck.id} deck={deck} onOpen={onOpen} />
            ))}
          </div>

          <div className="section-label" style={sectionLabelStyle}>
            All presentations
          </div>
          <div className="panel">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: tableColumns,
                padding: "8px 16px",
                fontSize: 11,
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
                onDelete={() => deleteMutation.mutate(deck.id)}
                deleting={deleteMutation.isPending && deleteMutation.variables === deck.id}
              />
            ))}
          </div>
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
  );
}

function DeckRow({
  deck,
  onOpen,
  menuOpen,
  onToggleMenu,
  onRename,
  onDelete,
  deleting,
}: {
  readonly deck: SlideDeck;
  readonly onOpen: (deckId: string) => void;
  readonly menuOpen: boolean;
  readonly onToggleMenu: () => void;
  readonly onRename: () => void;
  readonly onDelete: () => void;
  readonly deleting: boolean;
}) {
  const isBackend = deck.source === "backend";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: tableColumns,
        padding: "0 16px",
        height: 36,
        alignItems: "center",
        fontSize: 12,
        borderBottom: "1px solid var(--border)",
        position: "relative",
        opacity: deleting ? 0.5 : 1,
      }}
    >
      <button
        type="button"
        onClick={() => onOpen(deck.id)}
        style={{
          gridColumn: "1 / 4",
          display: "grid",
          gridTemplateColumns: "1fr 160px 140px",
          alignItems: "center",
          height: 36,
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
          <span className="truncate">{deck.title}</span>
        </div>
        <div className="row gap-2">
          <Avatar name={deck.owner} size={18} />
          <span className="truncate">{deck.owner}</span>
        </div>
        <span style={{ color: "var(--text-2)" }}>{deck.modified}</span>
      </button>
      <span style={{ color: "var(--text-2)" }}>{deck.slides}</span>
      <span style={{ color: "var(--text-2)" }}>{deck.shared} people</span>
      <span style={{ display: "flex", justifyContent: "flex-end" }}>
        {isBackend ? (
          <button
            type="button"
            className="icon-btn"
            aria-label={`More actions for ${deck.title}`}
            aria-expanded={menuOpen}
            onClick={onToggleMenu}
          >
            <Icons.MoreV />
          </button>
        ) : (
          <span title="Seeded preview deck" style={{ color: "var(--text-3)", fontSize: 10 }}>
            Seed
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
          <button type="button" role="menuitem" onClick={onRename} style={menuItemStyle}>
            <Icons.EditPen /> Rename
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={onDelete}
            style={{ ...menuItemStyle, color: "var(--danger)" }}
          >
            <Icons.Trash /> Delete
          </button>
        </div>
      ) : null}
    </div>
  );
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
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Rename presentation</h2>
        <label htmlFor={inputId} style={{ fontSize: 12, color: "var(--text-3)" }}>
          Title
        </label>
        <input
          id={inputId}
          className="input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        {error ? (
          <span style={{ fontSize: 12, color: "var(--danger)" }}>
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
        fontSize: 12,
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
  onNewDeck,
}: {
  readonly query: string;
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
      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-2)" }}>
        {hasQuery ? <>No presentations for &ldquo;{query}&rdquo;</> : "No presentations yet"}
      </div>
      {hasQuery ? null : (
        <button type="button" className="btn primary" onClick={onNewDeck}>
          <Icons.Plus /> New deck
        </button>
      )}
    </div>
  );
}
