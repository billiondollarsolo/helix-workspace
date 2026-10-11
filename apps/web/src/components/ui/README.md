# UI primitives

Shared, accessible building blocks for every Helix surface. Import from
`@/components/ui/<file>`. Each primitive owns its ARIA roles, keyboard
behaviour, and focus handling, so features compose them rather than
re-implementing menus, lists, or pickers. Colours, type, spacing, and motion
come from the tokens in `src/styles.css`.

| Primitive       | Import                                                                     | Use it for                                    |
| --------------- | -------------------------------------------------------------------------- | --------------------------------------------- |
| Menu            | `Menu, MenuTrigger, MenuContent, MenuItem, MenuSub…` from `menu`           | Dropdown menus, row ⋮ menus, "Move to"        |
| ContextMenu     | `ContextMenu, ContextMenuTrigger, ContextMenuContent…` from `context-menu` | Right-click and Shift+F10 menus on rows/cards |
| Popover         | `Popover, PopoverTrigger, PopoverContent, PopoverClose` from `popover`     | Event details, quick create, snooze picker    |
| Toast           | `notify, dismissNotification` from `toast`                                 | Confirmations with Undo                       |
| SplitButton     | `SplitButton` from `split-button`                                          | Send ▾ (schedule send)                        |
| Skeleton        | `Skeleton` from `skeleton`                                                 | Loading rows, cards, and text                 |
| EmptyState      | `EmptyState` from `empty-state`                                            | Empty lists and panes                         |
| InlineError     | `InlineError` from `inline-error`                                          | Failed loads with Retry                       |
| Pager           | `Pager, pagerRange` from `pager`                                           | "1–50 of 1,234 ‹ ›"                           |
| DateTimePicker  | `DateTimePicker` from `date-time-picker`                                   | Snooze, schedule send, event times            |
| SideSheet       | `SideSheet` from `side-sheet`                                              | Right-side details and filter panels          |
| SelectableList  | `SelectableList, SelectAllCheckbox, keyRange` from `selectable-list`       | Mail threads, files, people, admin rows       |
| Button          | `Button` from `button`                                                     | Every button                                  |
| Dialog          | `Dialog` from `helix-dialog`; `AlertDialog…` from `alert-dialog`           | Modal forms and confirmations                 |
| Avatar, Tooltip | `Avatar` from `avatar`, `Tooltip` from `tooltip`                           | People and icon labels                        |

## Menu

Radix DropdownMenu with the Helix look: roving focus (Arrow/Home/End),
typeahead, submenus (ArrowRight/ArrowLeft), Escape, focus back to the trigger.

```tsx
<Menu>
  <MenuTrigger asChild>
    <Button variant="ghost" size="icon" aria-label="More actions">
      <MoreVertical />
    </Button>
  </MenuTrigger>
  <MenuContent>
    <MenuItem icon={<Archive />} shortcut="e" onSelect={archive}>
      Archive
    </MenuItem>
    <MenuItem destructive onSelect={remove}>
      Delete
    </MenuItem>
    <MenuSeparator />
    <MenuSub>
      <MenuSubTrigger>Label as</MenuSubTrigger>
      <MenuSubContent>…</MenuSubContent>
    </MenuSub>
  </MenuContent>
</Menu>
```

`MenuItem` adds `icon`, `shortcut` (visual hint, hidden from assistive tech)
and `destructive`. Also: `MenuCheckboxItem`, `MenuRadioGroup`,
`MenuRadioItem`, `MenuLabel`, `MenuGroup`.

## ContextMenu

Same items as Menu (`ContextMenuItem`, `ContextMenuCheckboxItem`,
`ContextMenuLabel`, `ContextMenuSeparator`, `ContextMenuSub*`).
`ContextMenuTrigger` also opens on Shift+F10 and the Menu key at the focused
target. Wrap a focusable row with `asChild`. `isContextMenuKey(event)` is
exported for custom handlers.

## Toast

The app mounts one `AppToaster` (bottom-left, inverted snackbar colours).

```ts
notify({
  message: "Conversation archived",
  action: { label: "Undo", onAction: () => restore(id) },
  onClose: (reason) => reason !== "action" && commit(id), // "action" | "timeout" | "dismissed"
});
```

Options: `description`, `tone` (`default` | `success` | `error`), `duration`
(default 4s, 8s with an action, 10s for errors), `id` (replace in place), and
`secondaryAction` for a second inline action after `action` (Mail's
"Message sent · Undo · View message").

## SplitButton

```tsx
<SplitButton label="Send" onClick={send} menuLabel="More send options">
  <MenuItem icon={<Clock />} onSelect={openSchedule}>
    Schedule send
  </MenuItem>
</SplitButton>
```

Props: `icon`, `variant` (`primary` | `secondary`), `size` (`default` | `sm`),
`disabled`, `actionDisabled` (main half only), `type`.

## Skeleton, EmptyState, InlineError

```tsx
<Skeleton variant="row" count={8} label="Loading conversations" />
<EmptyState icon={<Inbox />} title="No conversations" body="…" action={<Button>Compose</Button>} />
<InlineError title="Couldn't load mail" message={message} onRetry={refetch} retrying={isFetching} />
```

Skeleton variants: `row` (follows density tokens), `card`, `text`. EmptyState
takes `headingLevel` (2–4) and `size` (`page` | `inline`). InlineError takes
`retryLabel`, `actions`, and `variant` (`banner` | `compact`).

## Pager

```tsx
<Pager start={offset} pageCount={rows.length} total={total} onPrevious={newer} onNext={older} />
```

Renders nothing for an empty list and a placeholder while `loading`. With an
unknown `total`, pass `hasMore`; the range reads "of many". Labels default to
Newer / Older.

## DateTimePicker

```tsx
<DateTimePicker value={when} onChange={setWhen} min={new Date()} />
```

Props: `mode` (`datetime` | `date`), `timeStepMinutes` (30),
`weekStartsOn` (0 | 1 | 6), `defaultTimeMinutes` (8:00), `label`. The grid
follows the WAI-ARIA date grid keys (arrows, Home/End, PageUp/PageDown,
Shift+PageUp/PageDown); the time list is a listbox.

## SideSheet

```tsx
<SideSheet open={open} onOpenChange={setOpen} title="Details" description="…" footer={…}>
  …
</SideSheet>
```

Modal right-side panel: focus trapped, Escape and backdrop close, focus
returns to the opener. `size`: `sm` | `md` | `lg`.

## SelectableList

A `role="grid"` list where the row is the roving focus target and never a
button, so in-row controls (star, hover actions) are not nested interactives.

```tsx
<SelectableList
  items={threads}
  getKey={(t) => t.id}
  getItemLabel={(t) => t.subject}
  label="Conversations"
  selectedKeys={selected}
  onSelectedKeysChange={setSelected}
  onOpen={openThread}
  onSelectAll={selectAllMatching}
  renderItem={(t, { tabIndex }) => <ThreadRow thread={t} starTabIndex={tabIndex} />}
/>
```

Keys: j/k and arrows move (Shift extends), Home/End, x or Space toggles,
Enter or o opens, Ctrl/Cmd+A selects all, Escape clears. Shift-click selects
a range; Ctrl/Cmd-click toggles. Pair with `SelectAllCheckbox` (tri-state).
File lists pass `selectOnClick`: a click selects just that row and a double-click opens it.
Each row carries `data-key`, for context menus and drop targets.

## Tokens and lint

- Type: `type-display`, `type-h1`–`type-h3`, `type-body-lg`, `type-body`,
  `type-body-sm`, `type-meta`, `type-caption`, `type-chip`, `type-overline`,
  `type-row` (density-aware). They follow the user's text size setting.
- Colour: `--label-<name>` / `--label-<name>-soft` (24 hues, text on solid
  fills uses `--label-on`), `--star`, `--important`, `--cal-*`, `--focus-ring*`.
- Spacing `--space-*`, motion `--motion-duration-*` / `--motion-ease-*`
  (zero under reduced motion), `focus-ring` utility.
- Density: `data-density="default|comfortable|compact"`; mark inline extras
  hidden outside Default with `.density-rich`.
- The `helix-web/design-tokens` lint rule rejects raw hex colours and
  arbitrary font sizes. Remaining legacy offenders are counted in
  `apps/web/design-token-baseline.json`; counts may only go down.
