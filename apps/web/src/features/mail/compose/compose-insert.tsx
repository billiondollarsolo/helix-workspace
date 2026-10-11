/* Insert link and Insert emoji for the compose body. */

import { Smile } from "lucide-react";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "@/components/ui/helix-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { safeLinkHref } from "./compose-html";

export function InsertLinkDialog({
  initialText,
  onInsert,
  onClose,
}: {
  readonly initialText: string;
  readonly onInsert: (input: { readonly url: string; readonly text: string }) => void;
  readonly onClose: () => void;
}) {
  const id = useId();
  const [text, setText] = useState(initialText);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (safeLinkHref(url) === null) {
      setError("Enter a web address (https://…) or an email address.");
      return;
    }
    onInsert({ url, text });
  };
  return createPortal(
    <Dialog
      title="Insert link"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={`${id}-form`} className="btn primary">
            Insert
          </button>
        </>
      }
    >
      <form
        id={`${id}-form`}
        className="compose-link-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label htmlFor={`${id}-text`}>Text to display</label>
        <input
          id={`${id}-text`}
          className="input"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        <label htmlFor={`${id}-url`}>Web address or email</label>
        <input
          id={`${id}-url`}
          className="input"
          inputMode="url"
          value={url}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : `${id}-error`}
          onChange={(event) => {
            setUrl(event.target.value);
            setError(null);
          }}
        />
        {error === null ? null : (
          <p id={`${id}-error`} role="alert" className="compose-error">
            {error}
          </p>
        )}
      </form>
    </Dialog>,
    document.body,
  );
}

const EMOJI: readonly (readonly [string, string])[] = [
  ["😀", "Grinning face"],
  ["😄", "Smiling face with open mouth"],
  ["😊", "Smiling face"],
  ["🙂", "Slightly smiling face"],
  ["😉", "Winking face"],
  ["😍", "Heart eyes"],
  ["😂", "Tears of joy"],
  ["🤣", "Rolling on the floor laughing"],
  ["😅", "Sweat smile"],
  ["😎", "Sunglasses"],
  ["🤔", "Thinking face"],
  ["😮", "Surprised face"],
  ["😢", "Crying face"],
  ["😴", "Sleeping face"],
  ["🙃", "Upside-down face"],
  ["😬", "Grimacing face"],
  ["👍", "Thumbs up"],
  ["👎", "Thumbs down"],
  ["👏", "Clapping hands"],
  ["🙌", "Raised hands"],
  ["🙏", "Folded hands"],
  ["👋", "Waving hand"],
  ["💪", "Flexed biceps"],
  ["🤝", "Handshake"],
  ["❤️", "Red heart"],
  ["🎉", "Party popper"],
  ["✨", "Sparkles"],
  ["🔥", "Fire"],
  ["⭐", "Star"],
  ["✅", "Check mark"],
  ["❌", "Cross mark"],
  ["⚠️", "Warning"],
  ["📎", "Paperclip"],
  ["📅", "Calendar"],
  ["⏰", "Alarm clock"],
  ["☕", "Hot beverage"],
  ["🚀", "Rocket"],
  ["💡", "Light bulb"],
  ["📌", "Pushpin"],
  ["👀", "Eyes"],
];

export function EmojiButton({
  onPick,
  onOpen,
}: {
  readonly onPick: (emoji: string) => void;
  /** Called before the picker opens, so the caller can remember the caret. */
  readonly onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const picked = useRef(false);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) onOpen();
        setOpen(next);
      }}
    >
      <PopoverTrigger className="compose-icon-btn" aria-label="Insert emoji" title="Insert emoji">
        <Smile aria-hidden="true" size={18} />
      </PopoverTrigger>
      <PopoverContent
        aria-label="Insert emoji"
        side="top"
        className="w-auto"
        onCloseAutoFocus={(event) => {
          // The emoji went into the message; leave the caret there.
          if (picked.current) event.preventDefault();
          picked.current = false;
        }}
      >
        <div className="compose-emoji-grid">
          {EMOJI.map(([emoji, name]) => (
            <button
              key={emoji}
              type="button"
              className="compose-emoji focus-ring"
              aria-label={name}
              title={name}
              onClick={() => {
                picked.current = true;
                onPick(emoji);
                setOpen(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
