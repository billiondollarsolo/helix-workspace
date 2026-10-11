/* Emoji picker — a searchable grid used for reactions and the composer.
   Arrow keys move between emoji (eight per row), Enter or Space picks. */

import { useId, useState, type KeyboardEvent } from "react";
import { EMOJI_CATEGORIES, searchEmoji, type EmojiEntry } from "./emoji-data";

const COLUMNS = 8;

export function EmojiPicker({
  onSelect,
  label = "Emoji",
}: {
  readonly onSelect: (emoji: string) => void;
  readonly label?: string;
}) {
  const [query, setQuery] = useState("");
  const id = useId();
  const searching = query.trim().length > 0;
  const results = searching ? searchEmoji(query) : [];

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Partial<Record<string, number>> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: COLUMNS,
      ArrowUp: -COLUMNS,
    };
    const step = steps[event.key];
    if (step === undefined) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-emoji]")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, index + step))]?.focus();
  };

  return (
    <div className="chat-emoji-picker" role="group" aria-label={label}>
      <input
        type="search"
        className="chat-emoji-search"
        placeholder="Search emoji"
        aria-label="Search emoji"
        autoComplete="off"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            event.currentTarget.parentElement
              ?.querySelector<HTMLButtonElement>("[data-emoji]")
              ?.focus();
          }
        }}
      />
      <div className="chat-emoji-scroll" onKeyDown={moveFocus}>
        {searching ? (
          results.length === 0 ? (
            <p className="chat-emoji-empty">No emoji match “{query.trim()}”.</p>
          ) : (
            <EmojiGrid entries={results} onSelect={onSelect} />
          )
        ) : (
          EMOJI_CATEGORIES.map((category) => (
            <section key={category.id} aria-labelledby={`${id}-${category.id}`}>
              <h3 id={`${id}-${category.id}`} className="chat-emoji-heading">
                {category.label}
              </h3>
              <EmojiGrid entries={category.emoji} onSelect={onSelect} />
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function EmojiGrid({
  entries,
  onSelect,
}: {
  readonly entries: readonly EmojiEntry[];
  readonly onSelect: (emoji: string) => void;
}) {
  return (
    <div className="chat-emoji-grid">
      {entries.map((entry) => (
        <button
          key={entry.emoji}
          type="button"
          className="chat-emoji-option"
          data-emoji
          aria-label={entry.name}
          title={entry.name}
          onClick={() => onSelect(entry.emoji)}
        >
          <span aria-hidden="true">{entry.emoji}</span>
        </button>
      ))}
    </div>
  );
}
