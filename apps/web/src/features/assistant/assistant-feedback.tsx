/* Thumbs up/down on a saved answer. Pressing the active rating again clears
   it; a thumbs down offers an optional comment. Feedback is private to the
   person who gave it. */

import { useMutation } from "@tanstack/react-query";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { setAssistantMessageFeedback, type AssistantMessageFeedback } from "./api";

type Rating = AssistantMessageFeedback["rating"];

export function AssistantFeedbackButtons({
  conversationId,
  messageId,
  initial,
}: {
  readonly conversationId: string;
  readonly messageId: string;
  readonly initial: AssistantMessageFeedback | undefined;
}) {
  const [rating, setRating] = useState<Rating | null>(initial?.rating ?? null);
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState(initial?.comment ?? "");
  const commentId = useId();
  const mutation = useMutation({
    mutationFn: (input: { readonly rating: Rating | null; readonly comment?: string }) =>
      setAssistantMessageFeedback({ conversationId, messageId, ...input }),
    // Show the new rating at once; put the previous one back if saving fails.
    onMutate: (input) => {
      const previous = rating;
      setRating(input.rating);
      return { previous };
    },
    onSuccess: (result, input) => {
      setRating(result.feedback?.rating ?? null);
      if (input.comment !== undefined) {
        setCommenting(false);
        notify({ message: "Thanks for the feedback" });
      }
    },
    onError: (_error, _input, context) => {
      setRating(context?.previous ?? null);
      setCommenting(false);
      notify({ message: "Couldn't save your feedback. Try again.", tone: "error" });
    },
  });
  const rate = (next: Rating) => {
    const value = rating === next ? null : next;
    setCommenting(value === "down");
    mutation.mutate({ rating: value });
  };
  return (
    <>
      <button
        type="button"
        className="icon-btn"
        aria-label="Good response"
        aria-pressed={rating === "up"}
        disabled={mutation.isPending}
        onClick={() => rate("up")}
      >
        <ThumbsUp size={16} fill={rating === "up" ? "currentColor" : "none"} />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="Bad response"
        aria-pressed={rating === "down"}
        disabled={mutation.isPending}
        onClick={() => rate("down")}
      >
        <ThumbsDown size={16} fill={rating === "down" ? "currentColor" : "none"} />
      </button>
      {commenting ? (
        <form
          className="mt-2 basis-full grid gap-2"
          aria-label="Feedback on this response"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate({ rating: "down", comment: comment.trim() });
          }}
        >
          <label htmlFor={commentId} className="type-caption text-muted-foreground">
            What could be better? (optional)
          </label>
          <textarea
            id={commentId}
            className="min-h-16 rounded-md border border-border bg-background p-2 type-body-sm"
            maxLength={2000}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={mutation.isPending}>
              Send feedback
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setCommenting(false)}>
              Not now
            </Button>
          </div>
        </form>
      ) : null}
    </>
  );
}
