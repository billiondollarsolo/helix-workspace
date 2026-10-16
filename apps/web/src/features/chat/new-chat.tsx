/* "+ New chat": start a chat with people (one person is a direct message,
   several make a group conversation), create a space, or browse the spaces
   anyone in the organization can join. */

import { PeoplePicker } from "@/components/people/people-picker";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { FormPanel } from "@/components/ui/form-panel";
import { InlineError } from "@/components/ui/inline-error";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import type { PersonRef } from "@/features/people/person-ref";
import { useDebouncedValue } from "@tanstack/react-pacer/debouncer";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Compass as BrowseIcon,
  MessageCirclePlus as StartChatIcon,
  Plus as PlusIcon,
  Users as SpaceIcon,
} from "lucide-react";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createChatRoom, joinChatRoom, type CreateChatRoomRequest } from "./api";
import { chatDiscoverQueryOptions, chatQueryKeys } from "./queries";
import { TriggerButton } from "./trigger-button";

type NewChatDialog = "start" | "space" | "browse" | null;

interface NewChatProps {
  /** `sidebar` is the primary sidebar action; `fab` floats over the phone list. */
  readonly variant: "sidebar" | "fab";
  readonly joinedRoomIds: ReadonlySet<string>;
  readonly onOpenRoom: (roomId: string) => void;
}

export function NewChat({ variant, joinedRoomIds, onOpenRoom }: NewChatProps) {
  const [dialog, setDialog] = useState<NewChatDialog>(null);
  // The dialog takes focus; stop the closing menu from pulling it back.
  const openingRef = useRef(false);
  const openDialog = (next: Exclude<NewChatDialog, null>) => {
    openingRef.current = true;
    setDialog(next);
  };
  const close = () => setDialog(null);
  const opened = (roomId: string) => {
    close();
    onOpenRoom(roomId);
  };

  return (
    <>
      <Menu modal={false}>
        <MenuTrigger asChild>
          {variant === "sidebar" ? (
            <TriggerButton className="btn primary lg w-full chat-new-chat">
              <PlusIcon size={18} aria-hidden="true" />
              New chat
            </TriggerButton>
          ) : (
            <TriggerButton className="chat-fab" aria-label="New chat">
              <PlusIcon size={24} aria-hidden="true" />
            </TriggerButton>
          )}
        </MenuTrigger>
        <MenuContent
          align="start"
          onCloseAutoFocus={(event) => {
            if (openingRef.current) {
              openingRef.current = false;
              event.preventDefault();
            }
          }}
        >
          <MenuItem icon={<StartChatIcon />} onSelect={() => openDialog("start")}>
            Start a chat
          </MenuItem>
          <MenuItem icon={<SpaceIcon />} onSelect={() => openDialog("space")}>
            Create a space
          </MenuItem>
          <MenuItem icon={<BrowseIcon />} onSelect={() => openDialog("browse")}>
            Browse spaces
          </MenuItem>
        </MenuContent>
      </Menu>
      {/* Outside the sidebar, which hides its extras when navigation collapses. */}
      {dialog === null
        ? null
        : createPortal(
            dialog === "start" ? (
              <StartChatDialog onClose={close} onCreated={opened} />
            ) : dialog === "space" ? (
              <CreateSpaceDialog onClose={close} onCreated={opened} />
            ) : (
              <BrowseSpacesDialog onClose={close} joinedRoomIds={joinedRoomIds} onOpened={opened} />
            ),
            document.body,
          )}
    </>
  );
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function useCreateRoom(onCreated: (roomId: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (input: CreateChatRoomRequest) => createChatRoom(input),
    onSuccess: (room) => {
      void queryClient.invalidateQueries({ queryKey: chatQueryKeys.rooms() });
      void queryClient.invalidateQueries({ queryKey: chatQueryKeys.unread() });
      onCreated(room.id);
    },
  });
}

/** Pick people: one opens (or reuses) a direct message; more make a group conversation. */
export function StartChatDialog({
  onClose,
  onCreated,
  initialPeople = [],
}: {
  readonly onClose: () => void;
  readonly onCreated: (roomId: string) => void;
  readonly initialPeople?: readonly PersonRef[];
}) {
  const [people, setPeople] = useState<PersonRef[]>([...initialPeople]);
  const create = useCreateRoom(onCreated);
  const formId = useId();
  const actorIds = people.flatMap((person) => (person.actorId === null ? [] : [person.actorId]));

  return (
    <FormPanel
      title="Start a chat"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className="btn primary"
            disabled={actorIds.length === 0 || create.isPending}
          >
            {create.isPending ? "Starting…" : "Start chat"}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="chat-form chat-form-people"
        onSubmit={(event) => {
          event.preventDefault();
          if (actorIds.length > 0) create.mutate({ kind: "chat_dm", memberActorIds: actorIds });
        }}
      >
        <PeoplePicker
          label="People"
          placeholder="Add people by name or email"
          value={people}
          onChange={setPeople}
        />
        <p className="chat-form-hint">
          {actorIds.length > 1
            ? "Starts a group conversation with everyone you add."
            : "Add one person for a direct message, or several for a group conversation."}
        </p>
        {create.isError ? (
          <InlineError
            variant="compact"
            title="Couldn’t start the chat"
            message={errorText(create.error, "Try again in a moment.")}
          />
        ) : null}
      </form>
    </FormPanel>
  );
}

function CreateSpaceDialog({
  onClose,
  onCreated,
}: {
  readonly onClose: () => void;
  readonly onCreated: (roomId: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [privacy, setPrivacy] = useState<"restricted" | "discoverable">("restricted");
  const [people, setPeople] = useState<PersonRef[]>([]);
  const create = useCreateRoom(onCreated);
  const id = useId();
  const valid = name.trim().length > 0;

  return (
    <FormPanel
      title="Create a space"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={`${id}-form`}
            className="btn primary"
            disabled={!valid || create.isPending}
          >
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </>
      }
    >
      <form
        id={`${id}-form`}
        className="chat-form chat-form-people"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          create.mutate({
            kind: "chat_room",
            subject: name.trim(),
            ...(description.trim().length > 0 ? { topic: description.trim() } : {}),
            privacy,
            memberActorIds: people.flatMap((person) =>
              person.actorId === null ? [] : [person.actorId],
            ),
          });
        }}
      >
        <label className="chat-field" htmlFor={`${id}-name`}>
          <span>Space name</span>
          <input
            id={`${id}-name`}
            className="input"
            required
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="chat-field" htmlFor={`${id}-description`}>
          <span>Description (optional)</span>
          <textarea
            id={`${id}-description`}
            className="input"
            rows={2}
            maxLength={500}
            placeholder="What is this space for?"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <fieldset className="chat-field">
          <legend>Access</legend>
          <label className="chat-radio">
            <input
              type="radio"
              name={`${id}-privacy`}
              checked={privacy === "restricted"}
              onChange={() => setPrivacy("restricted")}
            />
            <span>
              Restricted
              <small>Only people who are added can find and join.</small>
            </span>
          </label>
          <label className="chat-radio">
            <input
              type="radio"
              name={`${id}-privacy`}
              checked={privacy === "discoverable"}
              onChange={() => setPrivacy("discoverable")}
            />
            <span>
              Anyone in your organization
              <small>People can find this space in Browse spaces and join.</small>
            </span>
          </label>
        </fieldset>
        <PeoplePicker
          label="Add people (optional)"
          placeholder="Name or email"
          value={people}
          onChange={setPeople}
        />
        {create.isError ? (
          <InlineError
            variant="compact"
            title="Couldn’t create the space"
            message={errorText(create.error, "Try again in a moment.")}
          />
        ) : null}
      </form>
    </FormPanel>
  );
}

function BrowseSpacesDialog({
  onClose,
  joinedRoomIds,
  onOpened,
}: {
  readonly onClose: () => void;
  readonly joinedRoomIds: ReadonlySet<string>;
  readonly onOpened: (roomId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced] = useDebouncedValue(query.trim(), { wait: 200 });
  const spaces = useQuery(chatDiscoverQueryOptions(debounced));
  const queryClient = useQueryClient();
  const join = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (roomId: string) => joinChatRoom(roomId),
    onSuccess: (room) => {
      void queryClient.invalidateQueries({ queryKey: chatQueryKeys.rooms() });
      onOpened(room.id);
    },
  });

  return (
    <FormPanel title="Browse spaces" onClose={onClose}>
      <div className="chat-form">
        <input
          type="search"
          className="input"
          aria-label="Search spaces"
          placeholder="Search spaces"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {join.isError ? (
          <InlineError
            variant="compact"
            title="Couldn’t join the space"
            message={errorText(join.error, "Try again in a moment.")}
          />
        ) : null}
        {spaces.isPending ? (
          <Skeleton variant="row" count={4} label="Loading spaces" />
        ) : spaces.isError ? (
          <InlineError
            variant="compact"
            title="Couldn’t load spaces"
            message={errorText(spaces.error, "Check your connection and try again.")}
            onRetry={() =>
              void queryClient.invalidateQueries({ queryKey: chatQueryKeys.discover(debounced) })
            }
            retrying={spaces.isFetching}
          />
        ) : spaces.data.length === 0 ? (
          <EmptyState
            size="inline"
            headingLevel={2}
            icon={<SpaceIcon />}
            title={debounced.length > 0 ? "No spaces match" : "No spaces to join yet"}
            body="Spaces open to everyone in your organization appear here."
          />
        ) : (
          <ul className="chat-browse-list" aria-label="Spaces">
            {spaces.data.map((space) => {
              const name = space.settings?.name ?? space.subject ?? "Untitled space";
              const joined = joinedRoomIds.has(space.id);
              return (
                <li key={space.id} className="chat-browse-row">
                  <Avatar name={name} size={32} className="chat-space-avatar" />
                  <div className="chat-browse-text">
                    <span className="chat-browse-name">{name}</span>
                    {space.settings?.topic ? (
                      <span className="chat-browse-topic">{space.settings.topic}</span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className={joined ? "btn sm" : "btn primary sm"}
                    disabled={join.isPending}
                    aria-label={`${joined ? "Open" : "Join"} ${name}`}
                    onClick={() => (joined ? onOpened(space.id) : join.mutate(space.id))}
                  >
                    {joined
                      ? "Open"
                      : join.isPending && join.variables === space.id
                        ? "Joining…"
                        : "Join"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </FormPanel>
  );
}
