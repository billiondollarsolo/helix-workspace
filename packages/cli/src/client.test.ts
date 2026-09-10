import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHelixRequest,
  buildMcpRequest,
  buildMcpResourceListRequest,
  buildMcpResourceReadRequest,
  buildMcpToolCallRequest,
  buildMcpToolListRequest,
  credentialFilePath,
} from "./client.js";

describe("buildHelixRequest", () => {
  it("builds an authenticated tool list request", () => {
    expect(
      buildHelixRequest(
        { kind: "tool-list" },
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
      ),
    ).toEqual({
      url: "https://helix.example/v1/api/tools",
      init: {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: "Bearer token-1",
        },
      },
    });
  });

  it("builds a tool call request with encoded id and JSON body", () => {
    expect(
      buildHelixRequest(
        {
          kind: "tool-call",
          toolId: "platform/ping",
          json: { source: "empty" },
        },
        { HELIX_BASE_URL: "http://localhost:3000/base/" },
        { ok: true },
      ),
    ).toEqual({
      url: "http://localhost:3000/v1/api/tools/platform%2Fping",
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: '{"ok":true}',
      },
    });
  });

  it("builds mail wrapper calls through the REST tool transport", () => {
    expect(
      buildHelixRequest(
        {
          kind: "tool-call",
          toolId: "mail.list",
          json: { source: "inline", value: '{"mailbox":"inbox"}' },
        },
        { HELIX_BASE_URL: "https://helix.example" },
        { mailbox: "inbox" },
      ),
    ).toMatchObject({
      url: "https://helix.example/v1/api/tools/mail.list",
      init: {
        method: "POST",
        body: '{"mailbox":"inbox"}',
      },
    });
  });

  it("builds drive wrapper calls through the REST tool transport", () => {
    expect(
      buildHelixRequest(
        {
          kind: "tool-call",
          toolId: "drive.list",
          json: { source: "inline", value: '{"limit":25}' },
        },
        { HELIX_BASE_URL: "https://helix.example" },
        { limit: 25 },
      ),
    ).toMatchObject({
      url: "https://helix.example/v1/api/tools/drive.list",
      init: {
        method: "POST",
        body: '{"limit":25}',
      },
    });
  });

  it("builds chat wrapper calls through the REST tool transport", () => {
    expect(
      buildHelixRequest(
        {
          kind: "tool-call",
          toolId: "chat.send",
          json: { source: "inline", value: '{"roomId":"room-1","body":"Hello"}' },
        },
        { HELIX_BASE_URL: "https://helix.example" },
        { roomId: "room-1", body: "Hello" },
      ),
    ).toMatchObject({
      url: "https://helix.example/v1/api/tools/chat.send",
      init: {
        method: "POST",
        body: '{"roomId":"room-1","body":"Hello"}',
      },
    });
  });

  it("builds calendar wrapper calls through the REST tool transport", () => {
    expect(
      buildHelixRequest(
        {
          kind: "tool-call",
          toolId: "calendar.find-time",
          json: { source: "inline", value: '{"durationMinutes":30}' },
        },
        { HELIX_BASE_URL: "https://helix.example" },
        { durationMinutes: 30 },
      ),
    ).toMatchObject({
      url: "https://helix.example/v1/api/tools/calendar.find-time",
      init: {
        method: "POST",
        body: '{"durationMinutes":30}',
      },
    });
  });

  it("builds webhook wrapper calls through the REST tool transport", () => {
    expect(
      buildHelixRequest(
        {
          kind: "tool-call",
          toolId: "webhook.outbound.create",
          json: {
            source: "inline",
            value:
              '{"name":"Build events","url":"https://hooks.example/build","eventSubjects":["build.finished"]}',
          },
        },
        { HELIX_BASE_URL: "https://helix.example" },
        {
          name: "Build events",
          url: "https://hooks.example/build",
          eventSubjects: ["build.finished"],
        },
      ),
    ).toMatchObject({
      url: "https://helix.example/v1/api/tools/webhook.outbound.create",
      init: {
        method: "POST",
        body: '{"name":"Build events","url":"https://hooks.example/build","eventSubjects":["build.finished"]}',
      },
    });
  });

  it("builds an OpenAPI request", () => {
    expect(
      buildHelixRequest({ kind: "openapi-get" }, { HELIX_BASE_URL: "http://localhost:3000" }),
    ).toMatchObject({
      url: "http://localhost:3000/v1/openapi.json",
      init: { method: "GET" },
    });
  });

  it("builds an AsyncAPI request", () => {
    expect(
      buildHelixRequest({ kind: "asyncapi-get" }, { HELIX_BASE_URL: "http://localhost:3000" }),
    ).toMatchObject({
      url: "http://localhost:3000/v1/asyncapi.json",
      init: { method: "GET" },
    });
  });

  it("builds OAuth token requests", () => {
    expect(
      buildHelixRequest(
        {
          kind: "auth-token",
          clientId: "agent-1",
          clientSecret: "secret",
          scope: "tools:read admin.webhooks",
        },
        { HELIX_BASE_URL: "https://helix.example" },
      ),
    ).toEqual({
      url: "https://helix.example/v1/oauth/token",
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials&client_id=agent-1&client_secret=secret&scope=tools%3Aread+admin.webhooks",
      },
    });
  });

  it("builds direct admin users and audit list requests", () => {
    expect(
      buildHelixRequest(
        {
          kind: "admin-users-list",
          query: "Mina",
          type: "user",
          includeDisabled: true,
          limit: 25,
          cursor: "cursor-1",
        },
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
      ),
    ).toEqual({
      url: "https://helix.example/v1/api/admin/users?query=Mina&type=user&includeDisabled=true&limit=25&cursor=cursor-1",
      init: {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: "Bearer token-1",
        },
      },
    });

    expect(
      buildHelixRequest(
        {
          kind: "admin-audit-list",
          actorId: "88888888-8888-4888-8888-888888888888",
          objectId: "66666666-6666-4666-8666-666666666666",
          objectType: "webhook",
          verb: "webhook.created",
          limit: 10,
        },
        { HELIX_BASE_URL: "https://helix.example" },
      ),
    ).toMatchObject({
      url: "https://helix.example/v1/api/admin/audit-log?actorId=88888888-8888-4888-8888-888888888888&objectId=66666666-6666-4666-8666-666666666666&objectType=webhook&verb=webhook.created&limit=10",
      init: {
        method: "GET",
      },
    });
  });

  it("builds tier update requests against admin platform config", () => {
    expect(
      buildHelixRequest(
        { kind: "tier-set", tier: "enterprise" },
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
      ),
    ).toEqual({
      url: "https://helix.example/v1/api/admin/platform-config",
      init: {
        method: "PATCH",
        headers: {
          accept: "application/json",
          authorization: "Bearer token-1",
          "content-type": "application/json",
        },
        body: '{"security":{"tier":"enterprise"}}',
      },
    });
  });

  it("builds backup and restore operator requests", () => {
    expect(
      buildHelixRequest(
        { kind: "backup-create" },
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
      ),
    ).toEqual({
      url: "https://helix.example/v1/api/admin/backups",
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer token-1",
          "content-type": "application/json",
        },
        body: "{}",
      },
    });

    expect(
      buildHelixRequest(
        {
          kind: "restore-from",
          backupId: "backup-20260520T120000Z",
          targetDatabase: "helix_restore_incident_42",
          targetObjectBucket: "helix-restore-incident-42",
          idempotencyKey: "incident-42",
          encrypted: true,
        },
        { HELIX_BASE_URL: "https://helix.example" },
      ),
    ).toEqual({
      url: "https://helix.example/v1/api/admin/restores",
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: '{"backupId":"backup-20260520T120000Z","targetDatabase":"helix_restore_incident_42","targetObjectBucket":"helix-restore-incident-42","idempotencyKey":"incident-42","encrypted":true}',
      },
    });

    expect(
      buildHelixRequest(
        { kind: "reindex-all" },
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
      ),
    ).toEqual({
      url: "https://helix.example/v1/api/admin/search/reindex",
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer token-1",
          "content-type": "application/json",
        },
        body: '{"all":true}',
      },
    });
  });

  it("builds an action status polling request", () => {
    expect(
      buildHelixRequest(
        { kind: "action-status", actionId: "action/1" },
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
      ),
    ).toEqual({
      url: "https://helix.example/v1/actions/action%2F1",
      init: {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: "Bearer token-1",
        },
      },
    });

    expect(
      buildHelixRequest(
        { kind: "action-approve", actionId: "action/1" },
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
      ),
    ).toEqual({
      url: "https://helix.example/v1/api/tools/pending/action%2F1/approve",
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer token-1",
          "content-type": "application/json",
        },
        body: "{}",
      },
    });

    expect(
      buildHelixRequest(
        { kind: "action-cancel", actionId: "action/1" },
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
      ),
    ).toEqual({
      url: "https://helix.example/v1/api/tools/pending/action%2F1/cancel",
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer token-1",
          "content-type": "application/json",
        },
        body: "{}",
      },
    });
  });

  it("builds an authenticated MCP JSON-RPC request", () => {
    expect(
      buildMcpRequest(
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      ),
    ).toEqual({
      url: "https://helix.example/v1/mcp",
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer token-1",
          "content-type": "application/json",
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      },
    });
  });

  it("builds MCP tool list and call requests", () => {
    expect(
      buildMcpToolListRequest({
        HELIX_BASE_URL: "https://helix.example",
        HELIX_ACCESS_TOKEN: "token-1",
      }),
    ).toMatchObject({
      url: "https://helix.example/v1/mcp",
      init: {
        method: "POST",
        body: '{"jsonrpc":"2.0","id":"helix-tool-list","method":"tools/list"}',
      },
    });

    expect(
      buildMcpToolCallRequest({ HELIX_BASE_URL: "https://helix.example" }, "platform.ping", {
        ok: true,
      }),
    ).toMatchObject({
      url: "https://helix.example/v1/mcp",
      init: {
        method: "POST",
        body: '{"jsonrpc":"2.0","id":"helix-tool-call","method":"tools/call","params":{"name":"platform.ping","arguments":{"ok":true}}}',
      },
    });
  });

  it("builds MCP resource list and read requests", () => {
    expect(
      buildMcpResourceListRequest({
        HELIX_BASE_URL: "https://helix.example",
        HELIX_ACCESS_TOKEN: "token-1",
      }),
    ).toMatchObject({
      url: "https://helix.example/v1/mcp",
      init: {
        method: "POST",
        body: '{"jsonrpc":"2.0","id":"helix-resource-list","method":"resources/list"}',
      },
    });

    expect(
      buildMcpResourceReadRequest(
        { HELIX_BASE_URL: "https://helix.example" },
        "helix://chat/room/room-1",
      ),
    ).toMatchObject({
      url: "https://helix.example/v1/mcp",
      init: {
        method: "POST",
        body: '{"jsonrpc":"2.0","id":"helix-resource-read","method":"resources/read","params":{"uri":"helix://chat/room/room-1"}}',
      },
    });
  });

  it("adds W3C trace context from HELIX_TRACE_TOKEN to REST, form, and MCP requests", () => {
    const env = {
      HELIX_BASE_URL: "https://helix.example",
      HELIX_TRACE_TOKEN: "test-trace-token",
    };
    const expectedTraceId = "04b872a8a363a5da141eee8db65984f3";
    const traceparentPattern = new RegExp(`^00-${expectedTraceId}-[0-9a-f]{16}-01$`);

    const rest = buildHelixRequest({ kind: "tool-list" }, env);
    const form = buildHelixRequest(
      {
        kind: "auth-token",
        clientId: "agent-1",
        clientSecret: "secret",
      },
      env,
    );
    const mcp = buildMcpRequest(env, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');

    expect(rest.init.headers.traceparent).toMatch(traceparentPattern);
    expect(form.init.headers.traceparent).toMatch(traceparentPattern);
    expect(mcp.init.headers.traceparent).toMatch(traceparentPattern);
    expect(
      new Set([
        rest.init.headers.traceparent,
        form.init.headers.traceparent,
        mcp.init.headers.traceparent,
      ]).size,
    ).toBe(3);
  });

  it("requires HELIX_BASE_URL", () => {
    expect(() => buildHelixRequest({ kind: "tool-list" }, {})).toThrow(
      "HELIX_BASE_URL is required",
    );
  });

  it("throws for the logout command which has no HTTP request", () => {
    expect(() => buildHelixRequest({ kind: "logout" }, {})).toThrow(
      "Command does not map to an HTTP request: logout",
    );
  });
});

describe("credentialFilePath", () => {
  it("honors an explicit HELIX_CREDENTIALS_FILE override", () => {
    expect(credentialFilePath({ HELIX_CREDENTIALS_FILE: "/tmp/custom-creds.json" })).toBe(
      "/tmp/custom-creds.json",
    );
  });

  it("uses XDG_CONFIG_HOME when set", () => {
    expect(credentialFilePath({ XDG_CONFIG_HOME: "/tmp/xdg" })).toBe(
      join("/tmp/xdg", "helix", "credentials.json"),
    );
  });

  it("falls back to HOME/.config when XDG is unset", () => {
    expect(credentialFilePath({ HOME: "/home/agent" })).toBe(
      join("/home/agent", ".config", "helix", "credentials.json"),
    );
  });
});

it("uses an explicit agent API key and rejects credential-bearing base URLs", () => {
  const request = buildHelixRequest(
    { kind: "tool-list" },
    {
      HELIX_BASE_URL: "https://helix.example",
      HELIX_API_KEY: "agent-key",
      HELIX_ACCESS_TOKEN: "user-token",
    },
  );
  expect(request.init.headers.authorization).toBe("Bearer agent-key");
  for (const HELIX_BASE_URL of ["ftp://helix.example", "https://user:secret@helix.example"]) {
    expect(() => buildHelixRequest({ kind: "tool-list" }, { HELIX_BASE_URL })).toThrow("HTTP(S)");
  }
});
