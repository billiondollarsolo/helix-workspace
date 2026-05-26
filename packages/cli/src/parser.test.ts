import { describe, expect, it } from "vitest";
import { commandActions } from "./completion.js";
import { CliUsageError, parseCliArgs } from "./parser.js";

const folderId = "44444444-4444-4444-8444-444444444444";
const docId = "55555555-5555-4555-8555-555555555555";
const webhookId = "66666666-6666-4666-8666-666666666666";
const deliveryId = "77777777-7777-4777-8777-777777777777";
const actorId = "88888888-8888-4888-8888-888888888888";
const migrationId = "99999999-9999-4999-8999-999999999999";
const exportJobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("parseCliArgs", () => {
  it("parses tool list", () => {
    expect(parseCliArgs(["tool", "list"])).toEqual({ kind: "tool-list" });
    expect(parseCliArgs(["tool", "list", "--source", "openapi"])).toEqual({
      kind: "tool-list",
      source: "openapi",
    });
    expect(parseCliArgs(["tool", "list", "--source", "mcp"])).toEqual({
      kind: "tool-list",
      source: "mcp",
    });
  });

  it("parses tool call with inline JSON", () => {
    expect(parseCliArgs(["tool", "call", "platform.ping", "--json", '{"ok":true}'])).toEqual({
      kind: "tool-call",
      toolId: "platform.ping",
      json: { source: "inline", value: '{"ok":true}' },
    });
  });

  it("parses tool call with MCP transport", () => {
    expect(
      parseCliArgs([
        "tool",
        "call",
        "platform.ping",
        "--transport",
        "mcp",
        "--json",
        '{"ok":true}',
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "platform.ping",
      transport: "mcp",
      json: { source: "inline", value: '{"ok":true}' },
    });
  });

  it("parses tool describe", () => {
    expect(parseCliArgs(["tool", "describe", "platform.ping"])).toEqual({
      kind: "tool-describe",
      toolId: "platform.ping",
    });
  });

  it("parses tool call with stdin JSON", () => {
    expect(parseCliArgs(["tool", "call", "platform.ping", "--json"])).toEqual({
      kind: "tool-call",
      toolId: "platform.ping",
      json: { source: "stdin" },
    });
  });

  it("parses mail aliases as tool calls", () => {
    expect(
      parseCliArgs([
        "mail",
        "send",
        "--to",
        "ada@example.com,grace@example.com",
        "--cc",
        "team@example.com",
        "--subject",
        "Launch",
        "--body",
        "Ready",
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "mail.send",
      json: {
        source: "inline",
        value:
          '{"to":["ada@example.com","grace@example.com"],"cc":["team@example.com"],"subject":"Launch","body":"Ready"}',
      },
    });
    expect(parseCliArgs(["mail", "send", "--json", '{"to":["ada@example.com"]}'])).toEqual({
      kind: "tool-call",
      toolId: "mail.send",
      json: { source: "inline", value: '{"to":["ada@example.com"]}' },
    });
    expect(parseCliArgs(["mail", "reply", "--thread-id", "thread-1", "--body", "Thanks"])).toEqual({
      kind: "tool-call",
      toolId: "mail.reply",
      json: { source: "inline", value: '{"threadId":"thread-1","body":"Thanks"}' },
    });
    expect(parseCliArgs(["mail", "reply", "--json"])).toEqual({
      kind: "tool-call",
      toolId: "mail.reply",
      json: { source: "stdin" },
    });
    expect(parseCliArgs(["mail", "list", "--mailbox", "inbox", "--limit", "25"])).toEqual({
      kind: "tool-call",
      toolId: "mail.list",
      json: { source: "inline", value: '{"mailbox":"inbox","limit":25}' },
    });
    expect(parseCliArgs(["mail", "search", "--query", "roadmap", "--label", "work"])).toEqual({
      kind: "tool-call",
      toolId: "mail.search",
      json: { source: "inline", value: '{"query":"roadmap","label":["work"]}' },
    });
    expect(parseCliArgs(["mail", "search", "--json", '{"query":"roadmap"}'])).toEqual({
      kind: "tool-call",
      toolId: "mail.search",
      json: { source: "inline", value: '{"query":"roadmap"}' },
    });
  });

  const threadId = "11111111-1111-4111-8111-111111111111";
  const filterId = "22222222-2222-4222-8222-222222222222";

  it("parses the mail thread-state subcommands as tool calls", () => {
    expect(
      parseCliArgs([
        "mail",
        "label",
        "--thread-id",
        threadId,
        "--add",
        "work,urgent",
        "--remove",
        "inbox",
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "mail.label.apply",
      json: {
        source: "inline",
        value: `{"threadId":"${threadId}","add":["work","urgent"],"remove":["inbox"]}`,
      },
    });
    expect(parseCliArgs(["mail", "archive", "--thread-id", threadId])).toEqual({
      kind: "tool-call",
      toolId: "mail.archive",
      json: { source: "inline", value: `{"threadId":"${threadId}"}` },
    });
    expect(parseCliArgs(["mail", "delete", "--thread-id", threadId])).toEqual({
      kind: "tool-call",
      toolId: "mail.delete",
      json: { source: "inline", value: `{"threadId":"${threadId}"}` },
    });
    expect(
      parseCliArgs(["mail", "snooze", "--thread-id", threadId, "--until", "2026-06-01T09:00:00Z"]),
    ).toEqual({
      kind: "tool-call",
      toolId: "mail.snooze",
      json: {
        source: "inline",
        value: `{"threadId":"${threadId}","until":"2026-06-01T09:00:00Z"}`,
      },
    });
    expect(parseCliArgs(["mail", "read", "--thread-id", threadId, "--unread"])).toEqual({
      kind: "tool-call",
      toolId: "mail.read.set",
      json: { source: "inline", value: `{"threadId":"${threadId}","unread":true}` },
    });
    expect(parseCliArgs(["mail", "star", "--thread-id", threadId, "--starred"])).toEqual({
      kind: "tool-call",
      toolId: "mail.star.set",
      json: { source: "inline", value: `{"threadId":"${threadId}","starred":true}` },
    });
    expect(parseCliArgs(["mail", "star", "--thread-id", threadId, "--unstarred"])).toEqual({
      kind: "tool-call",
      toolId: "mail.star.set",
      json: { source: "inline", value: `{"threadId":"${threadId}","starred":false}` },
    });
    expect(parseCliArgs(["mail", "thread-get", "--thread-id", threadId])).toEqual({
      kind: "tool-call",
      toolId: "mail.thread.get",
      json: { source: "inline", value: `{"threadId":"${threadId}"}` },
    });
  });

  it("parses the mail filter subcommands as tool calls", () => {
    expect(
      parseCliArgs([
        "mail",
        "filter-create",
        "--name",
        "Newsletters",
        "--priority",
        "10",
        "--disabled",
        "--criteria",
        '{"fromContains":"news@"}',
        "--actions",
        '{"archive":true}',
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "mail.filter.create",
      json: {
        source: "inline",
        value:
          '{"name":"Newsletters","priority":10,"enabled":false,"criteria":{"fromContains":"news@"},"actions":{"archive":true}}',
      },
    });
    expect(
      parseCliArgs(["mail", "filter-update", "--id", filterId, "--name", "Renamed", "--enabled"]),
    ).toEqual({
      kind: "tool-call",
      toolId: "mail.filter.update",
      json: { source: "inline", value: `{"id":"${filterId}","name":"Renamed","enabled":true}` },
    });
    expect(parseCliArgs(["mail", "filter-delete", "--id", filterId])).toEqual({
      kind: "tool-call",
      toolId: "mail.filter.delete",
      json: { source: "inline", value: `{"id":"${filterId}"}` },
    });
    expect(parseCliArgs(["mail", "filter-create", "--json", '{"name":"X"}'])).toEqual({
      kind: "tool-call",
      toolId: "mail.filter.create",
      json: { source: "inline", value: '{"name":"X"}' },
    });
  });

  it("parses the mail vacation subcommands as tool calls", () => {
    expect(parseCliArgs(["mail", "vacation-get"])).toEqual({
      kind: "tool-call",
      toolId: "mail.vacation.get",
      json: { source: "empty" },
    });
    expect(
      parseCliArgs([
        "mail",
        "vacation-set",
        "--enabled",
        "--subject",
        "Away",
        "--body",
        "Back soon",
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "mail.vacation.set",
      json: { source: "inline", value: '{"enabled":true,"subject":"Away","body":"Back soon"}' },
    });
  });

  it("rejects unknown mail subcommands", () => {
    expect(() => parseCliArgs(["mail", "bogus"])).toThrow(CliUsageError);
  });

  it("parses the logout command", () => {
    expect(parseCliArgs(["logout"])).toEqual({ kind: "logout" });
    expect(() => parseCliArgs(["logout", "extra"])).toThrow(CliUsageError);
  });

  it("parses additional feature parity wrappers", () => {
    expect(parseCliArgs(["chat", "messages", "--room-id", "room-1", "--limit", "20"])).toEqual({
      kind: "tool-call",
      toolId: "chat.message.list",
      json: { source: "inline", value: '{"roomId":"room-1","limit":20}' },
    });
    expect(parseCliArgs(["docs", "get", "--doc-id", docId])).toEqual({
      kind: "tool-call",
      toolId: "docs.get",
      json: { source: "inline", value: `{"docId":"${docId}"}` },
    });
    expect(parseCliArgs(["docs", "list", "--query", "spec", "--limit", "5"])).toEqual({
      kind: "tool-call",
      toolId: "docs.list",
      json: { source: "inline", value: '{"query":"spec","limit":5}' },
    });
    expect(
      parseCliArgs(["calendar", "event-list", "--calendar-id", folderId, "--limit", "50"]),
    ).toEqual({
      kind: "tool-call",
      toolId: "calendar.event.list",
      json: { source: "inline", value: `{"calendarId":"${folderId}","limit":50}` },
    });
    expect(
      parseCliArgs([
        "assistant",
        "approve",
        "--conversation-id",
        threadId,
        "--pending-id",
        filterId,
        "--classification",
        "confidential",
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "assistant.confirmation.approve",
      json: {
        source: "inline",
        value: `{"conversationId":"${threadId}","pendingId":"${filterId}","classification":"confidential"}`,
      },
    });
    expect(() => parseCliArgs(["assistant", "approve", "--classification", "bogus"])).toThrow(
      CliUsageError,
    );
  });

  it("keeps the completion registry and parser in sync (no drift)", () => {
    // Scopes whose completion-registry entries are genuine flag-routed
    // subcommand names. search/restore/reindex list flags; webhook/admin use
    // families; action/tier route a positional arg (covered by other tests).
    const subcommandScopes = [
      "mail",
      "chat",
      "drive",
      "docs",
      "calendar",
      "meet",
      "assistant",
    ] as const;

    const messageFor = (args: readonly string[]): string | undefined => {
      try {
        parseCliArgs(args);
        return undefined;
      } catch (error) {
        return error instanceof CliUsageError ? error.message : "non-usage-error";
      }
    };

    for (const scope of subcommandScopes) {
      // The message produced by an unrecognized subcommand for this scope.
      const rejectionMessage = messageFor([scope, "__definitely_not_a_subcommand__"]);
      for (const action of commandActions[scope] ?? []) {
        const message = messageFor([scope, action]);
        // A recognized subcommand either parses or throws its own usage error;
        // it must never produce the scope-level "unknown subcommand" message.
        expect(message, `${scope} ${action} should be a recognized subcommand`).not.toBe(
          rejectionMessage,
        );
      }
    }
  });

  it("parses chat aliases as tool calls", () => {
    expect(parseCliArgs(["chat", "send", "--room-id", "room-1", "--body", "Hello"])).toEqual({
      kind: "tool-call",
      toolId: "chat.send",
      json: { source: "inline", value: '{"roomId":"room-1","body":"Hello"}' },
    });
    expect(parseCliArgs(["chat", "send", "--json", '{"roomId":"room-1"}'])).toEqual({
      kind: "tool-call",
      toolId: "chat.send",
      json: { source: "inline", value: '{"roomId":"room-1"}' },
    });
    expect(
      parseCliArgs([
        "chat",
        "create-room",
        "--name",
        "Launch",
        "--member",
        "user-1,user-2",
        "--private",
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "chat.create_room",
      json: {
        source: "inline",
        value: '{"subject":"Launch","memberActorIds":["user-1","user-2"],"isPrivate":true}',
      },
    });
    expect(parseCliArgs(["chat", "create-room", "--json"])).toEqual({
      kind: "tool-call",
      toolId: "chat.create_room",
      json: { source: "stdin" },
    });
    expect(parseCliArgs(["chat", "search", "--query", "roadmap", "--limit", "5"])).toEqual({
      kind: "tool-call",
      toolId: "chat.search",
      json: { source: "inline", value: '{"query":"roadmap","limit":5}' },
    });
    expect(parseCliArgs(["chat", "search", "--json"])).toEqual({
      kind: "tool-call",
      toolId: "chat.search",
      json: { source: "stdin" },
    });
  });

  it("parses drive aliases as tool calls", () => {
    expect(parseCliArgs(["drive", "upload", "./report.pdf", "--folder", folderId])).toEqual({
      kind: "tool-call",
      toolId: "drive.upload",
      json: {
        source: "inline",
        value: `{"name":"report.pdf","metadata":{"localPath":"./report.pdf"},"folderId":"${folderId}"}`,
      },
    });
    expect(
      parseCliArgs([
        "drive",
        "upload",
        "./brief.pdf",
        "--name",
        "brief.pdf",
        "--mime-type",
        "application/pdf",
        "--byte-size",
        "128",
        "--sha256",
        "a".repeat(64),
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "drive.upload",
      json: {
        source: "inline",
        value:
          '{"name":"brief.pdf","metadata":{"localPath":"./brief.pdf"},"mimeType":"application/pdf","byteSize":128,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
      },
    });
    expect(parseCliArgs(["drive", "upload", "--json", '{"name":"brief.pdf"}'])).toEqual({
      kind: "tool-call",
      toolId: "drive.upload",
      json: { source: "inline", value: '{"name":"brief.pdf"}' },
    });
    expect(
      parseCliArgs(["drive", "list", "--folder", folderId, "--limit", "25", "--include-trashed"]),
    ).toEqual({
      kind: "tool-call",
      toolId: "drive.list",
      json: {
        source: "inline",
        value: `{"folderId":"${folderId}","limit":25,"includeTrashed":true}`,
      },
    });
    expect(parseCliArgs(["drive", "search", "--query", "roadmap", "--limit", "10"])).toEqual({
      kind: "tool-call",
      toolId: "drive.search",
      json: { source: "inline", value: '{"query":"roadmap","limit":10}' },
    });
    expect(parseCliArgs(["drive", "search", "--json"])).toEqual({
      kind: "tool-call",
      toolId: "drive.search",
      json: { source: "stdin" },
    });
  });

  it("parses docs aliases as tool calls", () => {
    expect(parseCliArgs(["docs", "create", "--json", '{"title":"Launch notes"}'])).toEqual({
      kind: "tool-call",
      toolId: "docs.create",
      json: { source: "inline", value: '{"title":"Launch notes"}' },
    });
    expect(parseCliArgs(["docs", "update-title", "--json"])).toEqual({
      kind: "tool-call",
      toolId: "docs.update-title",
      json: { source: "stdin" },
    });
    expect(parseCliArgs(["docs", "export"])).toEqual({
      kind: "tool-call",
      toolId: "docs.export",
      json: { source: "empty" },
    });
    expect(parseCliArgs(["docs", "comment", "--json", '{"body":"Looks good"}'])).toEqual({
      kind: "tool-call",
      toolId: "docs.comment.create",
      json: { source: "inline", value: '{"body":"Looks good"}' },
    });
  });

  it("parses docs typed flags as tool calls", () => {
    expect(
      parseCliArgs([
        "docs",
        "create",
        "--title",
        "Launch notes",
        "--initial-markdown",
        "# Launch",
        "--folder",
        folderId,
        "--metadata",
        '{"template":"brief"}',
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "docs.create",
      json: {
        source: "inline",
        value:
          '{"title":"Launch notes","initialMarkdown":"# Launch","folderId":"44444444-4444-4444-8444-444444444444","metadata":{"template":"brief"}}',
      },
    });
    expect(parseCliArgs(["docs", "update-title", "--doc-id", docId, "--title", "Q2 plan"])).toEqual(
      {
        kind: "tool-call",
        toolId: "docs.update-title",
        json: {
          source: "inline",
          value: '{"docId":"55555555-5555-4555-8555-555555555555","title":"Q2 plan"}',
        },
      },
    );
    expect(
      parseCliArgs([
        "docs",
        "export",
        "--doc-id",
        docId,
        "--format",
        "pdf",
        "--include-comments",
        "--filename",
        "q2-plan.pdf",
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "docs.export",
      json: {
        source: "inline",
        value:
          '{"docId":"55555555-5555-4555-8555-555555555555","format":"pdf","includeComments":true,"filename":"q2-plan.pdf"}',
      },
    });
    expect(
      parseCliArgs([
        "docs",
        "comment-create",
        "--doc-id",
        docId,
        "--body",
        "Looks good",
        "--anchor",
        '{"path":[1,2]}',
        "--metadata",
        '{"severity":"low"}',
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "docs.comment.create",
      json: {
        source: "inline",
        value:
          '{"docId":"55555555-5555-4555-8555-555555555555","body":"Looks good","anchor":{"path":[1,2]},"metadata":{"severity":"low"}}',
      },
    });
  });

  it("rejects docs typed flags with invalid JSON object values", () => {
    expect(() => parseCliArgs(["docs", "create", "--metadata", "[]"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["docs", "comment-create", "--anchor", "nope"])).toThrow(
      CliUsageError,
    );
  });

  it("parses calendar aliases as tool calls", () => {
    expect(
      parseCliArgs([
        "calendar",
        "event-create",
        "--title",
        "Planning",
        "--start",
        "2026-06-01T09:00:00-04:00",
        "--end",
        "2026-06-01T09:30:00-04:00",
        "--attendee",
        "ada@example.com,grace@example.com",
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "calendar.event.create",
      json: {
        source: "inline",
        value:
          '{"title":"Planning","startsAt":"2026-06-01T09:00:00-04:00","endsAt":"2026-06-01T09:30:00-04:00","attendees":[{"email":"ada@example.com"},{"email":"grace@example.com"}]}',
      },
    });
    expect(parseCliArgs(["calendar", "event-create", "--json", '{"title":"Planning"}'])).toEqual({
      kind: "tool-call",
      toolId: "calendar.event.create",
      json: { source: "inline", value: '{"title":"Planning"}' },
    });
    expect(
      parseCliArgs(["calendar", "update", "--event-id", "event-1", "--title", "Plan"]),
    ).toEqual({
      kind: "tool-call",
      toolId: "calendar.event.update",
      json: { source: "inline", value: '{"eventId":"event-1","title":"Plan"}' },
    });
    expect(parseCliArgs(["calendar", "event-delete", "--event-id", "event-1"])).toEqual({
      kind: "tool-call",
      toolId: "calendar.event.delete",
      json: { source: "inline", value: '{"eventId":"event-1"}' },
    });
    expect(
      parseCliArgs(["calendar", "respond", "--event-id", "event-1", "--response", "accepted"]),
    ).toEqual({
      kind: "tool-call",
      toolId: "calendar.event.respond",
      json: { source: "inline", value: '{"eventId":"event-1","responseStatus":"accepted"}' },
    });
    expect(
      parseCliArgs([
        "calendar",
        "find-time",
        "--attendee",
        "ada@example.com",
        "--duration-minutes",
        "30",
        "--start",
        "2026-06-01T09:00:00-04:00",
        "--end",
        "2026-06-01T17:00:00-04:00",
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "calendar.find-time",
      json: {
        source: "inline",
        value:
          '{"attendeeEmails":["ada@example.com"],"durationMinutes":30,"windowStartsAt":"2026-06-01T09:00:00-04:00","windowEndsAt":"2026-06-01T17:00:00-04:00"}',
      },
    });
  });

  it("parses meet aliases as tool calls", () => {
    expect(parseCliArgs(["meet", "create-room", "--json", '{"subject":"Weekly"}'])).toEqual({
      kind: "tool-call",
      toolId: "meet.create-room",
      json: { source: "inline", value: '{"subject":"Weekly"}' },
    });
    expect(
      parseCliArgs([
        "meet",
        "create",
        "--subject",
        "Weekly sync",
        "--room-name",
        "weekly-sync",
        "--jitsi-domain",
        "meet.example.com",
        "--participant",
        "11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222",
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "meet.create-room",
      json: {
        source: "inline",
        value:
          '{"subject":"Weekly sync","roomName":"weekly-sync","jitsiDomain":"meet.example.com","participantActorIds":["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"]}',
      },
    });
    expect(parseCliArgs(["meet", "list", "--status", "active", "--limit", "10"])).toEqual({
      kind: "tool-call",
      toolId: "meet.room.list",
      json: { source: "inline", value: '{"status":"active","limit":10}' },
    });
    expect(parseCliArgs(["meet", "token", "--json"])).toEqual({
      kind: "tool-call",
      toolId: "meet.mint-token",
      json: { source: "stdin" },
    });
    expect(
      parseCliArgs([
        "meet",
        "mint-token",
        "--room-id",
        "33333333-3333-4333-8333-333333333333",
        "--expires-in-seconds",
        "900",
        "--moderator",
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "meet.mint-token",
      json: {
        source: "inline",
        value:
          '{"roomId":"33333333-3333-4333-8333-333333333333","expiresInSeconds":900,"moderator":true}',
      },
    });
    expect(
      parseCliArgs(["meet", "end", "--room-id", "33333333-3333-4333-8333-333333333333"]),
    ).toEqual({
      kind: "tool-call",
      toolId: "meet.end-room",
      json: {
        source: "inline",
        value: '{"roomId":"33333333-3333-4333-8333-333333333333"}',
      },
    });
  });

  it("parses assistant aliases as tool calls", () => {
    expect(parseCliArgs(["assistant", "chat", "--json", '{"message":"summarize"}'])).toEqual({
      kind: "tool-call",
      toolId: "assistant.chat",
      json: { source: "inline", value: '{"message":"summarize"}' },
    });
    expect(parseCliArgs(["assistant", "new"])).toEqual({
      kind: "tool-call",
      toolId: "assistant.conversation.create",
      json: { source: "empty" },
    });
    expect(parseCliArgs(["assistant", "forget", "--json"])).toEqual({
      kind: "tool-call",
      toolId: "assistant.memory.forget",
      json: { source: "stdin" },
    });
  });

  it("parses global search as a tool call", () => {
    expect(parseCliArgs(["search", "project zenith"])).toEqual({
      kind: "tool-call",
      toolId: "search.query",
      json: { source: "inline", value: '{"query":"project zenith"}' },
    });
    expect(
      parseCliArgs(["search", "--query", "project zenith", "--type", "mail,docs", "--limit", "5"]),
    ).toEqual({
      kind: "tool-call",
      toolId: "search.query",
      json: {
        source: "inline",
        value: '{"query":"project zenith","limit":5,"types":["mail","docs"]}',
      },
    });
    expect(parseCliArgs(["search", "--json", '{"query":"project zenith"}'])).toEqual({
      kind: "tool-call",
      toolId: "search.query",
      json: { source: "inline", value: '{"query":"project zenith"}' },
    });
  });

  it("parses admin agent credential aliases as tool calls", () => {
    expect(
      parseCliArgs([
        "admin",
        "agent-credentials",
        "create",
        "--actor-id",
        actorId,
        "--scope",
        "tools:read,mail.read",
        "--expires-at",
        "2026-06-01T00:00:00.000Z",
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "agent.credentials.create",
      json: {
        source: "inline",
        value: `{"actorId":"${actorId}","scopes":["tools:read","mail.read"],"expiresAt":"2026-06-01T00:00:00.000Z"}`,
      },
    });
    expect(parseCliArgs(["admin", "agent-credentials", "list", "--include-revoked"])).toEqual({
      kind: "tool-call",
      toolId: "agent.credentials.list",
      json: { source: "inline", value: '{"includeRevoked":true}' },
    });
    expect(
      parseCliArgs(["admin", "agent-credentials", "revoke", "--client-id", "client-1"]),
    ).toEqual({
      kind: "tool-call",
      toolId: "agent.credentials.revoke",
      json: { source: "inline", value: '{"clientId":"client-1"}' },
    });
    expect(parseCliArgs(["admin", "agent-credentials", "create", "--json"])).toEqual({
      kind: "tool-call",
      toolId: "agent.credentials.create",
      json: { source: "stdin" },
    });
  });

  it("parses admin app-password aliases as tool calls", () => {
    expect(
      parseCliArgs([
        "admin",
        "app-passwords",
        "create",
        "--actor-id",
        actorId,
        "--label",
        "Local dev",
        "--scope",
        "mail.read",
        "--scope",
        "docs.read,drive.read",
        "--expires-at",
        "2026-06-01T00:00:00.000Z",
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "app.passwords.create",
      json: {
        source: "inline",
        value: `{"actorId":"${actorId}","label":"Local dev","scopes":["mail.read","docs.read","drive.read"],"expiresAt":"2026-06-01T00:00:00.000Z"}`,
      },
    });
    expect(
      parseCliArgs(["admin", "app-passwords", "list", "--actor-id", actorId, "--include-revoked"]),
    ).toEqual({
      kind: "tool-call",
      toolId: "app.passwords.list",
      json: { source: "inline", value: `{"actorId":"${actorId}","includeRevoked":true}` },
    });
    expect(parseCliArgs(["admin", "app-passwords", "revoke", "--password-id", "apw-1"])).toEqual({
      kind: "tool-call",
      toolId: "app.passwords.revoke",
      json: { source: "inline", value: '{"passwordId":"apw-1"}' },
    });
    expect(parseCliArgs(["admin", "app-passwords", "create", "--json"])).toEqual({
      kind: "tool-call",
      toolId: "app.passwords.create",
      json: { source: "stdin" },
    });
  });

  it("parses direct admin users and audit list commands", () => {
    expect(
      parseCliArgs([
        "admin",
        "users",
        "list",
        "--query",
        "mina",
        "--type",
        "user",
        "--include-disabled",
        "--limit",
        "25",
        "--cursor",
        "cursor-1",
      ]),
    ).toEqual({
      kind: "admin-users-list",
      query: "mina",
      type: "user",
      includeDisabled: true,
      limit: 25,
      cursor: "cursor-1",
    });
    expect(
      parseCliArgs([
        "admin",
        "audit",
        "list",
        "--actor-id",
        actorId,
        "--object-id",
        webhookId,
        "--object-type",
        "webhook",
        "--verb",
        "webhook.created",
        "--limit",
        "10",
      ]),
    ).toEqual({
      kind: "admin-audit-list",
      actorId,
      objectId: webhookId,
      objectType: "webhook",
      verb: "webhook.created",
      limit: 10,
    });
  });

  it("parses tenant storage migration operator commands", () => {
    const targetStorage = {
      kind: "byo",
      provider: "aws-s3",
      bucket: "acme-helix-data",
      credentials_vault_path: "tenants/acme/byo-storage/aws",
    };
    const sourceStorage = {
      kind: "byo",
      provider: "aws-s3",
      bucket: "acme-helix-data",
      credentials_vault_path: "tenants/acme/byo-storage/aws",
    };

    expect(parseCliArgs(["admin", "storage", "test"])).toEqual({
      kind: "admin-storage-test",
    });
    expect(
      parseCliArgs([
        "admin",
        "storage-migrations",
        "list",
        "--target",
        "byo",
        "--status",
        "running",
        "--limit",
        "25",
        "--cursor",
        "cursor-1",
      ]),
    ).toEqual({
      kind: "admin-storage-migration-list",
      target: "byo",
      status: "running",
      limit: 25,
      cursor: "cursor-1",
    });
    expect(
      parseCliArgs([
        "admin",
        "storage-migrations",
        "request",
        "--target",
        "byo",
        "--target-storage",
        JSON.stringify(targetStorage),
      ]),
    ).toEqual({
      kind: "admin-storage-migration-request",
      target: "byo",
      dryRun: true,
      targetStorage,
    });
    expect(
      parseCliArgs([
        "admin",
        "storage-migrations",
        "request",
        "--target",
        "helix-default",
        "--live",
        "--confirm",
        "LIVE",
        "--source-storage",
        JSON.stringify(sourceStorage),
      ]),
    ).toEqual({
      kind: "admin-storage-migration-request",
      target: "helix-default",
      dryRun: false,
      sourceStorage,
    });
    expect(parseCliArgs(["admin", "storage-migrations", "get", migrationId])).toEqual({
      kind: "admin-storage-migration-get",
      migrationId,
    });
    expect(parseCliArgs(["admin", "storage-migrations", "status", migrationId])).toEqual({
      kind: "admin-storage-migration-get",
      migrationId,
    });
    expect(
      parseCliArgs(["admin", "storage-migrations", "cutover", migrationId, "--confirm", "CUTOVER"]),
    ).toEqual({
      kind: "admin-storage-migration-cutover",
      migrationId,
    });
  });

  it("rejects unsafe tenant storage migration operator commands", () => {
    expect(() => parseCliArgs(["admin", "storage", "test", "--json"])).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["admin", "storage-migrations", "request", "--target", "unknown"]),
    ).toThrow(CliUsageError);
    expect(() => parseCliArgs(["admin", "storage-migrations", "request"])).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["admin", "storage-migrations", "request", "--target", "byo", "--live"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs([
        "admin",
        "storage-migrations",
        "request",
        "--target",
        "byo",
        "--target-storage",
        "[]",
      ]),
    ).toThrow(CliUsageError);
    expect(() => parseCliArgs(["admin", "storage-migrations", "get"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["admin", "storage-migrations", "cutover", migrationId])).toThrow(
      CliUsageError,
    );
    expect(() =>
      parseCliArgs(["admin", "storage-migrations", "cutover", migrationId, "--confirm", "LIVE"]),
    ).toThrow(CliUsageError);
  });

  it("parses durable tenant export operator commands", () => {
    expect(
      parseCliArgs([
        "admin",
        "tenant-exports",
        "queue",
        "acme",
        "--metadata-only",
        "--presigned-url-expires-seconds",
        "600",
      ]),
    ).toEqual({
      kind: "tenant-export-queue",
      slug: "acme",
      includeObjectBytes: false,
      presignedUrlExpiresSeconds: 600,
    });
    expect(parseCliArgs(["admin", "tenant-exports", "queue", "acme"])).toEqual({
      kind: "tenant-export-queue",
      slug: "acme",
      includeObjectBytes: true,
    });
    expect(
      parseCliArgs([
        "admin",
        "tenant-exports",
        "list",
        "acme",
        "--status",
        "running",
        "--limit",
        "10",
        "--cursor",
        "cursor-1",
      ]),
    ).toEqual({
      kind: "tenant-export-list",
      slug: "acme",
      status: "running",
      limit: 10,
      cursor: "cursor-1",
    });
    expect(parseCliArgs(["admin", "tenant-exports", "status", "acme", exportJobId])).toEqual({
      kind: "tenant-export-status",
      slug: "acme",
      jobId: exportJobId,
    });
    expect(parseCliArgs(["admin", "tenant-exports", "get", "acme", exportJobId])).toEqual({
      kind: "tenant-export-status",
      slug: "acme",
      jobId: exportJobId,
    });
    expect(
      parseCliArgs([
        "admin",
        "tenant-exports",
        "download",
        "acme",
        exportJobId,
        "--output",
        "/tmp/acme-export.tar",
        "--force",
      ]),
    ).toEqual({
      kind: "tenant-export-download",
      slug: "acme",
      jobId: exportJobId,
      output: "/tmp/acme-export.tar",
      force: true,
    });
  });

  it("parses tenant import dry-run operator commands", () => {
    expect(parseCliArgs(["admin", "tenant-imports", "dry-run", "acme", "./acme.tar"])).toEqual({
      kind: "tenant-import-dry-run",
      slug: "acme",
      archive: "./acme.tar",
    });
    expect(
      parseCliArgs([
        "admin",
        "tenant-imports",
        "dry-run",
        "acme",
        "./acme.tar",
        "--row-id-conflicts",
        "preserve",
        "--principal-references",
        "null",
        "--resource-references",
        "preserve",
        "--verified-state",
        "preserve",
        "--primary-domain",
        "null",
      ]),
    ).toEqual({
      kind: "tenant-import-dry-run",
      slug: "acme",
      archive: "./acme.tar",
      conflictPolicy: {
        rowIdConflicts: "preserve",
        principalReferences: "null",
        resourceReferences: "preserve",
        verifiedState: "preserve",
        primaryDomain: "null",
      },
    });
  });

  it("rejects unsafe tenant import dry-run operator commands", () => {
    expect(() => parseCliArgs(["admin", "tenant-imports"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["admin", "tenant-imports", "dry-run"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["admin", "tenant-imports", "dry-run", "acme"])).toThrow(
      CliUsageError,
    );
    expect(() =>
      parseCliArgs(["admin", "tenant-imports", "dry-run", "acme", "./acme.tar", "--live"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs([
        "admin",
        "tenant-imports",
        "dry-run",
        "acme",
        "./acme.tar",
        "--principal-references",
      ]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs([
        "admin",
        "tenant-imports",
        "dry-run",
        "acme",
        "./acme.tar",
        "--principal-references",
        "delete",
      ]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs([
        "admin",
        "tenant-imports",
        "dry-run",
        "acme",
        "./acme.tar",
        "--verified-state",
        "preserve",
        "--verified-state",
        "regenerate",
      ]),
    ).toThrow(CliUsageError);
  });

  it("rejects unsafe durable tenant export operator commands", () => {
    expect(() => parseCliArgs(["admin", "tenant-exports", "queue"])).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["admin", "tenant-exports", "queue", "acme", "--presigned-url-expires-seconds"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["admin", "tenant-exports", "list", "acme", "--status", "dry_run"]),
    ).toThrow(CliUsageError);
    expect(() => parseCliArgs(["admin", "tenant-exports", "status", "acme"])).toThrow(
      CliUsageError,
    );
    expect(() =>
      parseCliArgs(["admin", "tenant-exports", "download", "acme", exportJobId]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["admin", "tenant-exports", "download", "acme", exportJobId, "--output"]),
    ).toThrow(CliUsageError);
  });

  it("parses backup and restore operator commands", () => {
    expect(parseCliArgs(["backup", "create"])).toEqual({ kind: "backup-create" });
    expect(parseCliArgs(["restore", "--from", "backup-20260520T120000Z"])).toEqual({
      kind: "restore-from",
      backupId: "backup-20260520T120000Z",
    });
    expect(parseCliArgs(["restore", "--from", "backup-20260520T120000Z", "--encrypted"])).toEqual({
      kind: "restore-from",
      backupId: "backup-20260520T120000Z",
      encrypted: true,
    });
    expect(() => parseCliArgs(["backup", "create", "--execute"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["restore", "backup-20260520T120000Z"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["restore", "--from"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["restore", "--encrypted"])).toThrow(CliUsageError);
  });

  it("parses full search reindex operator commands", () => {
    expect(parseCliArgs(["reindex", "--all"])).toEqual({ kind: "reindex-all" });
    expect(() => parseCliArgs(["reindex"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["reindex", "all"])).toThrow(CliUsageError);
  });

  it("parses action status and mutation commands", () => {
    expect(parseCliArgs(["action", "status", "action-1"])).toEqual({
      kind: "action-status",
      actionId: "action-1",
    });
    expect(parseCliArgs(["action", "approve", "action-1"])).toEqual({
      kind: "action-approve",
      actionId: "action-1",
    });
    expect(parseCliArgs(["action", "cancel", "action-1"])).toEqual({
      kind: "action-cancel",
      actionId: "action-1",
    });
    expect(() => parseCliArgs(["action", "status"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["action", "status", "action-1", "--json"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["action", "approve"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["action", "cancel", "action-1", "--json"])).toThrow(CliUsageError);
  });

  it("parses tier set as a platform config update", () => {
    expect(parseCliArgs(["tier", "set", "business"])).toEqual({
      kind: "tier-set",
      tier: "business",
    });
    expect(parseCliArgs(["tier", "set", "sovereign"])).toEqual({
      kind: "tier-set",
      tier: "sovereign",
    });
    expect(() => parseCliArgs(["tier", "set", "unsupported"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["tier", "set", "business", "--force"])).toThrow(CliUsageError);
  });

  it("parses webhook outbound aliases as tool calls", () => {
    expect(
      parseCliArgs([
        "webhook",
        "outbound",
        "create",
        "--name",
        "Build events",
        "--url",
        "https://hooks.example/build",
        "--event-subject",
        "build.started,build.finished",
        "--secret-ref",
        "secret/webhooks/build",
        "--header",
        "X-Helix=cli",
        "--metadata",
        '{"team":"platform"}',
        "--disabled",
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "webhook.outbound.create",
      json: {
        source: "inline",
        value:
          '{"name":"Build events","url":"https://hooks.example/build","eventSubjects":["build.started","build.finished"],"secretRef":"secret/webhooks/build","headers":{"X-Helix":"cli"},"metadata":{"team":"platform"},"enabled":false}',
      },
    });
    expect(parseCliArgs(["webhook", "outbound", "update", "--id", webhookId, "--enabled"])).toEqual(
      {
        kind: "tool-call",
        toolId: "webhook.outbound.update",
        json: {
          source: "inline",
          value: `{"id":"${webhookId}","enabled":true}`,
        },
      },
    );
    expect(
      parseCliArgs(["webhook", "outbound", "test", "--id", webhookId, "--payload", '{"ok":true}']),
    ).toEqual({
      kind: "tool-call",
      toolId: "webhook.outbound.test",
      json: {
        source: "inline",
        value: `{"id":"${webhookId}","payload":{"ok":true}}`,
      },
    });
    expect(parseCliArgs(["webhook", "outbound", "replay", "--delivery-id", deliveryId])).toEqual({
      kind: "tool-call",
      toolId: "webhook.outbound.replay",
      json: {
        source: "inline",
        value: `{"deliveryId":"${deliveryId}"}`,
      },
    });
    expect(parseCliArgs(["webhook", "outbound", "list", "--json"])).toEqual({
      kind: "tool-call",
      toolId: "webhook.outbound.list",
      json: { source: "stdin" },
    });
  });

  it("parses webhook inbound and delivery aliases as tool calls", () => {
    expect(
      parseCliArgs([
        "webhook",
        "inbound",
        "create",
        "--name",
        "GitHub",
        "--slug",
        "github",
        "--source",
        "github",
        "--secret-ref",
        "secret/inbound/github",
        "--metadata",
        '{"repo":"example/repo"}',
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "webhook.inbound.create",
      json: {
        source: "inline",
        value:
          '{"name":"GitHub","slug":"github","source":"github","secretRef":"secret/inbound/github","metadata":{"repo":"example/repo"}}',
      },
    });
    expect(parseCliArgs(["webhook", "inbound", "rotate-secret", "--id", webhookId])).toEqual({
      kind: "tool-call",
      toolId: "webhook.inbound.rotate-secret",
      json: {
        source: "inline",
        value: `{"id":"${webhookId}"}`,
      },
    });
    expect(
      parseCliArgs([
        "webhook",
        "delivery",
        "list",
        "--direction",
        "outbound",
        "--status",
        "failed",
        "--limit",
        "25",
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "webhook.delivery.list",
      json: {
        source: "inline",
        value: '{"direction":"outbound","status":"failed","limit":25}',
      },
    });
    expect(
      parseCliArgs(["webhook", "delivery", "get", "--json", `{"id":"${deliveryId}"}`]),
    ).toEqual({
      kind: "tool-call",
      toolId: "webhook.delivery.get",
      json: { source: "inline", value: `{"id":"${deliveryId}"}` },
    });
  });

  it("rejects invalid webhook typed flag values", () => {
    expect(() => parseCliArgs(["webhook", "outbound", "create", "--metadata", "[]"])).toThrow(
      CliUsageError,
    );
    expect(() => parseCliArgs(["webhook", "outbound", "test", "--payload", "nope"])).toThrow(
      CliUsageError,
    );
    expect(() => parseCliArgs(["webhook", "delivery", "list", "--direction", "sideways"])).toThrow(
      CliUsageError,
    );
  });

  it("parses auth token and install commands", () => {
    expect(
      parseCliArgs([
        "login",
        "--client-id",
        "agent-1",
        "--client-secret",
        "secret",
        "--scope",
        "tools:read",
      ]),
    ).toEqual({
      kind: "auth-token",
      clientId: "agent-1",
      clientSecret: "secret",
      scope: "tools:read",
      printExport: true,
    });
    expect(
      parseCliArgs([
        "auth",
        "token",
        "--client-id",
        "agent-1",
        "--client-secret",
        "secret",
        "--scope",
        "tools:read",
      ]),
    ).toEqual({
      kind: "auth-token",
      clientId: "agent-1",
      clientSecret: "secret",
      scope: "tools:read",
    });
    expect(parseCliArgs(["install", "list"])).toEqual({ kind: "install-list" });
    expect(
      parseCliArgs(["install", "plugin", "com.helix.core.mail", "--json", '{"enabled":true}']),
    ).toEqual({
      kind: "install-plugin",
      pluginId: "com.helix.core.mail",
      json: { source: "inline", value: '{"enabled":true}' },
    });
    expect(parseCliArgs(["plugin", "install", "com.helix.core.mail@1.2.3"])).toEqual({
      kind: "install-plugin",
      pluginId: "com.helix.core.mail",
      version: "1.2.3",
      json: { source: "empty" },
    });
    expect(parseCliArgs(["plugin", "enable", "com.helix.core.mail"])).toEqual({
      kind: "plugin-lifecycle",
      action: "enable",
      pluginId: "com.helix.core.mail",
      json: { source: "empty" },
    });
    expect(parseCliArgs(["install", "enable", "com.helix.core.mail"])).toEqual({
      kind: "plugin-lifecycle",
      action: "enable",
      pluginId: "com.helix.core.mail",
      json: { source: "empty" },
    });
    expect(
      parseCliArgs([
        "plugin",
        "disable",
        "com.helix.core.mail",
        "--json",
        '{"reason":"maintenance"}',
      ]),
    ).toEqual({
      kind: "plugin-lifecycle",
      action: "disable",
      pluginId: "com.helix.core.mail",
      json: { source: "inline", value: '{"reason":"maintenance"}' },
    });
    expect(parseCliArgs(["install", "uninstall", "com.helix.core.mail", "--json"])).toEqual({
      kind: "plugin-lifecycle",
      action: "uninstall",
      pluginId: "com.helix.core.mail",
      json: { source: "stdin" },
    });
    expect(() => parseCliArgs(["plugin", "enable"])).toThrow(CliUsageError);
  });

  it("parses MCP commands", () => {
    expect(parseCliArgs(["mcp", "serve"])).toEqual({ kind: "mcp-serve" });
    expect(parseCliArgs(["mcp", "resources", "list"])).toEqual({ kind: "mcp-resource-list" });
    expect(parseCliArgs(["mcp", "resources", "read", "helix://chat/room/room-1"])).toEqual({
      kind: "mcp-resource-read",
      uri: "helix://chat/room/room-1",
    });
    expect(() => parseCliArgs(["mcp", "resources", "read"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["mcp", "resources", "delete", "helix://chat/room/room-1"])).toThrow(
      CliUsageError,
    );
  });

  it("parses completion generation", () => {
    expect(parseCliArgs(["completion", "bash"])).toEqual({ kind: "completion", shell: "bash" });
    expect(parseCliArgs(["completion", "zsh"])).toEqual({ kind: "completion", shell: "zsh" });
    expect(parseCliArgs(["completion", "fish"])).toEqual({ kind: "completion", shell: "fish" });
  });

  it("parses OpenAPI and AsyncAPI document fetches", () => {
    expect(parseCliArgs(["openapi", "get"])).toEqual({ kind: "openapi-get" });
    expect(parseCliArgs(["asyncapi", "get"])).toEqual({ kind: "asyncapi-get" });
  });

  it("rejects unknown commands", () => {
    expect(() => parseCliArgs(["tool", "missing"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["completion", "powershell"])).toThrow(CliUsageError);
  });
});
