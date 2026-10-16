/* Conversation header: who or what you are talking to, plus Schedule an
   event, Add people (spaces) and the details panel toggle. On phones it
   leads with a Back button to the conversation list. */

import { PeoplePicker } from "@/components/people/people-picker";
import { Dialog } from "@/components/ui/helix-dialog";
import { InlineError } from "@/components/ui/inline-error";
import type { PersonRef } from "@/features/people/person-ref";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft as BackIcon,
  CalendarPlus as ScheduleIcon,
  PanelRight as DetailsIcon,
  UserPlus as AddPeopleIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { inviteToRoom } from "./api";
import { ConversationAvatar } from "./chat-sidebar";
import { chatQueryKeys } from "./queries";
import type { ChatConversationView } from "./view-model";

interface ChatConversationHeaderProps {
  readonly conversation: ChatConversationView;
  readonly detailsOpen: boolean;
  readonly detailsId: string;
  readonly onToggleDetails: () => void;
  readonly onBack: () => void;
  readonly onScheduleEvent: () => void;
  readonly onAddPeople?: (() => void) | undefined;
}

export function ChatConversationHeader({
  conversation,
  detailsOpen,
  detailsId,
  onToggleDetails,
  onBack,
  onScheduleEvent,
  onAddPeople,
}: ChatConversationHeaderProps) {
  const meta =
    conversation.kind === "space"
      ? `${String(conversation.memberCount)} members`
      : conversation.peer === null
        ? `${String(conversation.memberCount)} people`
        : (conversation.presenceLabel ?? (conversation.active ? "Active" : null));
  return (
    <header className="chat-conversation-header">
      <button
        type="button"
        className="icon-btn chat-back"
        aria-label="Back to conversations"
        onClick={onBack}
      >
        <BackIcon size={18} aria-hidden="true" />
      </button>
      <ConversationAvatar conversation={conversation} size={32} />
      <div className="chat-conversation-title">
        <h2 className="chat-conversation-name" title={conversation.name}>
          {conversation.name}
        </h2>
        {meta === null ? null : <span className="chat-conversation-meta">{meta}</span>}
      </div>
      <div className="chat-conversation-actions">
        <button
          type="button"
          className="icon-btn"
          aria-label="Schedule an event with these people"
          title="Schedule an event"
          onClick={onScheduleEvent}
        >
          <ScheduleIcon size={18} aria-hidden="true" />
        </button>
        {onAddPeople === undefined ? null : (
          <button
            type="button"
            className="icon-btn"
            aria-label="Add people"
            title="Add people"
            onClick={onAddPeople}
          >
            <AddPeopleIcon size={18} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          aria-label="Conversation details"
          title="Conversation details"
          aria-expanded={detailsOpen}
          aria-controls={detailsOpen ? detailsId : undefined}
          onClick={onToggleDetails}
        >
          <DetailsIcon size={18} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

/** Add people to a space with the people picker. */
export function AddPeopleDialog({
  roomId,
  roomName,
  memberActorIds,
  onClose,
}: {
  readonly roomId: string;
  readonly roomName: string;
  readonly memberActorIds: ReadonlySet<string>;
  readonly onClose: () => void;
}) {
  const [people, setPeople] = useState<PersonRef[]>([]);
  const queryClient = useQueryClient();
  const formId = useId();
  const actorIds = people.flatMap((person) =>
    person.actorId === null || memberActorIds.has(person.actorId) ? [] : [person.actorId],
  );
  const invite = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: () => inviteToRoom({ roomId, actorIds }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatQueryKeys.rooms() });
      onClose();
    },
  });
  return (
    <Dialog
      modal={false}
      title={`Add people to ${roomName}`}
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
            disabled={actorIds.length === 0 || invite.isPending}
          >
            {invite.isPending ? "Adding…" : "Add"}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="chat-form chat-form-people"
        onSubmit={(event) => {
          event.preventDefault();
          if (actorIds.length > 0) invite.mutate();
        }}
      >
        <PeoplePicker
          label="People"
          placeholder="Name or email"
          value={people}
          onChange={setPeople}
        />
        {people.length > actorIds.length ? (
          <p className="chat-form-hint">People who are already members are skipped.</p>
        ) : null}
        {invite.isError ? (
          <InlineError
            variant="compact"
            title="Couldn’t add people"
            message={
              invite.error instanceof Error && invite.error.message.length > 0
                ? invite.error.message
                : "Only space owners and moderators can add people."
            }
          />
        ) : null}
      </form>
    </Dialog>
  );
}
