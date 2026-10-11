/* The message body: a sanitized rich-text region, or a plain textarea in
   plain text mode. The rich editor is uncontrolled (the DOM owns the caret);
   it reports sanitized-on-send HTML through onChange and remembers the last
   selection so toolbar popovers can return to it. */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { composeHtmlToText, textToComposeHtml } from "./compose-html";
import { pasteSanitized, saveSelection } from "./editor-commands";

interface ComposeEditorProps {
  readonly html: string;
  readonly plainText: boolean;
  readonly onChange: (html: string) => void;
  readonly editorRef: RefObject<HTMLDivElement | null>;
  readonly selectionRef: RefObject<Range | null>;
  readonly label: string;
  readonly placeholder: string;
  /** Changing this re-seeds the editor from `html` (e.g. after loading a draft). */
  readonly resetKey?: string;
  readonly className?: string;
}

export function ComposeEditor({
  html,
  plainText,
  onChange,
  editorRef,
  selectionRef,
  label,
  placeholder,
  resetKey,
  className,
}: ComposeEditorProps) {
  const [text, setText] = useState(() => (plainText ? composeHtmlToText(html) : ""));
  const htmlRef = useRef(html);
  htmlRef.current = html;

  // Seed the editable region when it mounts, switches back from plain text, or is reset.
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (editor !== null && !plainText) editor.innerHTML = htmlRef.current;
    if (plainText) setText(composeHtmlToText(htmlRef.current));
  }, [editorRef, plainText, resetKey]);

  useEffect(() => {
    const remember = () => {
      const range = saveSelection(editorRef.current);
      if (range !== null) selectionRef.current = range;
    };
    document.addEventListener("selectionchange", remember);
    return () => {
      document.removeEventListener("selectionchange", remember);
    };
  }, [editorRef, selectionRef]);

  if (plainText) {
    return (
      <textarea
        className={`compose-body compose-body-plain ${className ?? ""}`}
        aria-label={label}
        placeholder={placeholder}
        value={text}
        spellCheck
        onChange={(event) => {
          setText(event.target.value);
          onChange(textToComposeHtml(event.target.value));
        }}
      />
    );
  }

  return (
    <div
      ref={editorRef}
      className={`compose-body ${className ?? ""}`}
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      aria-placeholder={placeholder === "" ? undefined : placeholder}
      data-placeholder={placeholder}
      data-empty={html.trim() === "" ? "true" : undefined}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      tabIndex={0}
      onInput={(event) => {
        onChange(event.currentTarget.innerHTML);
      }}
      onPaste={(event) => {
        event.preventDefault();
        pasteSanitized(event.currentTarget, event.clipboardData);
      }}
      onDrop={(event) => {
        // Files dropped on the body attach (handled by the window); never insert raw markup.
        if (event.dataTransfer.files.length === 0) {
          event.preventDefault();
          pasteSanitized(event.currentTarget, event.dataTransfer);
        }
      }}
    />
  );
}
