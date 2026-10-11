/* What a person can do in a conversation: send (over the socket, falling
   back to the REST tool), reply in a thread, react, edit, delete, pin,
   forward to Mail, copy a link, and start a meeting. Failures surface as
   error toasts with the server's reason. */

import { notify } from "@/components/ui/toast";
import { openCompose } from "@/features/mail/compose";
import { createMeetRoom } from "@/features/meet/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  deleteChatMessage,
  editChatMessage,
  pinChatMessage,
  reactToChatMessage,
  replyInThread,
  sendChatMessage,
  unpinChatMessage,
  type ChatEditInput,
  type ChatReactInput,
} from "./api";
import type { ChatComposerSubmission } from "./chat-composer";
import type { ChatMessageActions } from "./chat-message-row";
import { chatQueryKeys } from "./queries";
import type { ChatRealtimeState } from "./use-chat-realtime";
import type { ChatMessageView } from "./view-model";

function failed(action: string) {
  return (error: unknown) =>
    notify({
      tone: "error",
      message: `Couldn’t ${action}`,
      description:
        error instanceof Error && error.message.length > 0
          ? error.message
          : "Try again in a moment.",
    });
}

/** A link that opens this conversation at the message. */
function chatMessageLink(roomId: string, messageId: string): string {
  const url = new URL("/chat", window.location.origin);
  url.searchParams.set("room", roomId);
  url.searchParams.set("message", messageId);
  return url.toString();
}

export function useMessageActions({
  roomId,
  roomName,
  otherActorIds,
  realtime,
  threadId,
  onOpenThread,
  onCloseThread,
}: {
  readonly roomId: string;
  readonly roomName: string;
  readonly otherActorIds: readonly string[];
  readonly realtime: ChatRealtimeState;
  readonly threadId: string | null;
  readonly onOpenThread: (messageId: string) => void;
  readonly onCloseThread: () => void;
}) {
  const queryClient = useQueryClient();
  const refreshMessages = () =>
    void queryClient.invalidateQueries({ queryKey: chatQueryKeys.messagesInfinite(roomId) });
  const refreshThread = () => {
    void queryClient.invalidateQueries({ queryKey: chatQueryKeys.thread(roomId, threadId) });
    refreshMessages();
  };

  const send = useMutation({
    onMutate: () => undefined,
    mutationFn: (submission: ChatComposerSubmission) => sendChatMessage({ roomId, ...submission }),
    onError: failed("send the message"),
    onSuccess: refreshMessages,
  });
  const reply = useMutation({
    onMutate: () => undefined,
    mutationFn: (submission: ChatComposerSubmission & { readonly parentMessageId: string }) =>
      replyInThread({ roomId, ...submission }),
    onError: failed("send the reply"),
    onSuccess: refreshThread,
  });
  const react = useMutation({
    onMutate: () => undefined,
    mutationFn: (input: ChatReactInput) => reactToChatMessage(input),
    onError: failed("update the reaction"),
    onSuccess: refreshThread,
  });
  const edit = useMutation({
    onMutate: () => undefined,
    mutationFn: (input: ChatEditInput) => editChatMessage(input),
    onError: failed("edit the message"),
    onSuccess: refreshThread,
  });
  const remove = useMutation({
    onMutate: () => undefined,
    mutationFn: (messageId: string) => deleteChatMessage(messageId),
    onError: failed("delete the message"),
    onSuccess: refreshThread,
  });
  const pin = useMutation({
    onMutate: () => undefined,
    mutationFn: async (message: ChatMessageView): Promise<void> => {
      const input = { roomId, messageId: message.id };
      await (message.pinned ? unpinChatMessage(input) : pinChatMessage(input));
    },
    onError: failed("change the pin"),
    onSuccess: (_result, message) => {
      void queryClient.invalidateQueries({ queryKey: chatQueryKeys.pins(roomId) });
      refreshThread();
      notify({ message: message.pinned ? "Message unpinned" : "Message pinned" });
    },
  });

  const sendMessage = (submission: ChatComposerSubmission) => {
    // Prefer the live socket; fall back to the REST tool when it is closed.
    if (!realtime.sendMessage(submission)) send.mutate(submission);
  };

  const actions = useMemo<Omit<ChatMessageActions, "onReact">>(
    () => ({
      onOpenThread,
      onForward: (message) => {
        const sent = new Date(message.sentAt).toLocaleString();
        openCompose({
          subject: `Chat message from ${message.authorName} in ${roomName}`,
          body: [
            `${message.authorName} wrote in ${roomName} on ${sent}:`,
            "",
            ...message.body.split("\n").map((line) => `> ${line}`),
            "",
            `Open in Chat: ${chatMessageLink(roomId, message.id)}`,
          ].join("\n"),
        });
      },
      onCopyLink: (message) => {
        void navigator.clipboard
          .writeText(chatMessageLink(roomId, message.id))
          .then(() => notify({ message: "Link copied" }))
          .catch(failed("copy the link"));
      },
      onTogglePin: (message) => pin.mutate(message),
      onEdit: (messageId, body) => edit.mutate({ messageId, body }),
      onDelete: (messageId) => {
        remove.mutate(messageId);
        if (messageId === threadId) onCloseThread();
      },
      onRetryPending: (clientMessageId) => {
        realtime.retryPending(clientMessageId);
      },
    }),
    [roomId, roomName, threadId, onOpenThread, onCloseThread, pin, edit, remove, realtime],
  );

  return {
    actionsFor: (messages: readonly ChatMessageView[]): ChatMessageActions => ({
      ...actions,
      onReact: (messageId, emoji) => {
        const mine = messages
          .find((message) => message.id === messageId)
          ?.reactions.some((reaction) => reaction.emoji === emoji && reaction.mine);
        react.mutate({ messageId, emoji, op: mine === true ? "remove" : "add" });
      },
    }),
    sendMessage,
    sendReply: (submission: ChatComposerSubmission) => {
      if (threadId !== null) reply.mutate({ ...submission, parentMessageId: threadId });
    },
    startMeeting: async () => {
      const room = await createMeetRoom({
        subject: `${roomName} meeting`,
        participantActorIds: otherActorIds,
      });
      const link = new URL("/meet", window.location.origin);
      link.searchParams.set("code", room.joinCode);
      sendMessage({
        body: `I started a meeting: [Join the meeting](${link.toString()})`,
        bodyFormat: "markdown",
        attachmentObjectIds: [],
        attachments: [],
      });
    },
  };
}
