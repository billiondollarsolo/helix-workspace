/* Helix AI in the shell side panel: ask a question or pick a suggestion,
   and the answer opens as a new chat in Helix AI. */

import { useNavigate } from "@tanstack/react-router";
import { Send as SendIcon, Sparkles as SparklesIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ASSISTANT_QUICK_PROMPTS } from "./assistant-data";

export function AssistantSidePanel() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");
  const ask = (prompt: string) => {
    void navigate({ to: "/assistant", search: { prompt } });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const prompt = draft.trim();
    if (prompt.length === 0) return;
    setDraft("");
    ask(prompt);
  };
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border p-3.5">
        <div className="mb-1 flex items-center gap-2 type-body-sm font-semibold text-primary">
          <SparklesIcon size={16} aria-hidden="true" />
          Helix AI
        </div>
        <p className="m-0 type-caption text-muted-foreground">
          Ask about your mail, files, chats, and calendar.
        </p>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        <h3 className="m-0 mb-2 type-overline text-muted-foreground">Suggested</h3>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {ASSISTANT_QUICK_PROMPTS.map((prompt) => (
            <li key={prompt.title}>
              <button
                type="button"
                onClick={() => {
                  ask(prompt.title);
                }}
                className="focus-ring w-full rounded-md border border-border bg-muted px-2.5 py-2 text-left type-meta text-foreground hover:bg-[var(--hover-strong)]"
              >
                {prompt.title}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <form className="flex items-center gap-1.5 border-t border-border p-2.5" onSubmit={submit}>
        <input
          className="input min-w-0 flex-1"
          aria-label="Ask Helix AI"
          placeholder="Ask Helix AI"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
        <button
          type="submit"
          className="btn primary icon"
          aria-label="Send to Helix AI"
          disabled={draft.trim().length === 0}
        >
          <SendIcon size={16} aria-hidden="true" />
        </button>
      </form>
    </div>
  );
}
