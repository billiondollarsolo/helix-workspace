import { createHash } from "node:crypto";
import { isJsonObject } from "@helix/sdk-types";
import { maxClassification } from "../ai/classification/index.js";
import { publicResultUrl, webSearchResultSchema } from "../search/web.js";
import { webFetchResultSchema } from "../search/web-fetch.js";
import type { AssistantSource, AssistantToolCallResult } from "./types.js";

/** Thin, server-owned citation records. Page/snippet contents already live in tool results. */
export function projectAssistantWebSources(input: {
  readonly orgId: string;
  readonly toolCalls: readonly AssistantToolCallResult[];
  readonly existingSources?: readonly AssistantSource[];
}): readonly AssistantSource[] {
  const sources = new Map<string, AssistantSource>();
  const add = (
    type: "web.search" | "web.fetch",
    url: string,
    title: string,
    classification: AssistantSource["classification"],
  ) => {
    const link = publicResultUrl(url);
    if (!link || !["public", "standard"].includes(classification)) return;
    const previous = sources.get(link);
    if (previous?.type === "web.fetch" && type === "web.search") return;
    const id = `web-${createHash("sha256").update(link).digest("hex")}`;
    sources.set(link, {
      id,
      type,
      url: link,
      title: title.trim().slice(0, 200) || link,
      classification: previous
        ? maxClassification(previous.classification, classification)
        : classification,
      trust: "untrusted_retrieved",
      provenance: { sourceId: id, sourceType: type, orgId: input.orgId },
    });
  };
  for (const source of input.existingSources ?? [])
    if (
      (source.type === "web.search" || source.type === "web.fetch") &&
      source.url &&
      source.provenance.orgId === input.orgId
    )
      add(source.type, source.url, source.title ?? "", source.classification);
  for (const call of input.toolCalls) {
    if (
      call.status !== "executed" ||
      !call.classification ||
      call.error ||
      (isJsonObject(call.output) && call.output.error !== undefined)
    )
      continue;
    if (call.toolId === "web.search") {
      const result = webSearchResultSchema.safeParse(call.output);
      if (result.success)
        for (const item of result.data.results)
          add("web.search", item.url, item.title, call.classification);
    } else if (call.toolId === "web.fetch") {
      const result = webFetchResultSchema.safeParse(call.output);
      if (result.success && result.data.content.trim())
        add(
          "web.fetch",
          result.data.url,
          result.data.title,
          maxClassification(call.classification, result.data.classification),
        );
    }
  }
  return [...sources.values()];
}
