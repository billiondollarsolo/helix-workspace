import {
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { usePeopleSearch } from "@/features/people/api";
import {
  externalPersonRef,
  isPersonRefValid,
  parseAddressList,
  personRefFromDirectory,
  personRefKey,
  type PersonRef,
} from "@/features/people/person-ref";
import { PersonAvatar, PersonChip } from "./person-chip";
import "./people.css";

export interface PeoplePickerProps {
  readonly value: readonly PersonRef[];
  readonly onChange: (value: PersonRef[]) => void;
  /** Visible field label, e.g. "To". Also names the combobox. */
  readonly label: string;
  /** Accept any valid email address, not only org members. */
  readonly allowExternal?: boolean;
  readonly allowGroups?: boolean;
  readonly placeholder?: string;
  /** Maximum number of chips; the text input hides once it is reached. */
  readonly max?: number;
  /** Put the label above the field, as in a form whose other labels sit above. */
  readonly stacked?: boolean;
}

const MAX_SUGGESTIONS = 8;

/** Recipient chip input with directory typeahead (WAI-ARIA combobox with a listbox popup). */
export function PeoplePicker({
  value,
  onChange,
  label,
  allowExternal = false,
  allowGroups = false,
  placeholder,
  max = Number.POSITIVE_INFINITY,
  stacked = false,
}: PeoplePickerProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const inputId = `${id}-input`;
  const listboxId = `${id}-listbox`;
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const rules = { allowExternal, allowGroups };
  const search = usePeopleSearch(text);
  const selectedKeys = useMemo(() => new Set(value.map(personRefKey)), [value]);
  const suggestions = search.people
    .map(personRefFromDirectory)
    .filter((ref) => isPersonRefValid(ref, rules) && !selectedKeys.has(personRefKey(ref)))
    .slice(0, MAX_SUGGESTIONS);
  const full = value.length >= max;
  const open = focused && !dismissed && text.trim().length > 0 && suggestions.length > 0;
  const active = open ? Math.min(activeIndex, suggestions.length - 1) : -1;
  const optionId = (index: number) => `${listboxId}-${String(index)}`;

  function add(refs: readonly PersonRef[]) {
    const next = [...value];
    const keys = new Set(selectedKeys);
    for (const ref of refs) {
      const key = personRefKey(ref);
      if (next.length >= max || keys.has(key)) continue;
      keys.add(key);
      next.push(ref);
    }
    setText("");
    setActiveIndex(0);
    setDismissed(false);
    if (next.length !== value.length) onChange(next);
  }

  function resolveTyped(typed: string): PersonRef {
    const raw = externalPersonRef(typed);
    const email = raw.email?.toLowerCase();
    return suggestions.find((ref) => ref.email?.toLowerCase() === email) ?? raw;
  }

  /** Commits the highlighted suggestion, or the typed text when nothing is highlighted. */
  function commit(useSuggestion: boolean): boolean {
    const typed = text.trim();
    if (typed.length === 0) return false;
    const suggestion = useSuggestion && active >= 0 ? suggestions[active] : undefined;
    add([suggestion ?? resolveTyped(typed)]);
    return true;
  }

  function removeAt(index: number) {
    onChange(value.filter((_, position) => position !== index));
  }

  function edit(index: number) {
    const ref = value[index];
    if (ref === undefined) return;
    removeAt(index);
    setText(ref.email ?? ref.displayName);
    setDismissed(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (suggestions.length === 0) return;
        event.preventDefault();
        setDismissed(false);
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((Math.max(active, 0) + step + suggestions.length) % suggestions.length);
        return;
      }
      case "Enter":
        if (commit(true)) event.preventDefault();
        return;
      case "Tab":
        commit(true);
        return;
      case ",":
      case ";":
        event.preventDefault();
        commit(false);
        return;
      case "Backspace":
        if (text.length === 0 && value.length > 0) {
          event.preventDefault();
          removeAt(value.length - 1);
        }
        return;
      case "Escape":
        if (open) {
          event.preventDefault();
          event.stopPropagation();
          setDismissed(true);
        }
        return;
    }
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    const refs = parseAddressList(pasted);
    if (refs.length < 2 && !/[,;\n]/u.test(pasted)) return;
    event.preventDefault();
    add(refs);
  }

  function onBlur(event: FocusEvent<HTMLDivElement>) {
    if (event.relatedTarget instanceof Node && fieldRef.current?.contains(event.relatedTarget)) {
      return;
    }
    setFocused(false);
    commit(false);
  }

  return (
    <div className="people-picker" data-stacked={stacked || undefined}>
      <label id={labelId} htmlFor={inputId} className="people-picker-label">
        {label}
      </label>
      <div
        ref={fieldRef}
        role="group"
        aria-labelledby={labelId}
        className="people-picker-field"
        onFocus={() => {
          setFocused(true);
        }}
        onBlur={onBlur}
        onClick={(event) => {
          if (event.target === event.currentTarget) inputRef.current?.focus();
        }}
      >
        {value.length === 0 ? null : (
          <ul className="people-picker-chips" aria-label={`${label} recipients`}>
            {value.map((ref, index) => (
              <li key={personRefKey(ref)}>
                <PersonChip
                  person={ref}
                  invalid={!isPersonRefValid(ref, rules)}
                  onEdit={() => {
                    edit(index);
                  }}
                  onRemove={() => {
                    removeAt(index);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        {full ? null : (
          <input
            ref={inputRef}
            id={inputId}
            className="people-picker-input"
            type="text"
            role="combobox"
            autoComplete="off"
            spellCheck={false}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            placeholder={value.length === 0 ? placeholder : undefined}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setActiveIndex(0);
              setDismissed(false);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        )}
      </div>
      <ul
        id={listboxId}
        role="listbox"
        aria-label={`${label} suggestions`}
        className="people-picker-listbox"
        hidden={!open}
      >
        {open
          ? suggestions.map((ref, index) => (
              <li
                key={personRefKey(ref)}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                className="people-picker-option"
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onMouseEnter={() => {
                  setActiveIndex(index);
                }}
                onClick={() => {
                  add([ref]);
                }}
              >
                <PersonAvatar person={ref} size={28} />
                <span className="people-option-text">
                  <span className="people-option-name">{ref.displayName}</span>
                  <span className="people-option-detail">
                    {[ref.email, ref.title ?? (ref.kind === "group" ? "Group" : null)]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              </li>
            ))
          : null}
      </ul>
      <span className="sr-only" role="status">
        {open ? `${String(suggestions.length)} suggestions` : search.error ? "Search failed" : ""}
      </span>
    </div>
  );
}
