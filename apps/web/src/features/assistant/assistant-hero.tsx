/* The new-chat greeting with suggested prompts. Each prompt is sent as-is. */

import { iconMap as Icons } from "@/components/icon-map";
import { Sparkles as SparklesIcon } from "lucide-react";
import { ASSISTANT_QUICK_PROMPTS } from "./assistant-data";

export interface AssistantHeroProps {
  readonly userName: string;
  readonly onPrompt: (prompt: string) => void;
}

export function AssistantHero({ onPrompt, userName }: AssistantHeroProps) {
  const firstName = userName.split(/\s+/u)[0] ?? "";
  return (
    <div className="flex-1 overflow-y-auto px-4 py-8 sm:px-8 sm:py-12">
      <div className="mx-auto max-w-180">
        <div className="mb-4 grid size-10 place-items-center rounded-xl bg-[linear-gradient(135deg,var(--accent),var(--accent-2))] text-[var(--accent-fg)] sm:mb-5 sm:size-14">
          <SparklesIcon size={24} aria-hidden="true" />
        </div>
        <h1 className="m-0 mb-2 type-h1 font-bold tracking-tight sm:type-display">
          {firstName.length > 0 ? (
            <>
              Hi <span className="text-primary">{firstName}</span>, what can I help with?
            </>
          ) : (
            "What can I help with?"
          )}
        </h1>
        <p className="m-0 mb-6 type-body text-[var(--text-2)] sm:mb-8 sm:type-body-lg">
          Ask about your mail, files, chats, and calendar, or start with a suggestion.
        </p>
        <ul
          aria-label="Suggested prompts"
          className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2 sm:gap-2.5"
        >
          {ASSISTANT_QUICK_PROMPTS.map((prompt) => {
            const PromptIcon = Icons[prompt.icon];
            return (
              <li key={prompt.title}>
                <button
                  type="button"
                  onClick={() => {
                    onPrompt(prompt.title);
                  }}
                  className="focus-ring flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors duration-[var(--motion-duration-base)] hover:border-[var(--accent-soft-border)] sm:p-3.5"
                >
                  <span
                    aria-hidden="true"
                    className="grid size-9 shrink-0 place-items-center rounded-lg"
                    style={{
                      background: `var(--label-${prompt.tone}-soft)`,
                      color: `var(--label-${prompt.tone})`,
                    }}
                  >
                    <PromptIcon size={16} />
                  </span>
                  <span className="min-w-0">
                    <span className="block type-body-sm font-semibold">{prompt.title}</span>
                    <span className="mt-0.5 block type-caption text-muted-foreground">
                      {prompt.sub}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
