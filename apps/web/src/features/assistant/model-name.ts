/* Friendly model names. The catalog labels each model "<provider> · <model>",
   where the model part is the provider's configured display name when it has
   one and the raw model id otherwise. Raw ids are humanized. */

import type { AssistantModels } from "./api";

type AssistantModel = AssistantModels["models"][number];

const ACRONYMS: Readonly<Record<string, string>> = {
  ai: "AI",
  e2e: "E2E",
  gpt: "GPT",
  llm: "LLM",
  qwq: "QwQ",
};

/** The name to show for a model: its configured display name, or a readable id. */
export function assistantModelName(model: AssistantModel): string {
  const separator = model.label.lastIndexOf(" · ");
  const configured = separator === -1 ? model.label : model.label.slice(separator + 3);
  return configured.trim().length > 0 && configured !== model.model
    ? configured.trim()
    : humanizeModelId(model.model);
}

/** Names for a model list, with the provider added where two names collide. */
export function assistantModelNames(
  models: readonly AssistantModel[],
): ReadonlyMap<string, string> {
  const names = new Map(models.map((model) => [model.id, assistantModelName(model)]));
  const counts = new Map<string, number>();
  for (const name of names.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const model of models) {
    const name = names.get(model.id) ?? model.id;
    if ((counts.get(name) ?? 0) > 1) {
      const separator = model.label.lastIndexOf(" · ");
      const provider = separator === -1 ? model.providerId : model.label.slice(0, separator);
      names.set(model.id, `${name} (${provider})`);
    }
  }
  return names;
}

/** "claude-sonnet-4-5-20250929" → "Claude Sonnet 4.5"; "gpt-4o-mini" → "GPT-4o Mini". */
export function humanizeModelId(id: string): string {
  const base = (id.split("/").pop() ?? id)
    .replace(/[-_@](?:\d{8}|\d{4}-\d{2}-\d{2}|latest)$/iu, "")
    .trim();
  const tokens = base.split(/[-_\s:]+/u).filter((token) => token.length > 0);
  const words: string[] = [];
  for (const token of tokens) {
    const previous = words.at(-1);
    if (previous !== undefined && /^\d$/u.test(token) && /(?:^|\s)\d+$/u.test(previous)) {
      // Split version numbers ("4-5") read as "4.5".
      words[words.length - 1] = `${previous}.${token}`;
    } else if (previous === "GPT" && /^\d/u.test(token)) {
      words[words.length - 1] = `GPT-${token}`;
    } else {
      words.push(word(token));
    }
  }
  return words.join(" ") || id;
}

function word(token: string): string {
  const lower = token.toLowerCase();
  const acronym = ACRONYMS[lower];
  if (acronym !== undefined) return acronym;
  if (/^\d+(?:\.\d+)?[bkm]$/iu.test(token)) return token.toUpperCase();
  if (/^\d/u.test(token)) return token;
  return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
}
