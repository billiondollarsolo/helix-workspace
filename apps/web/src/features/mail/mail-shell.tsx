import {
  Archive,
  ArrowLeft,
  BadgeCheck,
  Clock,
  Edit3,
  Filter,
  Inbox,
  Info,
  MailOpen,
  MoreHorizontal,
  Paperclip,
  Reply,
  RotateCcw,
  Search,
  Send,
  Star,
  Tag,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { SuggestionSlot } from "@helix/sdk-web";
import { useDebouncedValue } from "@tanstack/react-pacer/debouncer";
import { useForm, useStore as useFormStore } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  archiveMailThread,
  createMailFilter,
  deleteMailFilter,
  deleteMailThread,
  replyToMail,
  sendMail,
  setMailVacation,
  setMailThreadRead,
  setMailThreadStarred,
  snoozeMailThread,
  updateMailFilter,
  type MailApiAddress,
  type MailFilterActions,
  type MailFilterCriteria,
  type MailFilterRecord,
  type MailSearchHit,
  type MailThreadDetail,
  type MailVacationSettings,
} from "./api";
import {
  setMailComposerDraft,
  setMailDensity,
  toggleSelectedMailMessage,
  toggleSelectedMailThread,
  updateMailComposerDraft,
  useMailUiStore,
  type MailComposerDraft,
  type MailDensity,
} from "./mail-store";
import {
  defaultMailSearchState,
  mailFiltersQueryOptions,
  mailQueryKeys,
  mailSearchInputFromState,
  mailSearchQueryOptions,
  mailThreadQueryOptions,
  mailVacationQueryOptions,
  type MailRouteLabel,
  type MailRouteMailbox,
  type MailSearchState,
} from "./queries";

type MailboxId = MailRouteMailbox;
type LabelId = MailRouteLabel;
type ThreadStatus = "ready" | "loading" | "error";
type FilterSaveStatus = "idle" | "saving" | "saved" | "error";
type VacationSaveStatus = "idle" | "saving" | "saved" | "error";

interface MailThreadRouteState {
  readonly messageId?: string;
  readonly threadId?: string;
}

interface MailParticipant {
  readonly name: string;
  readonly email: string;
}

interface MailMessage {
  readonly id: string;
  readonly from: MailParticipant;
  readonly to: readonly MailParticipant[];
  readonly sentAt: string;
  readonly body: string;
}

interface MailThread {
  readonly id: string;
  readonly subject: string;
  readonly preview: string;
  readonly participants: readonly MailParticipant[];
  readonly messages: readonly MailMessage[];
  readonly labels: readonly string[];
  readonly mailbox: MailboxId;
  readonly lastActivity: string;
  readonly unread: boolean;
  readonly starred: boolean;
  readonly snoozedUntil?: string | null;
  readonly hasAttachment: boolean;
  readonly priority: "normal" | "high";
}

type ComposerDraft = MailComposerDraft;

const mailboxItems: ReadonlyArray<{
  readonly id: MailboxId;
  readonly label: string;
  readonly icon: typeof Inbox;
}> = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "starred", label: "Starred", icon: Star },
  { id: "sent", label: "Sent", icon: Send },
  { id: "drafts", label: "Drafts", icon: Edit3 },
  { id: "archive", label: "Archive", icon: Archive },
];

const labelItems: ReadonlyArray<{
  readonly id: LabelId;
  readonly label: string;
  readonly color: string;
}> = [
  { id: "planning", label: "Planning", color: "#0f766e" },
  { id: "finance", label: "Finance", color: "#4f46e5" },
  { id: "support", label: "Support", color: "#ca8a04" },
  { id: "team", label: "Team", color: "#be123c" },
];

const directory: readonly MailParticipant[] = [
  { name: "Maya Chen", email: "maya@helix.local" },
  { name: "Sam Patel", email: "sam@helix.local" },
  { name: "Jordan Lee", email: "jordan@helix.local" },
  { name: "Riley Brooks", email: "riley@helix.local" },
  { name: "Ari Morgan", email: "ari@helix.local" },
];

const emptyDraft: ComposerDraft = {
  mode: "new",
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  body: "",
};

const defaultVacationSettings: MailVacationSettings = {
  enabled: false,
  subject: "Out of office",
  body: "Thanks for your message. I am away right now and will reply when I return.",
  startsAt: null,
  endsAt: null,
};

const sampleMailThreads: readonly MailThread[] = [
  sampleMailThread({
    id: "sample-mail-1",
    from: directory[1]!,
    subject: "[AlphaBravoCompany/remotedialer] Run failed: Renovate - main (237b1a7)",
    preview:
      "Renovate workflow run needs attention before the dependency update window closes.",
    labels: ["team", "support"],
    lastActivity: "3:46 AM",
    unread: true,
    hasAttachment: false,
    priority: "high",
  }),
  sampleMailThread({
    id: "sample-mail-2",
    from: { name: "Annie Thai", email: "annie@example.com" },
    subject: "Request to Revisit Compensation for Expanded HR Responsibilities",
    preview:
      "Hi Harriet, I wanted to follow up regarding my current role and overall compensation.",
    labels: ["team"],
    lastActivity: "7:32 AM",
    unread: false,
    hasAttachment: false,
    priority: "normal",
  }),
  sampleMailThread({
    id: "sample-mail-3",
    from: { name: "Nick Johnson", email: "nick@example.com" },
    subject: "Invitation: 8am first tee time - $72 - Moccasin Run",
    preview: "Moccasin Run at Fri Aug 28, 2026 8am - 12:50pm ET.",
    labels: ["planning"],
    lastActivity: "May 18",
    unread: false,
    hasAttachment: true,
    priority: "normal",
  }),
  sampleMailThread({
    id: "sample-mail-4",
    from: { name: "Ally Bank", email: "alerts@ally.example" },
    subject: "A recent debit is above the transaction amount you set",
    preview: "No action is needed. We just wanted to let you know.",
    labels: ["finance"],
    lastActivity: "May 18",
    unread: true,
    hasAttachment: false,
    priority: "high",
  }),
  sampleMailThread({
    id: "sample-mail-5",
    from: { name: "Morgan Ryann", email: "morgan@example.com" },
    subject: "Resume - forwarded message",
    preview: "Forwarded message from Morgan Ryann with the updated resume attached.",
    labels: ["team"],
    lastActivity: "May 17",
    unread: false,
    hasAttachment: true,
    priority: "normal",
  }),
  sampleMailThread({
    id: "sample-mail-6",
    from: { name: "Board Plantations Two", email: "board@example.com" },
    subject: "Please Read -- Community Information",
    preview: "Board of Directors update, meeting agenda, and maintenance schedule.",
    labels: ["support"],
    lastActivity: "May 16",
    unread: true,
    hasAttachment: false,
    priority: "normal",
  }),
  sampleMailThread({
    id: "sample-mail-7",
    from: { name: "Me", email: "maya@helix.local" },
    subject: "Annie Sadie relationship reminder",
    preview: "Personal reminder and follow-up notes for next week.",
    labels: ["planning"],
    mailbox: "sent",
    lastActivity: "May 15",
    unread: false,
    hasAttachment: false,
    priority: "normal",
  }),
  sampleMailThread({
    id: "sample-mail-8",
    from: { name: "Ari Morgan", email: "ari@helix.local" },
    subject: "Q3 vendor renewal checklist",
    preview: "Shared checklist covering contracts, owners, and approval timing.",
    labels: ["finance", "team"],
    lastActivity: "May 14",
    unread: false,
    hasAttachment: true,
    priority: "normal",
  }),
];

const vacationSubjectSchema = z.string().max(120, "Subject must be 120 characters or fewer.");
const vacationBodySchema = z.string().max(2000, "Reply must be 2,000 characters or fewer.");

export function MailShell({
  initialMessageId,
  initialThreadId,
  onSearchStateChange,
  onThreadRouteStateChange,
  searchState,
}: {
  readonly initialMessageId?: string;
  readonly initialThreadId?: string;
  readonly onSearchStateChange?: (state: MailSearchState) => void;
  readonly onThreadRouteStateChange?: (
    state: MailThreadRouteState,
    searchState: MailSearchState,
  ) => void;
  readonly searchState?: MailSearchState;
} = {}) {
  const queryClient = useQueryClient();
  const [mailbox, setMailbox] = useState<MailboxId>(
    searchState?.mailbox ?? defaultMailSearchState.mailbox,
  );
  const [selectedLabel, setSelectedLabel] = useState<LabelId | "all">(
    searchState?.label ?? defaultMailSearchState.label,
  );
  const [query, setQuery] = useState(searchState?.query ?? defaultMailSearchState.query);
  const [unreadOnly, setUnreadOnly] = useState(
    searchState?.unreadOnly ?? defaultMailSearchState.unreadOnly,
  );
  const [priorityOnly, setPriorityOnly] = useState(
    searchState?.priorityOnly ?? defaultMailSearchState.priorityOnly,
  );
  const [attachmentsOnly, setAttachmentsOnly] = useState(
    searchState?.attachmentsOnly ?? defaultMailSearchState.attachmentsOnly,
  );
  const density = useMailUiStore((state) => state.density);
  const selectedMessageIds = useMailUiStore((state) => state.selectedMessageIds);
  const selectedThreadIds = useMailUiStore((state) => state.selectedThreadIds);
  const composer = useMailUiStore((state) => state.composerDraft);
  const [status, setStatus] = useState<ThreadStatus>("ready");
  const [selectedThreadId, setSelectedThreadId] = useState(initialThreadId ?? "");
  const [queuedSend, setQueuedSend] = useState<ComposerDraft | null>(null);
  const [threads, setThreads] = useState<readonly MailThread[]>(sampleMailThreads);
  const [filterSaveStatus, setFilterSaveStatus] = useState<FilterSaveStatus>("idle");
  const [optimisticFilters, setOptimisticFilters] = useState<readonly MailFilterRecord[]>([]);
  const [deletedFilterIds, setDeletedFilterIds] = useState<readonly string[]>([]);
  const [vacationSaveStatus, setVacationSaveStatus] = useState<VacationSaveStatus>("idle");
  const currentSearchState = useMemo(
    () => ({
      query,
      label: selectedLabel,
      mailbox,
      unreadOnly,
      priorityOnly,
      attachmentsOnly,
    }),
    [attachmentsOnly, mailbox, priorityOnly, query, selectedLabel, unreadOnly],
  );
  const [debouncedQuery] = useDebouncedValue(query, { wait: 300 });
  const debouncedSearchState = useMemo(
    () => ({
      ...currentSearchState,
      query: debouncedQuery,
    }),
    [currentSearchState, debouncedQuery],
  );
  const searchInput = useMemo(
    () => mailSearchInputFromState(debouncedSearchState),
    [debouncedSearchState],
  );
  const mailSearchQuery = useQuery(mailSearchQueryOptions(searchInput));
  const mailFiltersQuery = useQuery(mailFiltersQueryOptions());
  const mailThreadQuery = useQuery({
    ...mailThreadQueryOptions(selectedThreadId),
    enabled: selectedThreadId.length > 0,
  });
  const mailVacationQuery = useQuery(mailVacationQueryOptions());
  const vacationSettings = mailVacationQuery.data ?? defaultVacationSettings;
  const vacationSettingsAvailable = !mailVacationQuery.isPending && !mailVacationQuery.isError;

  useEffect(() => {
    setSelectedThreadId(initialThreadId ?? "");
  }, [initialThreadId]);

  useEffect(() => {
    if (searchState === undefined) {
      return;
    }
    setMailbox(searchState.mailbox);
    setSelectedLabel(searchState.label);
    setQuery(searchState.query);
    setUnreadOnly(searchState.unreadOnly);
    setPriorityOnly(searchState.priorityOnly);
    setAttachmentsOnly(searchState.attachmentsOnly);
  }, [
    searchState?.attachmentsOnly,
    searchState?.label,
    searchState?.mailbox,
    searchState?.priorityOnly,
    searchState?.query,
    searchState?.unreadOnly,
  ]);

  const updateSearchState = (
    update: Partial<MailSearchState> | ((state: MailSearchState) => MailSearchState),
    options: { readonly clearThread?: boolean } = {},
  ) => {
    const next =
      typeof update === "function"
        ? update(currentSearchState)
        : { ...currentSearchState, ...update };
    setMailbox(next.mailbox);
    setSelectedLabel(next.label);
    setQuery(next.query);
    setUnreadOnly(next.unreadOnly);
    setPriorityOnly(next.priorityOnly);
    setAttachmentsOnly(next.attachmentsOnly);
    if (options.clearThread === true) {
      setSelectedThreadId("");
      onThreadRouteStateChange?.({}, next);
      return;
    }
    onSearchStateChange?.(next);
  };

  const openThread = (threadId: string) => {
    setSelectedThreadId(threadId);
    onThreadRouteStateChange?.({ threadId }, currentSearchState);
  };

  const closeThread = () => {
    setSelectedThreadId("");
    onThreadRouteStateChange?.({}, currentSearchState);
  };

  useEffect(() => {
    if (mailSearchQuery.data === undefined) {
      return;
    }

    const nextThreads = mailSearchQuery.data.map(mailSearchHitToThread);
    const displayThreads = nextThreads.length > 0 ? nextThreads : sampleMailThreads;
    setThreads(displayThreads);
    setSelectedThreadId((current) => (current.length > 0 ? current : ""));
  }, [mailSearchQuery.data]);

  useEffect(() => {
    if (mailSearchQuery.isError) {
      setThreads((current) => (current.length > 0 ? current : sampleMailThreads));
    }
  }, [mailSearchQuery.isError]);

  useEffect(() => {
    const thread = mailThreadQuery.data;
    if (thread === undefined || thread === null) {
      return;
    }
    setThreads((current) => upsertThread(current, mailThreadDetailToThread(thread)));
  }, [mailThreadQuery.data]);

  const filteredThreads = useMemo(
    () =>
      threads.filter((thread) => {
        const inMailbox = mailbox === "starred" ? thread.starred : thread.mailbox === mailbox;
        const inLabel = selectedLabel === "all" || thread.labels.includes(selectedLabel);
        const visibleNow =
          thread.snoozedUntil === undefined ||
          thread.snoozedUntil === null ||
          new Date(thread.snoozedUntil).getTime() <= Date.now();
        const queryText =
          `${thread.subject} ${thread.preview} ${thread.participants.map((participant) => participant.name).join(" ")}`.toLowerCase();
        const matchesQuery = queryText.includes(debouncedQuery.trim().toLowerCase());
        return (
          inMailbox &&
          inLabel &&
          visibleNow &&
          matchesQuery &&
          (!unreadOnly || thread.unread) &&
          (!priorityOnly || thread.priority === "high") &&
          (!attachmentsOnly || thread.hasAttachment)
        );
      }),
    [attachmentsOnly, debouncedQuery, mailbox, priorityOnly, selectedLabel, threads, unreadOnly],
  );

  const selectedThread =
    selectedThreadId.length > 0
      ? filteredThreads.find((thread) => thread.id === selectedThreadId)
      : undefined;
  const selectedThreadContext = selectedThread
    ? {
        resource: {
          id: selectedThread.id,
          type: "mail.thread",
          label: selectedThread.subject,
        },
        metadata: {
          labels: selectedThread.labels,
          unread: selectedThread.unread,
          priority: selectedThread.priority,
        },
      }
    : undefined;

  const openComposer = (draft: ComposerDraft = emptyDraft) => setMailComposerDraft(draft);
  const canSaveFilter = query.trim().length > 0 || attachmentsOnly || selectedLabel !== "all";
  const savedFilters = useMemo(
    () =>
      mergeMailFilters(mailFiltersQuery.data ?? [], optimisticFilters).filter(
        (filter) => !deletedFilterIds.includes(filter.id),
      ),
    [deletedFilterIds, mailFiltersQuery.data, optimisticFilters],
  );

  const replyToThread = (thread: MailThread) => {
    openComposer({
      mode: "reply",
      threadId: thread.id,
      to: [thread.messages[thread.messages.length - 1]?.from ?? thread.participants[0]!],
      cc: [],
      bcc: [],
      subject: thread.subject.startsWith("Re:") ? thread.subject : `Re: ${thread.subject}`,
      body: "",
    });
  };

  const queueSend = (draft: ComposerDraft) => {
    setQueuedSend(draft);
    setMailComposerDraft(null);
    const message = {
      to: draft.to.map(participantToApiAddress),
      cc: draft.cc.map(participantToApiAddress),
      bcc: draft.bcc.map(participantToApiAddress),
      subject: draft.subject,
      bodyText: draft.body,
    };
    void (
      draft.mode === "reply" && draft.threadId !== undefined
        ? replyToMail({ ...message, threadId: draft.threadId })
        : sendMail(message)
    ).catch(() => {});
  };

  const resetFilters = () => {
    updateSearchState({
      query: defaultMailSearchState.query,
      label: defaultMailSearchState.label,
      unreadOnly: defaultMailSearchState.unreadOnly,
      priorityOnly: defaultMailSearchState.priorityOnly,
      attachmentsOnly: defaultMailSearchState.attachmentsOnly,
    });
  };

  const saveCurrentFilter = () => {
    const subjectContains = query.trim();
    const criteria = {
      ...(subjectContains.length === 0 ? {} : { subjectContains }),
      ...(attachmentsOnly ? { hasAttachment: true } : {}),
    };
    const actions = selectedLabel === "all" ? {} : { applyLabels: [selectedLabel] };
    if (Object.keys(criteria).length === 0 && Object.keys(actions).length === 0) {
      return;
    }

    setFilterSaveStatus("saving");
    const optimisticFilter = optimisticMailFilter({
      name: `Mail filter: ${subjectContains || selectedLabel}`,
      criteria,
      actions,
    });
    setOptimisticFilters((current) => mergeMailFilters(current, [optimisticFilter]));
    void createMailFilter({
      name: optimisticFilter.name,
      criteria,
      actions,
    })
      .then((filter) => {
        setOptimisticFilters((current) =>
          mergeMailFilters(
            current.filter((item) => item.id !== optimisticFilter.id),
            [isMailFilterRecord(filter) ? filter : optimisticFilter],
          ),
        );
        setFilterSaveStatus("saved");
      })
      .catch(() => setFilterSaveStatus("error"));
  };

  const toggleSavedFilter = (filter: MailFilterRecord) => {
    const nextFilter = { ...filter, enabled: !filter.enabled, updatedAt: new Date().toISOString() };
    setOptimisticFilters((current) => mergeMailFilters(current, [nextFilter]));
    void updateMailFilter({ id: filter.id, enabled: nextFilter.enabled })
      .then((updatedFilter) => {
        setOptimisticFilters((current) =>
          mergeMailFilters(current, [
            isMailFilterRecord(updatedFilter) ? updatedFilter : nextFilter,
          ]),
        );
      })
      .catch(() => {});
  };

  const removeSavedFilter = (filter: MailFilterRecord) => {
    setDeletedFilterIds((current) =>
      current.includes(filter.id) ? current : [...current, filter.id],
    );
    setOptimisticFilters((current) => current.filter((item) => item.id !== filter.id));
    void deleteMailFilter(filter.id).catch(() => {});
  };

  const saveVacationSettings = (settings: MailVacationSettings) => {
    setVacationSaveStatus("saving");
    void setMailVacation(settings)
      .then((vacation) => {
        queryClient.setQueryData(mailQueryKeys.vacation(), vacation);
        setVacationSaveStatus("saved");
      })
      .catch(() => setVacationSaveStatus("error"));
  };

  return (
    <section className="mail-page">
      <aside className="mail-sidebar" aria-label="Mail navigation">
        <button className="mail-compose-button" onClick={() => openComposer()} type="button">
          <Edit3 aria-hidden="true" size={17} />
          Compose
        </button>

        <nav className="mail-nav" aria-label="Mailboxes">
          {mailboxItems.map((item) => {
            const Icon = item.icon;
            const count =
              item.id === "starred"
                ? threads.filter((thread) => thread.starred).length
                : threads.filter((thread) => thread.mailbox === item.id).length;
            return (
              <button
                aria-current={mailbox === item.id ? "page" : undefined}
                className={mailbox === item.id ? "mail-nav-item active" : "mail-nav-item"}
                key={item.id}
                onClick={() => {
                  updateSearchState({ mailbox: item.id }, { clearThread: true });
                }}
                type="button"
              >
                <Icon aria-hidden="true" size={17} />
                <span>{item.label}</span>
                <strong>{count}</strong>
              </button>
            );
          })}
        </nav>

        <div className="mail-labels" aria-label="Labels">
          <div className="mail-section-title">
            <Tag aria-hidden="true" size={15} />
            <span>Labels</span>
          </div>
          <button
            className={selectedLabel === "all" ? "mail-label active" : "mail-label"}
            onClick={() => updateSearchState({ label: "all" }, { clearThread: true })}
            type="button"
          >
            <span className="mail-label-swatch all" aria-hidden="true" />
            All labels
          </button>
          {labelItems.map((label) => (
            <button
              className={selectedLabel === label.id ? "mail-label active" : "mail-label"}
              key={label.id}
              onClick={() => updateSearchState({ label: label.id }, { clearThread: true })}
              type="button"
            >
              <span
                className="mail-label-swatch"
                style={{ background: label.color }}
                aria-hidden="true"
              />
              {label.label}
            </button>
          ))}
        </div>
      </aside>

      <div
        className={selectedThread ? "mail-workspace reading" : "mail-workspace"}
        role="main"
        aria-labelledby="mail-title"
      >
        <header className="mail-header">
          <div>
            <h1 id="mail-title">Mail</h1>
            <p>{filteredThreads.length} threads</p>
          </div>
          <div className="mail-header-actions">
            <VacationSettingsControl
              available={vacationSettingsAvailable}
              onSave={saveVacationSettings}
              settings={vacationSettings}
              status={vacationSaveStatus}
            />
            <button
              className="helix-button helix-button-secondary"
              onClick={() => setStatus(status === "loading" ? "ready" : "loading")}
              type="button"
            >
              <RotateCcw aria-hidden="true" size={16} />
              {status === "loading" ? "Done" : "Sync"}
            </button>
            <button
              className="icon-button"
              aria-label="More mail actions"
              onClick={() => setStatus("error")}
              type="button"
            >
              <MoreHorizontal aria-hidden="true" size={17} />
            </button>
          </div>
        </header>

        <div className="mail-filters" aria-label="Mail filters">
          <label className="mail-search">
            <Search aria-hidden="true" size={17} />
            <input
              value={query}
              onChange={(event) => updateSearchState({ query: event.target.value })}
              placeholder="Search mail"
            />
          </label>
          <button
            className={unreadOnly ? "mail-filter active" : "mail-filter"}
            onClick={() =>
              updateSearchState((current) => ({ ...current, unreadOnly: !current.unreadOnly }))
            }
            type="button"
          >
            Unread
          </button>
          <button
            className={priorityOnly ? "mail-filter active" : "mail-filter"}
            onClick={() =>
              updateSearchState((current) => ({ ...current, priorityOnly: !current.priorityOnly }))
            }
            type="button"
          >
            Priority
          </button>
          <button
            className={attachmentsOnly ? "mail-filter active" : "mail-filter"}
            onClick={() =>
              updateSearchState((current) => ({
                ...current,
                attachmentsOnly: !current.attachmentsOnly,
              }))
            }
            type="button"
          >
            <Paperclip aria-hidden="true" size={15} />
            Attachments
          </button>
          <button
            aria-label="Save current mail filter"
            className={filterSaveStatus === "saved" ? "mail-filter active" : "mail-filter"}
            disabled={!canSaveFilter || filterSaveStatus === "saving"}
            onClick={saveCurrentFilter}
            type="button"
          >
            <Filter aria-hidden="true" size={15} />
            {filterSaveStatus === "saving" ? "Saving" : "Save filter"}
          </button>
          <div className="mail-density" role="group" aria-label="Density">
            <button
              className={density === "comfortable" ? "active" : undefined}
              onClick={() => setMailDensity("comfortable")}
              type="button"
            >
              Comfort
            </button>
            <button
              className={density === "compact" ? "active" : undefined}
              onClick={() => setMailDensity("compact")}
              type="button"
            >
              Compact
            </button>
          </div>
        </div>

        {selectedThread ? null : (
          <>
            <div className="mail-list-toolbar" aria-label="Mail list actions">
              <div>
                <label className="mail-toolbar-check">
                  <input aria-label="Select all visible mail" type="checkbox" />
                </label>
                <button className="icon-button" aria-label="Refresh mail" type="button">
                  <RotateCcw aria-hidden="true" size={16} />
                </button>
                <button className="icon-button" aria-label="More list actions" type="button">
                  <MoreHorizontal aria-hidden="true" size={17} />
                </button>
              </div>
              <span>
                1-50 of {filteredThreads.length === 0 ? "0" : String(filteredThreads.length)}
              </span>
            </div>

            <div className="mail-category-tabs" aria-label="Inbox categories">
              <button className="active" type="button">
                <Inbox aria-hidden="true" size={17} />
                <span>Primary</span>
              </button>
              <button type="button">
                <Tag aria-hidden="true" size={17} />
                <span>Promotions</span>
                <strong>11 new</strong>
              </button>
              <button type="button">
                <Users aria-hidden="true" size={17} />
                <span>Social</span>
              </button>
              <button type="button">
                <Info aria-hidden="true" size={17} />
                <span>Updates</span>
                <strong>10 new</strong>
              </button>
            </div>

            <div className="mail-happening-soon" aria-label="Happening soon">
              <header>
                <strong>Happening soon</strong>
                <button aria-label="Dismiss happening soon" className="icon-button" type="button">
                  <X aria-hidden="true" size={16} />
                </button>
              </header>
              <div>
                <span className="mail-package-preview" aria-hidden="true" />
                <strong>3 items from Amazon</strong>
                <span>Expected tomorrow</span>
                <button className="helix-button" type="button">
                  View order
                </button>
                <button aria-label="More order actions" className="icon-button" type="button">
                  <MoreHorizontal aria-hidden="true" size={17} />
                </button>
              </div>
            </div>
          </>
        )}

        <div className={selectedThread ? "mail-split reading" : "mail-split"}>
          {selectedThread ? (
            <ReaderPanel
              onArchive={(thread) => {
                setThreads((current) =>
                  current.map((item) =>
                    item.id === thread.id ? { ...item, mailbox: "archive", unread: false } : item,
                  ),
                );
                closeThread();
                void archiveMailThread(thread.id).catch(() => {});
              }}
              onBack={closeThread}
              onCompose={openComposer}
              onDelete={(thread) => {
                setThreads((current) => current.filter((item) => item.id !== thread.id));
                closeThread();
                void deleteMailThread(thread.id).catch(() => {});
              }}
              onMarkRead={(thread, unread) => {
                setThreads((current) =>
                  current.map((item) => (item.id === thread.id ? { ...item, unread } : item)),
                );
                void setMailThreadRead({ threadId: thread.id, unread }).catch(() => {});
              }}
              onReply={replyToThread}
              onSnooze={(thread) => {
                const until = tomorrowIso();
                setThreads((current) =>
                  current.map((item) =>
                    item.id === thread.id ? { ...item, snoozedUntil: until } : item,
                  ),
                );
                void snoozeMailThread({ threadId: thread.id, until }).catch(() => {});
              }}
              onStar={(thread, starred) => {
                setThreads((current) =>
                  current.map((item) => (item.id === thread.id ? { ...item, starred } : item)),
                );
                void setMailThreadStarred({ threadId: thread.id, starred }).catch(() => {});
              }}
              focusedMessageId={initialMessageId}
              onToggleMessageSelected={toggleSelectedMailMessage}
              selectedMessageIds={selectedMessageIds}
              thread={selectedThread}
              threadContext={selectedThreadContext}
            />
          ) : (
            <ThreadList
              density={density}
              onRetry={() => {
                setStatus("ready");
                void queryClient.invalidateQueries({ queryKey: mailQueryKeys.search(searchInput) });
              }}
              onSelect={openThread}
              onToggleThreadSelected={toggleSelectedMailThread}
              onReset={resetFilters}
              selectedThreadId={selectedThreadId}
              selectedThreadIds={selectedThreadIds}
              status={threadListStatus(
                status,
                mailSearchQuery.isFetching,
                mailSearchQuery.isError,
                threads,
              )}
              threads={filteredThreads}
            />
          )}
        </div>
        <MailFilterTable
          filters={savedFilters}
          isLoading={mailFiltersQuery.isLoading}
          listUnavailable={mailFiltersQuery.isError}
          onDelete={removeSavedFilter}
          onToggle={toggleSavedFilter}
        />
      </div>

      {composer ? (
        <Composer draft={composer} onClose={() => setMailComposerDraft(null)} onSend={queueSend} />
      ) : null}
      {queuedSend ? (
        <UndoSend
          draft={queuedSend}
          onDismiss={() => setQueuedSend(null)}
          onUndo={() => {
            setMailComposerDraft(queuedSend);
            setQueuedSend(null);
          }}
        />
      ) : null}
    </section>
  );
}

function VacationSettingsControl({
  available,
  onSave,
  settings,
  status,
}: {
  readonly available: boolean;
  readonly onSave: (settings: MailVacationSettings) => void;
  readonly settings: MailVacationSettings;
  readonly status: VacationSaveStatus;
}) {
  const [open, setOpen] = useState(false);
  const vacationForm = useForm({
    defaultValues: settings,
    onSubmit: ({ value }) => save(value),
  });
  const settingsSignatureRef = useRef(vacationSettingsSignature(settings));
  const vacationEnabled = useFormStore(vacationForm.store, (state) => state.values.enabled);

  useEffect(() => {
    const settingsSignature = vacationSettingsSignature(settings);
    if (settingsSignatureRef.current === settingsSignature) {
      return;
    }
    settingsSignatureRef.current = settingsSignature;
    vacationForm.reset(settings);
  }, [settings, vacationForm]);

  const save = (patch: Partial<MailVacationSettings>) => {
    const current = vacationForm.state.values;
    const next = {
      ...current,
      ...patch,
      subject: (patch.subject ?? current.subject).trim() || defaultVacationSettings.subject,
      body: (patch.body ?? current.body).trim() || defaultVacationSettings.body,
    };
    vacationForm.reset(next);
    onSave(next);
  };

  return (
    <div className="mail-vacation-control" style={{ position: "relative" }}>
      <button
        className={vacationEnabled ? "mail-filter active" : "mail-filter"}
        disabled={!available || status === "saving"}
        onClick={() => save({ enabled: !vacationEnabled })}
        type="button"
      >
        <Clock aria-hidden="true" size={15} />
        {status === "saving" ? "Saving" : vacationEnabled ? "Vacation on" : "Vacation off"}
      </button>
      <button
        aria-expanded={open}
        aria-label="Vacation settings"
        className="icon-button"
        disabled={!available}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <MoreHorizontal aria-hidden="true" size={16} />
      </button>
      {open ? (
        <form
          aria-label="Vacation settings"
          onSubmit={(event) => {
            event.preventDefault();
            void vacationForm.handleSubmit();
          }}
          style={{
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 14px 34px #0000001f",
            display: "grid",
            gap: 8,
            padding: 10,
            position: "absolute",
            right: 0,
            top: "calc(100% + 8px)",
            width: 280,
            zIndex: 30,
          }}
        >
          <vacationForm.Field
            name="subject"
            validators={{
              onChange: validateStringWith(vacationSubjectSchema),
              onSubmit: validateStringWith(vacationSubjectSchema),
            }}
          >
            {(field) => (
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ color: "var(--muted-foreground)", fontSize: 12, fontWeight: 800 }}>
                  Subject
                </span>
                <input
                  aria-label="Vacation subject"
                  onChange={(event) => field.handleChange(event.target.value)}
                  value={field.state.value}
                  style={{
                    background: "var(--background)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    minHeight: 34,
                    padding: "0 8px",
                  }}
                />
                <FieldErrors errors={field.state.meta.errors} />
              </label>
            )}
          </vacationForm.Field>
          <vacationForm.Field
            name="body"
            validators={{
              onChange: validateStringWith(vacationBodySchema),
              onSubmit: validateStringWith(vacationBodySchema),
            }}
          >
            {(field) => (
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ color: "var(--muted-foreground)", fontSize: 12, fontWeight: 800 }}>
                  Reply
                </span>
                <textarea
                  aria-label="Vacation reply"
                  onChange={(event) => field.handleChange(event.target.value)}
                  value={field.state.value}
                  rows={4}
                  style={{
                    background: "var(--background)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: 8,
                    resize: "vertical",
                  }}
                />
                <FieldErrors errors={field.state.meta.errors} />
              </label>
            )}
          </vacationForm.Field>
          <div
            style={{
              alignItems: "center",
              display: "flex",
              gap: 8,
              justifyContent: "space-between",
            }}
          >
            <span
              style={{
                color: status === "error" ? "var(--danger)" : "var(--muted-foreground)",
                fontSize: 12,
              }}
            >
              {!available
                ? "Vacation unavailable"
                : status === "saved"
                  ? "Saved"
                  : status === "error"
                    ? "Save failed"
                    : ""}
            </span>
            <button className="helix-button" disabled={status === "saving"} type="submit">
              Save
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function validateStringWith(schema: z.ZodString) {
  return ({ value }: { readonly value: string }) => {
    const result = schema.safeParse(value);
    return result.success ? undefined : result.error.issues[0]?.message;
  };
}

function FieldErrors({ errors }: { readonly errors: readonly unknown[] }) {
  const messages = errors.filter((error): error is string => typeof error === "string");
  return messages.length === 0 ? null : (
    <span role="alert" style={{ color: "var(--danger)", fontSize: 12 }}>
      {messages.join(" ")}
    </span>
  );
}

function MailFilterTable({
  filters,
  isLoading,
  listUnavailable,
  onDelete,
  onToggle,
}: {
  readonly filters: readonly MailFilterRecord[];
  readonly isLoading: boolean;
  readonly listUnavailable: boolean;
  readonly onDelete: (filter: MailFilterRecord) => void;
  readonly onToggle: (filter: MailFilterRecord) => void;
}) {
  const columns = useMemo<ColumnDef<MailFilterRecord>[]>(
    () => [
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (row.original.enabled ? "Enabled" : "Paused"),
      },
      {
        id: "name",
        header: "Name",
        cell: ({ row }) => <strong>{row.original.name}</strong>,
      },
      {
        id: "criteria",
        header: "Criteria",
        cell: ({ row }) => describeFilterCriteria(row.original.criteria),
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => describeFilterActions(row.original.actions),
      },
      {
        id: "priority",
        header: "Priority",
        cell: ({ row }) => row.original.priority,
      },
      {
        id: "controls",
        header: "Manage",
        cell: ({ row }) => {
          const filter = row.original;
          return (
            <span style={{ display: "inline-flex", gap: 6 }}>
              <button
                aria-label={`${filter.enabled ? "Disable" : "Enable"} mail filter ${filter.name}`}
                className="mail-filter"
                onClick={() => onToggle(filter)}
                type="button"
              >
                {filter.enabled ? "Disable" : "Enable"}
              </button>
              <button
                aria-label={`Delete mail filter ${filter.name}`}
                className="icon-button danger"
                onClick={() => onDelete(filter)}
                type="button"
              >
                <Trash2 aria-hidden="true" size={15} />
              </button>
            </span>
          );
        },
      },
    ],
    [onDelete, onToggle],
  );
  const data = useMemo(() => [...filters], [filters]);
  const table = useReactTable({
    columns,
    data,
    getCoreRowModel: getCoreRowModel(),
  });
  const rows = table.getRowModel().rows;

  return (
    <section
      aria-label="Saved mail filters"
      style={{
        borderTop: "1px solid var(--border)",
        display: "grid",
        gap: 8,
        padding: 12,
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 16, margin: 0 }}>Saved filters</h2>
          <p style={{ color: "var(--muted-foreground)", fontSize: 12, margin: "3px 0 0" }}>
            {listUnavailable
              ? "Showing locally saved filters until the backend list tool is available."
              : `${String(filters.length)} configured`}
          </p>
        </div>
      </header>
      <Table aria-label="Saved mail filters table">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length}>
                {isLoading ? "Loading mail filters..." : "No saved mail filters."}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  );
}

function vacationSettingsSignature(settings: MailVacationSettings) {
  return JSON.stringify({
    body: settings.body,
    enabled: settings.enabled,
    endsAt: settings.endsAt,
    startsAt: settings.startsAt,
    subject: settings.subject,
  });
}

function ThreadList({
  density,
  onRetry,
  onReset,
  onSelect,
  onToggleThreadSelected,
  selectedThreadId,
  selectedThreadIds,
  status,
  threads,
}: {
  readonly density: MailDensity;
  readonly onRetry: () => void;
  readonly onReset: () => void;
  readonly onSelect: (threadId: string) => void;
  readonly onToggleThreadSelected: (threadId: string) => void;
  readonly selectedThreadId: string | undefined;
  readonly selectedThreadIds: readonly string[];
  readonly status: ThreadStatus;
  readonly threads: readonly MailThread[];
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const estimatedRowSize = density === "compact" ? 32 : 40;
  const rowVirtualizer = useVirtualizer({
    count: threads.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => estimatedRowSize,
    overscan: 8,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const rowsToRender =
    virtualRows.length > 0
      ? virtualRows
      : threads.map((_, index) => ({
          index,
          key: index,
          size: estimatedRowSize,
          start: index * estimatedRowSize,
        }));
  const virtualHeight = rowVirtualizer.getTotalSize() || threads.length * estimatedRowSize;

  if (status === "loading") {
    return (
      <div
        className="mail-thread-list"
        role="region"
        aria-label="Thread list"
        aria-busy="true"
        tabIndex={0}
      >
        {Array.from({ length: 7 }, (_, index) => (
          <div className="mail-thread-skeleton" key={index}>
            <span />
            <span />
            <span />
          </div>
        ))}
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="mail-thread-list offline" role="alert" aria-label="Thread list" tabIndex={0}>
        <div className="mail-offline-banner">
          <Filter aria-hidden="true" size={16} />
          <strong>Mailbox unavailable</strong>
          <span>Mail search could not reach the backend. Check your connection and try again.</span>
          <button className="helix-button" onClick={onRetry} type="button">
            Retry
          </button>
        </div>
        {Array.from({ length: 12 }, (_, index) => (
          <div className="mail-thread-placeholder" key={index}>
            <span />
            <span />
            <span />
            <span />
          </div>
        ))}
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="mail-state-panel">
        <MailOpen aria-hidden="true" size={20} />
        <h2>No threads</h2>
        <p>Nothing matches the current mailbox and filters.</p>
        <button className="helix-button helix-button-secondary" onClick={onReset} type="button">
          Clear filters
        </button>
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className={density === "compact" ? "mail-thread-list compact" : "mail-thread-list"}
      role="region"
      aria-label="Thread list"
      tabIndex={0}
    >
      <div className="mail-thread-virtual-spacer" style={{ height: `${String(virtualHeight)}px` }}>
        {rowsToRender.map((virtualRow) => {
          const thread = threads[virtualRow.index];
          if (thread === undefined) {
            return null;
          }
          const selectedForMultiSelect = selectedThreadIds.includes(thread.id);
          return (
            <div
              className={
                thread.id === selectedThreadId ? "mail-thread-row selected" : "mail-thread-row"
              }
              key={thread.id}
              style={{
                height: `${String(virtualRow.size)}px`,
                transform: `translateY(${String(virtualRow.start)}px)`,
              }}
            >
              <span className="mail-thread-select">
                <input
                  aria-label={`Select thread ${thread.subject}`}
                  checked={selectedForMultiSelect}
                  onChange={() => onToggleThreadSelected(thread.id)}
                  type="checkbox"
                />
                <span
                  className={thread.unread ? "mail-unread-dot unread" : "mail-unread-dot"}
                  aria-hidden="true"
                />
              </span>
              <button
                aria-pressed={thread.id === selectedThreadId}
                className="mail-thread-main"
                onClick={() => onSelect(thread.id)}
                type="button"
              >
                <strong className="mail-thread-sender">
                  {thread.participants.map((participant) => participant.name).join(", ")}
                </strong>
                <span className="mail-thread-summary">
                  {thread.starred ? <Star aria-label="Starred" size={14} /> : null}
                  <span className="mail-thread-subject">{thread.subject}</span>
                  <span className="mail-thread-preview">{thread.preview}</span>
                </span>
                <time className="mail-thread-date">{thread.lastActivity}</time>
                <span className="mail-thread-tags">
                  {thread.labels.map((labelId) => {
                    const label = labelItems.find((item) => item.id === labelId);
                    return label ? (
                      <span key={label.id}>
                        <span style={{ background: label.color }} aria-hidden="true" />
                        {label.label}
                      </span>
                    ) : null;
                  })}
                  {thread.hasAttachment ? (
                    <span>
                      <Paperclip aria-hidden="true" size={12} />
                      Files
                    </span>
                  ) : null}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReaderPanel({
  focusedMessageId,
  onArchive,
  onBack,
  onCompose,
  onDelete,
  onMarkRead,
  onReply,
  onSnooze,
  onStar,
  onToggleMessageSelected,
  selectedMessageIds,
  thread,
  threadContext,
}: {
  readonly focusedMessageId: string | undefined;
  readonly onArchive: (thread: MailThread) => void;
  readonly onBack: () => void;
  readonly onCompose: (draft?: ComposerDraft) => void;
  readonly onDelete: (thread: MailThread) => void;
  readonly onMarkRead: (thread: MailThread, unread: boolean) => void;
  readonly onReply: (thread: MailThread) => void;
  readonly onSnooze: (thread: MailThread) => void;
  readonly onStar: (thread: MailThread, starred: boolean) => void;
  readonly onToggleMessageSelected: (messageId: string) => void;
  readonly selectedMessageIds: readonly string[];
  readonly thread: MailThread | undefined;
  readonly threadContext: Parameters<typeof SuggestionSlot>[0]["context"];
}) {
  const focusedMessageRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (focusedMessageId === undefined || focusedMessageRef.current === null) {
      return;
    }
    if (!thread?.messages.some((message) => message.id === focusedMessageId)) {
      return;
    }

    focusedMessageRef.current.focus({ preventScroll: true });
    focusedMessageRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusedMessageId, thread?.id, thread?.messages]);

  if (!thread) {
    return (
      <section className="mail-reader empty" aria-label="Message reader" tabIndex={0}>
        <MailOpen aria-hidden="true" size={24} />
        <h2>No message selected</h2>
      </section>
    );
  }

  return (
    <section className="mail-reader" aria-label="Message reader" tabIndex={0}>
      <header className="mail-reader-header">
        <button className="icon-button" aria-label="Back to inbox" onClick={onBack} type="button">
          <ArrowLeft aria-hidden="true" size={18} />
        </button>
        <div>
          <h2>{thread.subject}</h2>
          <div className="mail-reader-meta">
            {thread.labels.map((labelId) => {
              const label = labelItems.find((item) => item.id === labelId);
              return label ? (
                <span key={label.id}>
                  <span style={{ background: label.color }} aria-hidden="true" />
                  {label.label}
                </span>
              ) : null;
            })}
          </div>
        </div>
        <div className="mail-reader-actions">
          <button
            className="icon-button"
            aria-label={thread.starred ? "Unstar thread" : "Star thread"}
            onClick={() => onStar(thread, !thread.starred)}
            type="button"
          >
            <Star aria-hidden="true" size={17} />
          </button>
          <button
            className="icon-button"
            aria-label={thread.unread ? "Mark thread read" : "Mark thread unread"}
            onClick={() => onMarkRead(thread, !thread.unread)}
            type="button"
          >
            <BadgeCheck aria-hidden="true" size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="Snooze thread"
            onClick={() => onSnooze(thread)}
            type="button"
          >
            <Clock aria-hidden="true" size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="Archive thread"
            onClick={() => onArchive(thread)}
            type="button"
          >
            <Archive aria-hidden="true" size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="Delete thread"
            onClick={() => onDelete(thread)}
            type="button"
          >
            <Trash2 aria-hidden="true" size={17} />
          </button>
          <button className="helix-button" onClick={() => onReply(thread)} type="button">
            <Reply aria-hidden="true" size={16} />
            Reply
          </button>
        </div>
      </header>

      <SuggestionSlot
        className="mail-suggestion-slot"
        context={threadContext}
        emptyFallback={<div className="mail-suggestion-empty">No thread summary</div>}
        loadingFallback={<div className="mail-suggestion-empty">Loading summary</div>}
        slotId="mail.summarize-thread"
      />

      <div className="mail-message-stack">
        {thread.messages.map((message) => {
          const isFocused = message.id === focusedMessageId;
          const selectedForMultiSelect = selectedMessageIds.includes(message.id);
          return (
            <article
              aria-current={isFocused ? "true" : undefined}
              className={isFocused ? "mail-message focused" : "mail-message"}
              data-message-id={message.id}
              key={message.id}
              ref={(element) => {
                if (isFocused) {
                  focusedMessageRef.current = element;
                }
              }}
              tabIndex={isFocused ? -1 : undefined}
            >
              <header>
                <input
                  aria-label={`Select message from ${message.from.name}`}
                  checked={selectedForMultiSelect}
                  onChange={() => onToggleMessageSelected(message.id)}
                  type="checkbox"
                />
                <div className="mail-avatar" aria-hidden="true">
                  {initialsFor(message.from.name)}
                </div>
                <div>
                  <strong>{message.from.name}</strong>
                  <span>{message.from.email}</span>
                </div>
                <time>{message.sentAt}</time>
              </header>
              <p>{message.body}</p>
              <dl>
                <div>
                  <dt>To</dt>
                  <dd>{message.to.map((recipient) => recipient.email).join(", ")}</dd>
                </div>
              </dl>
            </article>
          );
        })}
      </div>

      <SuggestionSlot
        className="mail-suggestion-slot"
        context={threadContext}
        emptyFallback={<div className="mail-suggestion-empty">No reply suggestions</div>}
        loadingFallback={<div className="mail-suggestion-empty">Loading replies</div>}
        slotId="mail.suggest-reply"
      />

      <button className="mail-inline-reply" onClick={() => onReply(thread)} type="button">
        <Reply aria-hidden="true" size={16} />
        Reply
      </button>
      <button className="mail-inline-reply secondary" onClick={() => onCompose()} type="button">
        <Edit3 aria-hidden="true" size={16} />
        New message
      </button>
    </section>
  );
}

function Composer({
  draft,
  onClose,
  onSend,
}: {
  readonly draft: ComposerDraft;
  readonly onClose: () => void;
  readonly onSend: (draft: ComposerDraft) => void;
}) {
  const [field, setField] = useState<"to" | "cc" | "bcc">("to");
  const editor = useEditor({
    extensions: [StarterKit],
    content: draft.body,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        "aria-label": "Message body",
        class: "mail-body-input",
        "data-placeholder": "Write a message",
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      const body = currentEditor.getText({ blockSeparator: "\n" });
      updateMailComposerDraft({ body });
    },
  });

  const currentRecipients = draft[field];
  const canSend =
    draft.to.length > 0 && draft.subject.trim().length > 0 && draft.body.trim().length > 0;

  useEffect(() => {
    if (editor !== null && editor.getText({ blockSeparator: "\n" }) !== draft.body) {
      editor.commands.setContent(draft.body, { emitUpdate: false });
    }
  }, [draft, editor]);

  return (
    <section className="mail-composer" aria-labelledby="mail-composer-title">
      <header>
        <h2 id="mail-composer-title">{draft.mode === "reply" ? "Reply" : "New message"}</h2>
        <button className="icon-button" aria-label="Close composer" onClick={onClose} type="button">
          <X aria-hidden="true" size={17} />
        </button>
      </header>

      <div className="mail-recipient-tabs" role="tablist" aria-label="Recipient fields">
        {(["to", "cc", "bcc"] as const).map((item) => (
          <button
            className={field === item ? "active" : undefined}
            key={item}
            onClick={() => setField(item)}
            type="button"
          >
            {item.toUpperCase()}
          </button>
        ))}
      </div>

      <RecipientChips
        recipients={currentRecipients}
        onAdd={(recipient) =>
          updateMailComposerDraft({ [field]: [...currentRecipients, recipient] })
        }
        onRemove={(email) =>
          updateMailComposerDraft({
            [field]: currentRecipients.filter((recipient) => recipient.email !== email),
          })
        }
      />

      <input
        aria-label="Subject"
        className="mail-subject-input"
        onChange={(event) => updateMailComposerDraft({ subject: event.target.value })}
        placeholder="Subject"
        value={draft.subject}
      />

      <SuggestionSlot
        className="mail-suggestion-slot compact"
        context={{
          resource: draft.threadId
            ? {
                id: draft.threadId,
                type: "mail.thread",
                label: draft.subject,
              }
            : undefined,
          metadata: {
            subject: draft.subject,
            recipientCount: draft.to.length,
          },
        }}
        emptyFallback={<div className="mail-suggestion-empty">No compose suggestions</div>}
        loadingFallback={<div className="mail-suggestion-empty">Loading compose help</div>}
        slotId="mail.compose-help"
      />

      <SuggestionSlot
        className="mail-suggestion-slot compact"
        context={{
          metadata: {
            bodyLength: draft.body.length,
          },
        }}
        emptyFallback={null}
        loadingFallback={<div className="mail-suggestion-empty">Loading subjects</div>}
        slotId="mail.subject-from-body"
      />

      <div className="mail-body-editor" data-placeholder="Write a message">
        <EditorContent
          editor={editor}
          onInput={(event) => {
            const body = event.currentTarget.textContent ?? "";
            updateMailComposerDraft({ body });
          }}
        />
      </div>

      <footer>
        <button className="helix-button helix-button-secondary" onClick={onClose} type="button">
          Discard
        </button>
        <button
          className="helix-button"
          disabled={!canSend}
          onClick={() => onSend(draft)}
          type="button"
        >
          <Send aria-hidden="true" size={16} />
          Send
        </button>
      </footer>
    </section>
  );
}

function threadListStatus(
  status: ThreadStatus,
  isFetching: boolean,
  isError: boolean,
  threads: readonly MailThread[],
): ThreadStatus {
  if (status !== "ready") {
    return status;
  }
  if (isFetching && threads.length === 0) {
    return "loading";
  }
  if (isError && threads.length === 0) {
    return "error";
  }
  return "ready";
}

function RecipientChips({
  onAdd,
  onRemove,
  recipients,
}: {
  readonly onAdd: (recipient: MailParticipant) => void;
  readonly onRemove: (email: string) => void;
  readonly recipients: readonly MailParticipant[];
}) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const normalized = value.trim().toLowerCase();
  const suggestions = directory.filter(
    (person) =>
      !recipients.some((recipient) => recipient.email === person.email) &&
      (person.name.toLowerCase().includes(normalized) ||
        person.email.toLowerCase().includes(normalized)),
  );

  const addRecipient = (recipient: MailParticipant) => {
    onAdd(recipient);
    setValue("");
    setOpen(false);
  };

  const addTypedRecipient = () => {
    if (!normalized) {
      return;
    }

    const existing = directory.find(
      (person) =>
        person.email.toLowerCase() === normalized || person.name.toLowerCase() === normalized,
    );
    addRecipient(
      existing ?? {
        name: value.trim(),
        email: normalized.includes("@") ? normalized : `${normalized}@helix.local`,
      },
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTypedRecipient();
    }

    if (event.key === "Backspace" && value.length === 0 && recipients.length > 0) {
      onRemove(recipients[recipients.length - 1]!.email);
    }
  };

  return (
    <div className="mail-recipient-combobox">
      <div className="mail-recipient-chips">
        {recipients.map((recipient) => (
          <span className="mail-recipient-chip" key={recipient.email}>
            {recipient.name}
            <button
              aria-label={`Remove ${recipient.name}`}
              onClick={() => onRemove(recipient.email)}
              type="button"
            >
              <X aria-hidden="true" size={12} />
            </button>
          </span>
        ))}
        <input
          aria-label="Add recipient"
          onBlur={() => setOpen(false)}
          onChange={(event) => {
            setValue(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={recipients.length === 0 ? "Recipients" : ""}
          value={value}
        />
      </div>
      {open && suggestions.length > 0 ? (
        <div className="mail-recipient-menu" role="listbox">
          {suggestions.slice(0, 4).map((person) => (
            <button
              key={person.email}
              onMouseDown={() => addRecipient(person)}
              role="option"
              type="button"
            >
              <BadgeCheck aria-hidden="true" size={15} />
              <span>{person.name}</span>
              <small>{person.email}</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function UndoSend({
  draft,
  onDismiss,
  onUndo,
}: {
  readonly draft: ComposerDraft;
  readonly onDismiss: () => void;
  readonly onUndo: () => void;
}) {
  return (
    <div className="mail-undo-send" role="status">
      <Clock aria-hidden="true" size={17} />
      <span>Queued to send</span>
      <strong>{draft.subject}</strong>
      <button onClick={onUndo} type="button">
        Undo
      </button>
      <button aria-label="Dismiss undo send" onClick={onDismiss} type="button">
        <X aria-hidden="true" size={15} />
      </button>
    </div>
  );
}

function initialsFor(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function mailSearchHitToThread(hit: MailSearchHit): MailThread {
  const participant = apiAddressToParticipant(hit.from) ?? { name: "Unknown sender", email: "" };
  return {
    id: hit.threadId,
    subject: hit.subject,
    preview: hit.preview,
    participants: [participant],
    messages: [
      {
        id: hit.messageId,
        from: participant,
        to: [],
        sentAt: displayDate(hit.sentAt),
        body: hit.preview,
      },
    ],
    labels: hit.labels,
    mailbox: "inbox",
    lastActivity: displayDate(hit.sentAt),
    unread: hit.unread ?? false,
    starred: hit.starred ?? false,
    hasAttachment: false,
    priority: "normal",
  };
}

function mailThreadDetailToThread(thread: MailThreadDetail): MailThread {
  const messages = thread.messages.map((message) => ({
    id: message.id,
    from: apiAddressToParticipant(message.from) ?? { name: "Unknown sender", email: "" },
    to: message.to.map(apiAddressToParticipant).filter(isMailParticipant),
    sentAt: displayDate(message.sentAt),
    body: message.body,
  }));
  return {
    id: thread.id,
    subject: thread.subject,
    preview: thread.preview,
    participants: thread.participants.map(apiAddressToParticipant).filter(isMailParticipant),
    messages,
    labels: thread.labels,
    mailbox:
      thread.archivedAt === null ? (thread.direction === "outbound" ? "sent" : "inbox") : "archive",
    lastActivity: displayDate(thread.lastActivity),
    unread: thread.unread,
    starred: thread.starred,
    snoozedUntil: thread.snoozedUntil,
    hasAttachment: thread.messages.some((message) => message.hasAttachment),
    priority: "normal",
  };
}

function sampleMailThread(input: {
  readonly id: string;
  readonly from: MailParticipant;
  readonly subject: string;
  readonly preview: string;
  readonly labels: readonly string[];
  readonly lastActivity: string;
  readonly unread: boolean;
  readonly hasAttachment: boolean;
  readonly priority: "normal" | "high";
  readonly mailbox?: MailboxId;
}): MailThread {
  return {
    id: input.id,
    subject: input.subject,
    preview: input.preview,
    participants: [input.from],
    messages: [
      {
        id: `${input.id}-message-1`,
        from: input.from,
        to: [{ name: "Maya Chen", email: "maya@helix.local" }],
        sentAt: input.lastActivity,
        body: `${input.preview}\n\nThis sample message is available locally so the mailbox layout stays populated while backend mail tools are unavailable.`,
      },
    ],
    labels: input.labels,
    mailbox: input.mailbox ?? "inbox",
    lastActivity: input.lastActivity,
    unread: input.unread,
    starred: input.priority === "high",
    hasAttachment: input.hasAttachment,
    priority: input.priority,
  };
}

function tomorrowIso() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString();
}

function upsertThread(threads: readonly MailThread[], next: MailThread): readonly MailThread[] {
  return threads.some((thread) => thread.id === next.id)
    ? threads.map((thread) => (thread.id === next.id ? next : thread))
    : [next, ...threads];
}

function mergeMailFilters(
  base: readonly MailFilterRecord[],
  overrides: readonly MailFilterRecord[],
): readonly MailFilterRecord[] {
  const merged = new Map(base.map((filter) => [filter.id, filter]));
  for (const filter of overrides) {
    merged.set(filter.id, filter);
  }
  return [...merged.values()].sort((left, right) => {
    const priorityDelta = left.priority - right.priority;
    return priorityDelta === 0 ? left.createdAt.localeCompare(right.createdAt) : priorityDelta;
  });
}

function optimisticMailFilter(input: {
  readonly name: string;
  readonly criteria: MailFilterCriteria;
  readonly actions: MailFilterActions;
}): MailFilterRecord {
  const now = new Date().toISOString();
  return {
    id: `local-${now}`,
    name: input.name,
    enabled: true,
    priority: 100,
    criteria: input.criteria,
    actions: input.actions,
    createdAt: now,
    updatedAt: now,
  };
}

function describeFilterCriteria(criteria: MailFilterCriteria): string {
  const parts = [
    criteria.fromContains === undefined ? undefined : `from contains ${criteria.fromContains}`,
    criteria.toContains === undefined ? undefined : `to contains ${criteria.toContains}`,
    criteria.subjectContains === undefined
      ? undefined
      : `subject contains ${criteria.subjectContains}`,
    criteria.bodyContains === undefined ? undefined : `body contains ${criteria.bodyContains}`,
    criteria.hasAttachment ? "has attachments" : undefined,
  ].filter(isString);
  return parts.length === 0 ? "All mail" : parts.join(", ");
}

function describeFilterActions(actions: MailFilterActions): string {
  const parts = [
    actions.applyLabels === undefined || actions.applyLabels.length === 0
      ? undefined
      : `label ${actions.applyLabels.join(", ")}`,
    actions.archive ? "archive" : undefined,
    actions.delete ? "delete" : undefined,
    actions.snoozeUntil === undefined ? undefined : `snooze until ${actions.snoozeUntil}`,
  ].filter(isString);
  return parts.length === 0 ? "No automatic action" : parts.join(", ");
}

function isMailFilterRecord(value: unknown): value is MailFilterRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "name" in value &&
    "enabled" in value
  );
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function participantToApiAddress(participant: MailParticipant): MailApiAddress {
  return {
    address: participant.email,
    ...(participant.name.length === 0 ? {} : { name: participant.name }),
  };
}

function apiAddressToParticipant(address: MailApiAddress | undefined): MailParticipant | undefined {
  if (address === undefined) {
    return undefined;
  }
  return {
    name: address.name ?? address.address,
    email: address.address,
  };
}

function isMailParticipant(value: MailParticipant | undefined): value is MailParticipant {
  return value !== undefined;
}

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
}
