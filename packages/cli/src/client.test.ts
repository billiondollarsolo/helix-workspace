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
      url: "https://helix.example/api/tools",
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
      url: "http://localhost:3000/api/tools/platform%2Fping",
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
      url: "https://helix.example/api/tools/mail.list",
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
      url: "https://helix.example/api/tools/drive.list",
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
      url: "https://helix.example/api/tools/chat.send",
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
      url: "https://helix.example/api/tools/calendar.find-time",
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
      url: "https://helix.example/api/tools/webhook.outbound.create",
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
      url: "http://localhost:3000/openapi.json",
      init: { method: "GET" },
    });
  });

  it("builds an AsyncAPI request", () => {
    expect(
      buildHelixRequest({ kind: "asyncapi-get" }, { HELIX_BASE_URL: "http://localhost:3000" }),
    ).toMatchObject({
      url: "http://localhost:3000/asyncapi.json",
      init: { method: "GET" },
    });
  });

  it("builds OAuth token and install tool requests", () => {
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
      url: "https://helix.example/oauth/token",
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials&client_id=agent-1&client_secret=secret&scope=tools%3Aread+admin.webhooks",
      },
    });

    expect(
      buildHelixRequest(
        { kind: "install-plugin", pluginId: "com.helix.core.mail", json: { source: "empty" } },
        { HELIX_BASE_URL: "https://helix.example" },
        { version: "1.0.0" },
      ),
    ).toMatchObject({
      url: "https://helix.example/api/tools/plugin.install",
      init: {
        method: "POST",
        body: '{"version":"1.0.0","pluginId":"com.helix.core.mail"}',
      },
    });

    expect(
      buildHelixRequest(
        {
          kind: "install-plugin",
          pluginId: "com.helix.core.mail",
          version: "1.2.3",
          json: { source: "empty" },
        },
        { HELIX_BASE_URL: "https://helix.example" },
      ),
    ).toMatchObject({
      url: "https://helix.example/api/tools/plugin.install",
      init: {
        method: "POST",
        body: '{"pluginId":"com.helix.core.mail","version":"1.2.3"}',
      },
    });

    expect(
      buildHelixRequest(
        {
          kind: "plugin-lifecycle",
          action: "disable",
          pluginId: "com.helix.core.mail",
          json: { source: "empty" },
        },
        { HELIX_BASE_URL: "https://helix.example" },
        { reason: "maintenance" },
      ),
    ).toMatchObject({
      url: "https://helix.example/api/tools/plugin.disable",
      init: {
        method: "POST",
        body: '{"reason":"maintenance","pluginId":"com.helix.core.mail"}',
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
      url: "https://helix.example/api/admin/users?query=Mina&type=user&includeDisabled=true&limit=25&cursor=cursor-1",
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
      url: "https://helix.example/api/admin/audit-log?actorId=88888888-8888-4888-8888-888888888888&objectId=66666666-6666-4666-8666-666666666666&objectType=webhook&verb=webhook.created&limit=10",
      init: {
        method: "GET",
      },
    });
  });

  it("builds tenant storage migration operator requests", () => {
    const migrationId = "99999999-9999-4999-8999-999999999999";
    const targetStorage = {
      kind: "byo",
      provider: "aws-s3",
      bucket: "acme-helix-data",
      credentials_vault_path: "tenants/acme/byo-storage/aws",
    };

    expect(
      buildHelixRequest(
        { kind: "admin-storage-test" },
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
      ),
    ).toEqual({
      url: "https://helix.example/api/admin/tenant-config/byo-storage/test",
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
          kind: "admin-storage-migration-list",
          target: "byo",
          status: "running",
          limit: 25,
          cursor: "cursor-1",
        },
        { HELIX_BASE_URL: "https://helix.example" },
      ),
    ).toMatchObject({
      url: "https://helix.example/api/admin/tenant-config/byo-storage/migrations?target=byo&status=running&limit=25&cursor=cursor-1",
      init: { method: "GET" },
    });

    expect(
      buildHelixRequest(
        {
          kind: "admin-storage-migration-request",
          target: "byo",
          dryRun: true,
          targetStorage,
        },
        { HELIX_BASE_URL: "https://helix.example" },
      ),
    ).toMatchObject({
      url: "https://helix.example/api/admin/tenant-config/byo-storage/migrations",
      init: {
        method: "POST",
        body: JSON.stringify({ target: "byo", dryRun: true, targetStorage }),
      },
    });

    expect(
      buildHelixRequest(
        { kind: "admin-storage-migration-get", migrationId },
        { HELIX_BASE_URL: "https://helix.example" },
      ),
    ).toMatchObject({
      url: `https://helix.example/api/admin/tenant-config/byo-storage/migrations/${migrationId}`,
      init: { method: "GET" },
    });

    expect(
      buildHelixRequest(
        { kind: "admin-storage-migration-cutover", migrationId },
        { HELIX_BASE_URL: "https://helix.example" },
      ),
    ).toMatchObject({
      url: `https://helix.example/api/admin/tenant-config/byo-storage/migrations/${migrationId}/cutover`,
      init: {
        method: "POST",
        body: '{"confirm":"CUTOVER"}',
      },
    });
  });

  it("builds durable tenant export operator requests", () => {
    const exportJobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    expect(
      buildHelixRequest(
        {
          kind: "tenant-export-queue",
          slug: "acme",
          includeObjectBytes: false,
          presignedUrlExpiresSeconds: 600,
        },
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
      ),
    ).toEqual({
      url: "https://helix.example/api/admin/tenants/acme/export/jobs",
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer token-1",
          "content-type": "application/json",
        },
        body: '{"includeObjectBytes":false,"presignedUrlExpiresSeconds":600}',
      },
    });

    expect(
      buildHelixRequest(
        {
          kind: "tenant-export-list",
          slug: "acme",
          status: "failed",
          limit: 10,
          cursor: "cursor-1",
        },
        { HELIX_BASE_URL: "https://helix.example" },
      ),
    ).toMatchObject({
      url: "https://helix.example/api/admin/tenants/acme/export/jobs?status=failed&limit=10&cursor=cursor-1",
      init: { method: "GET" },
    });

    expect(
      buildHelixRequest(
        { kind: "tenant-export-status", slug: "acme", jobId: exportJobId },
        { HELIX_BASE_URL: "https://helix.example" },
      ),
    ).toMatchObject({
      url: `https://helix.example/api/admin/tenants/acme/export/jobs/${exportJobId}`,
      init: { method: "GET" },
    });
  });

  it("builds tier update requests against admin platform config", () => {
    expect(
      buildHelixRequest(
        { kind: "tier-set", tier: "enterprise" },
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
      ),
    ).toEqual({
      url: "https://helix.example/api/admin/platform-config",
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
      url: "https://helix.example/api/admin/backups",
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
        { kind: "restore-from", backupId: "backup-20260520T120000Z", encrypted: true },
        { HELIX_BASE_URL: "https://helix.example" },
      ),
    ).toEqual({
      url: "https://helix.example/api/admin/restores",
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: '{"backupId":"backup-20260520T120000Z","encrypted":true}',
      },
    });

    expect(
      buildHelixRequest(
        { kind: "reindex-all" },
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
      ),
    ).toEqual({
      url: "https://helix.example/api/admin/search/reindex",
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

  it("builds tenant import dry-run archive upload requests", () => {
    const archiveBytes = Buffer.from([0, 1, 2, 255]);

    expect(
      buildHelixRequest(
        { kind: "tenant-import-dry-run", slug: "acme", archive: "./acme.tar" },
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        archiveBytes,
      ),
    ).toEqual({
      url: "https://helix.example/api/admin/tenants/acme/import/dry-run",
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer token-1",
          "content-type": "application/x-tar",
        },
        body: archiveBytes,
      },
    });

    expect(
      buildHelixRequest(
        {
          kind: "tenant-import-dry-run",
          slug: "acme",
          archive: "./acme.tar",
          conflictPolicy: {
            rowIdConflicts: "preserve",
            principalReferences: "null",
            verifiedState: "preserve",
          },
        },
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        archiveBytes,
      ),
    ).toEqual({
      url: "https://helix.example/api/admin/tenants/acme/import/dry-run?rowIdConflicts=preserve&principalReferences=null&verifiedState=preserve",
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer token-1",
          "content-type": "application/x-tar",
        },
        body: archiveBytes,
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
      url: "https://helix.example/actions/action%2F1",
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
      url: "https://helix.example/api/tools/pending/action%2F1/approve",
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
      url: "https://helix.example/api/tools/pending/action%2F1/cancel",
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
      url: "https://helix.example/mcp",
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
      url: "https://helix.example/mcp",
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
      url: "https://helix.example/mcp",
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
      url: "https://helix.example/mcp",
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
      url: "https://helix.example/mcp",
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
