import { describe, expect, it } from "vitest";
import { projectAssistantMessages } from "./attachments.js";
import { projectAssistantWebSources } from "./tool-sources.js";
import type { AssistantToolCallResult, AssistantMessage } from "./types.js";

const orgId = "workspace";
const url = "https://weather.example/forecast";
function search(link = url): AssistantToolCallResult {
  return {
    toolCallId: "search-1",
    toolId: "web.search",
    status: "executed",
    input: { query: "weather" },
    classification: "standard",
    output: {
      provider: "searxng",
      results: [
        {
          id: "web-1",
          url: link,
          title: "Forecast",
          snippet: "Full snippet stays in the tool result",
        },
      ],
    },
  };
}
function page(): AssistantToolCallResult {
  return {
    toolCallId: "fetch-1",
    toolId: "web.fetch",
    status: "executed",
    input: { url },
    classification: "standard",
    output: {
      url,
      title: "Local daily forecast",
      contentType: "text/html",
      content: "Page contents stay in the tool result",
      offset: 0,
      nextOffset: null,
      totalChars: 36,
      truncated: false,
      classification: "public",
    },
  };
}

describe("Assistant web source projection", () => {
  it("deduplicates URLs across rounds, upgrades actually read pages and persists thin stable records", () => {
    const initial = projectAssistantWebSources({ orgId, toolCalls: [search(), search()] });
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({
      type: "web.search",
      url,
      title: "Forecast",
      classification: "standard",
      trust: "untrusted_retrieved",
      provenance: { orgId },
    });
    const final = projectAssistantWebSources({
      orgId,
      existingSources: initial,
      toolCalls: [page(), search(), search("https://weather.example/other")],
    });
    expect(final).toHaveLength(2);
    expect(final[0]).toMatchObject({
      id: initial[0]?.id,
      type: "web.fetch",
      title: "Local daily forecast",
      classification: "standard",
    });
    expect(final[0]?.id).not.toBe(final[1]?.id);
    expect(JSON.stringify(final)).not.toContain("contents stay");
    expect(JSON.stringify(final)).not.toContain("Full snippet");
    expect(final.every((source) => source.body === undefined)).toBe(true);
    expect(projectAssistantWebSources({ orgId, toolCalls: [], existingSources: final })).toEqual(
      final,
    );
    expect(
      projectAssistantWebSources({
        orgId: "another-workspace",
        toolCalls: [],
        existingSources: final,
      }),
    ).toEqual([]);
  });

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://localhost/",
    "http://127.0.0.1/",
    "https://192.168.0.1/",
    "https://[::1]/",
    "https://metadata.internal/",
    "https://user:password@weather.example/",
  ])("excludes private or unsafe result links: %s", (link) => {
    expect(projectAssistantWebSources({ orgId, toolCalls: [search(link)] })).toEqual([]);
  });

  it("does not present failed, malformed, sensitive or unsupported outputs as sources", () => {
    const call = search();
    const fetched = page();
    expect(
      projectAssistantWebSources({
        orgId,
        toolCalls: [
          { ...call, status: "failed", error: "Search failed" },
          { ...call, classification: "confidential" },
          {
            toolCallId: call.toolCallId,
            toolId: call.toolId,
            status: call.status,
            input: call.input,
            ...(call.output === undefined ? {} : { output: call.output }),
          },
          { ...call, toolId: "unknown.search" },
          { ...call, output: { results: [] } },
          { ...call, output: { ...(call.output as object), error: "Partial failure" } },
          { ...fetched, output: { ...(fetched.output as object), content: "" } },
          { ...fetched, output: { ...(fetched.output as object), classification: "restricted" } },
        ],
      }),
    ).toEqual([]);
  });
  it("reopens server-owned sources, thin activity and originating user selections", () => {
    const sources = projectAssistantWebSources({ orgId, toolCalls: [search()] });
    const base = {
      id: "message",
      orgId,
      conversationId: "conversation",
      actorId: "actor",
      content: "Saved",
      toolCallId: null,
      createdAt: new Date().toISOString(),
      metadata: {},
    } as const;
    const activity = { toolCallId: "search-1", toolId: "web.search", status: "executed" };
    const messages: AssistantMessage[] = [
      { ...base, role: "user", metadata: { toolGroups: ["mail"], webSearch: true } },
      {
        ...base,
        role: "assistant",
        metadata: {
          sources: [
            { id: "drive-file", type: "drive", title: "Private attachment" },
            ...JSON.parse(JSON.stringify(sources)),
            { type: "web.search", url: "malformed" },
          ],
          toolActivity: [
            { ...activity, input: { secret: "never project" }, output: "never project" },
          ],
        },
      },
    ];
    const result = projectAssistantMessages(messages);
    expect(result[0]).toMatchObject({ toolGroups: ["mail"], webSearch: true });
    expect(result[1]?.sources).toEqual(sources);
    expect(result[1]?.toolActivity).toEqual([activity]);
    expect(
      projectAssistantMessages([
        {
          ...base,
          role: "assistant",
          metadata: {
            sources: [{ ...sources[0], url: "http://127.0.0.1/private" }],
            toolActivity: [{ ...activity, status: "invented" }],
          },
        },
      ])[0],
    ).toMatchObject({ sources: [] });
  });
});
