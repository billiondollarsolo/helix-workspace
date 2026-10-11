/* The conversation list: toolbar, "Search results" heading, Inbox category
   tabs, the select-all banner, and the rows on SelectableList (one tab stop,
   j/k/x/o, Shift-range). Loading shows skeleton rows, a failed load shows
   Retry, and each folder has its own empty state. */

import { Button } from "@/components/ui/button";
import { isContextMenuKey } from "@/components/ui/context-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { SelectableList } from "@/components/ui/selectable-list";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Pencil } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import type { MailFolderKey, MailLabelSummary, MailThreadRow } from "./api";
import { MailListToolbar, type MailBulkHandlers } from "./mail-list-toolbar";
import { MailRowContextMenu, type RowMenuHandlers } from "./mail-row-context-menu";
import { SnoozeDateDialog } from "./mail-snooze-picker";
import {
  LABEL_EMPTY,
  MAIL_FOLDERS,
  MAIL_TABS,
  SEARCH_EMPTY,
  type MailTabId,
} from "./mail-taxonomy";
import { ThreadRow } from "./mail-thread-row";

const COUNT = new Intl.NumberFormat();

interface ThreadListProps extends Omit<RowMenuHandlers, "onPickSnoozeDate">, MailBulkHandlers {
  readonly rows: readonly MailThreadRow[];
  readonly folder: MailFolderKey;
  readonly tab: MailTabId;
  readonly onTab: (tab: MailTabId) => void;
  readonly query: string;
  readonly onClearSearch: () => void;
  readonly activeLabel: MailLabelSummary | null;
  readonly labels: readonly MailLabelSummary[];
  readonly labelsBySlug: ReadonlyMap<string, MailLabelSummary>;
  readonly total: number;
  readonly offset: number;
  readonly pageSize: number;
  readonly onPage: (offset: number) => void;
  readonly loading: boolean;
  readonly error: string | null;
  readonly retrying: boolean;
  readonly onRetry: () => void;
  readonly selectedIds: ReadonlySet<string>;
  readonly onSelectedChange: (ids: Set<string>) => void;
  /** Every conversation the view matches is selected, not only this page. */
  readonly allMatching: boolean;
  readonly onAllMatchingChange: (all: boolean) => void;
  /** The conversation open beside the list (reading pane), if any. */
  readonly openThreadId: string | null;
  readonly onOpen: (row: MailThreadRow) => void;
  readonly onRefresh: () => void;
  readonly onMarkAllRead: () => void;
  readonly onCompose: () => void;
  readonly showAvatars: boolean;
}

/** Where the selection banner says the conversations are. */
function placeName(folder: MailFolderKey, label: MailLabelSummary | null, query: string): string {
  if (query !== "") return "that match this search";
  if (label !== null) return `labelled ${label.name}`;
  return `in ${MAIL_FOLDERS[folder].label}`;
}

function ListEmpty({
  folder,
  tab,
  query,
  label,
  onClearSearch,
}: Pick<ThreadListProps, "folder" | "tab" | "query" | "onClearSearch"> & {
  readonly label: MailLabelSummary | null;
}) {
  if (query !== "") {
    const Icon = SEARCH_EMPTY.icon;
    return (
      <EmptyState
        icon={<Icon />}
        title={SEARCH_EMPTY.title}
        body={SEARCH_EMPTY.body}
        action={
          <Button type="button" variant="outline" size="sm" onClick={onClearSearch}>
            Clear search
          </Button>
        }
      />
    );
  }
  if (label !== null) {
    const Icon = LABEL_EMPTY.icon;
    return <EmptyState icon={<Icon />} title={LABEL_EMPTY.title} body={LABEL_EMPTY.body} />;
  }
  const meta = MAIL_FOLDERS[folder];
  const tabEntry = MAIL_TABS.find((entry) => entry.id === tab);
  const Icon = folder === "inbox" && tab !== "primary" && tabEntry ? tabEntry.icon : meta.icon;
  return (
    <EmptyState
      icon={<Icon />}
      title={
        folder === "inbox" && tab !== "primary" && tabEntry
          ? `No conversations in ${tabEntry.label}`
          : meta.emptyTitle
      }
      body={meta.emptyBody}
    />
  );
}

export function ThreadList(props: ThreadListProps) {
  const {
    rows,
    folder,
    tab,
    onTab,
    query,
    activeLabel,
    labels,
    labelsBySlug,
    total,
    loading,
    error,
    selectedIds,
    onSelectedChange,
    allMatching,
    onAllMatchingChange,
    openThreadId,
    onOpen,
    showAvatars,
  } = props;
  const [pickDateFor, setPickDateFor] = useState<readonly string[] | null>(null);
  const showTabs = folder === "inbox" && activeLabel === null && query === "";
  const pageSelected = rows.length > 0 && rows.every((row) => selectedIds.has(row.threadId));
  const place = placeName(folder, activeLabel, query);

  const targetsFor = (row: MailThreadRow) =>
    selectedIds.has(row.threadId) ? rows.filter((entry) => selectedIds.has(entry.threadId)) : [row];

  const openContextMenuFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isContextMenuKey(event) || !(event.target instanceof HTMLElement)) return;
    const content = event.target.querySelector<HTMLElement>("[data-thread-id]");
    if (content === null) return;
    event.preventDefault();
    const rect = content.getBoundingClientRect();
    content.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 8,
        clientY: rect.bottom,
      }),
    );
  };

  return (
    <div className="mail-list">
      <MailListToolbar
        rows={rows}
        selectedIds={selectedIds}
        onSelectedChange={(ids) => {
          onAllMatchingChange(false);
          onSelectedChange(ids);
        }}
        folder={folder}
        labels={labels}
        offset={props.offset}
        total={total}
        onPage={props.onPage}
        pageSize={props.pageSize}
        onRefresh={props.onRefresh}
        onMarkAllRead={props.onMarkAllRead}
        onBulkAction={props.onBulkAction}
        onBulkMove={props.onBulkMove}
        onBulkSnooze={props.onBulkSnooze}
      />
      {query === "" ? null : <h2 className="mail-list-heading">Search results</h2>}
      {showTabs ? (
        <div className="mail-tabs" role="tablist" aria-label="Inbox categories">
          {MAIL_TABS.map((entry) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                className={cn("mail-tab focus-ring", tab === entry.id && "is-active")}
                onClick={() => onTab(entry.id)}
              >
                <Icon aria-hidden="true" /> {entry.label}
              </button>
            );
          })}
        </div>
      ) : null}
      {pageSelected && total > rows.length ? (
        <div className="mail-select-banner" role="status">
          {allMatching ? (
            <>
              <span>
                All {COUNT.format(total)} conversations {place} are selected.
              </span>
              <button
                type="button"
                className="mail-link focus-ring"
                onClick={() => {
                  onAllMatchingChange(false);
                  onSelectedChange(new Set());
                }}
              >
                Clear selection
              </button>
            </>
          ) : (
            <>
              <span>All {COUNT.format(rows.length)} conversations on this page are selected.</span>
              <button
                type="button"
                className="mail-link focus-ring"
                onClick={() => onAllMatchingChange(true)}
              >
                Select all {COUNT.format(total)} conversations {place}
              </button>
            </>
          )}
        </div>
      ) : null}
      <div className="mail-list-body">
        {error !== null && rows.length === 0 ? (
          <InlineError
            className="m-4"
            title="Couldn't load your mail"
            message={error}
            onRetry={props.onRetry}
            retrying={props.retrying}
          />
        ) : loading && rows.length === 0 ? (
          <Skeleton variant="row" count={10} label="Loading conversations" />
        ) : rows.length === 0 ? (
          <ListEmpty
            folder={folder}
            tab={tab}
            query={query}
            label={activeLabel}
            onClearSearch={props.onClearSearch}
          />
        ) : (
          // Keyboard route to the row menu: Shift+F10 or the Menu key on the focused row.
          <div onKeyDown={openContextMenuFromKeyboard}>
            <SelectableList
              items={rows}
              getKey={(row) => row.threadId}
              label="Conversations"
              getItemLabel={(row) => row.subject || "(no subject)"}
              selectedKeys={selectedIds}
              onSelectedKeysChange={(ids) => {
                onAllMatchingChange(false);
                onSelectedChange(ids);
              }}
              onOpen={onOpen}
              {...(openThreadId === null ? {} : { activeKey: openThreadId })}
              rowClassName={(row) =>
                cn(
                  "mail-list-row render-contained-list-item",
                  row.unread ? "is-unread" : "is-read",
                  row.threadId === openThreadId && "is-open",
                )
              }
              renderItem={(row, state) => (
                <MailRowContextMenu
                  thread={row}
                  targets={() => targetsFor(row)}
                  folder={folder}
                  labels={labels}
                  onAction={props.onAction}
                  onSnooze={props.onSnooze}
                  onPickSnoozeDate={setPickDateFor}
                  onMove={props.onMove}
                  onReply={props.onReply}
                >
                  <ThreadRow
                    thread={row}
                    folder={folder}
                    labelsBySlug={labelsBySlug}
                    activeLabel={activeLabel?.slug ?? null}
                    showAvatar={showAvatars}
                    tabIndex={state.tabIndex}
                    dragIds={() => targetsFor(row).map((entry) => entry.threadId)}
                    onAction={props.onAction}
                    onSnooze={props.onSnooze}
                  />
                </MailRowContextMenu>
              )}
            />
          </div>
        )}
      </div>
      <button type="button" className="mail-fab focus-ring" onClick={props.onCompose}>
        <Pencil aria-hidden="true" />
        <span>Compose</span>
      </button>
      {pickDateFor === null ? null : (
        <SnoozeDateDialog
          onClose={() => setPickDateFor(null)}
          onSnooze={(until) => props.onSnooze(pickDateFor, until)}
        />
      )}
    </div>
  );
}
