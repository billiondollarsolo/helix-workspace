import type { SlideContent } from "./seed";

export interface GeneratedPresentationSlide {
  readonly content: SlideContent;
  readonly speakerNotes: string;
}

export interface GeneratedPresentationDeck {
  readonly title: string;
  readonly slides: readonly GeneratedPresentationSlide[];
}

export function generatePresentationDeck(prompt: string): GeneratedPresentationDeck {
  const topics = promptTopics(prompt);
  const title = titleFromPrompt(prompt, topics);
  const bodyTopics = topics.length > 0 ? topics : ["Audience", "Plan", "Risks", "Next steps"];
  const agenda = bodyTopics.slice(0, 5);
  const primary = bodyTopics[0] ?? "Opportunity";
  const secondary = bodyTopics[1] ?? "Execution";
  const tertiary = bodyTopics[2] ?? "Momentum";

  return {
    title,
    slides: [
      {
        content: {
          layout: "title",
          title,
          subtitle: `A focused narrative for ${naturalList(bodyTopics.slice(0, 3))}.`,
          bg: "accent",
        },
        speakerNotes: `Open by framing why ${title} matters now.`,
      },
      {
        content: { layout: "agenda", title: "Discussion flow", items: agenda },
        speakerNotes: `Set expectations around ${naturalList(agenda)}.`,
      },
      {
        content: {
          layout: "bullets",
          title: primary,
          items: [
            `Current state for ${lowercaseFirst(primary)}`,
            `What changes for ${lowercaseFirst(secondary)}`,
            `Decision needed on ${lowercaseFirst(tertiary)}`,
          ],
        },
        speakerNotes: `Use this slide to make ${primary} concrete.`,
      },
      {
        content: {
          layout: "stats",
          title: "Success signals",
          stats: [
            { value: "3", label: "Focus areas", note: primary },
            { value: "30d", label: "Near-term window", note: secondary },
            { value: "1", label: "Primary decision", note: tertiary },
          ],
        },
        speakerNotes: "Anchor the story in measurable checkpoints.",
      },
      {
        content: {
          layout: "split",
          title: "Tradeoffs",
          left: `The opportunity is strongest when ${lowercaseFirst(primary)} stays connected to execution.`,
          rightKind: "list",
          rightContent: [`Invest in ${primary}`, `Reduce risk in ${secondary}`, `Track ${tertiary}`],
        },
        speakerNotes: "Make the tradeoff explicit before asking for alignment.",
      },
      {
        content: {
          layout: "bullets",
          title: "Next steps",
          items: ["Confirm owner", "Set timeline", "Publish follow-up"],
        },
        speakerNotes: "Close with owners, timeline, and the immediate follow-up.",
      },
    ],
  };
}

function promptTopics(prompt: string): readonly string[] {
  return prompt
    .split(/[\n,;]+/u)
    .flatMap((part) => part.split(/\band\b/iu))
    .map((part) => titleCase(part.replace(/[^a-z0-9 %/$+-]+/giu, " ").trim()))
    .filter((part) => part.length > 0)
    .slice(0, 6);
}

function titleFromPrompt(prompt: string, topics: readonly string[]): string {
  const firstLine = prompt
    .split(/\n/u)[0]
    ?.replace(/[^a-z0-9 %/$+-]+/giu, " ")
    .trim();
  if (firstLine !== undefined && firstLine.length >= 4 && firstLine.length <= 70) {
    return titleCase(firstLine);
  }
  return topics[0] === undefined ? "Generated Presentation" : `${topics[0]} Briefing`;
}

function titleCase(value: string): string {
  return value
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}`)
    .join(" ");
}

function naturalList(values: readonly string[]): string {
  if (values.length === 0) {
    return "the core topic";
  }
  if (values.length === 1) {
    return values[0] ?? "the core topic";
  }
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1) ?? ""}`;
}

function lowercaseFirst(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toLowerCase() ?? ""}${value.slice(1)}`;
}
