import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type FetchLike } from "./runner.js";

class CaptureStream extends Writable {
  output = "";

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.output += String(chunk);
    callback();
  }
}

describe("runCli API document commands", () => {
  it("fetches and formats the AsyncAPI document", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ asyncapi: "3.0.0", info: { title: "Helix" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      runCli(
        ["asyncapi", "get"],
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
        url: "https://helix.example/asyncapi.json",
        init: {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: "Bearer token-1",
          },
        },
      },
    ]);
    expect(stdout.output).toBe(
      '{\n  "asyncapi": "3.0.0",\n  "info": {\n    "title": "Helix"\n  }\n}\n',
    );
    expect(stderr.output).toBe("");
  });
});

describe("runCli completion commands", () => {
  it("prints bash completion without calling the API", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response("{}", { status: 200 });
    };

    await expect(
      runCli(
        ["completion", "bash"],
        { HELIX_BASE_URL: "https://helix.example" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([]);
    expect(stdout.output).toContain("complete -F _helix_completion helix");
    expect(stdout.output).toContain("helix tool list --source openapi");
    expect(stdout.output).toContain("tool mail chat drive docs calendar meet assistant webhook");
    expect(stdout.output).toContain("backup restore reindex action");
    expect(stdout.output).toContain("serve resources");
    expect(stdout.output).toContain("list read");
    expect(stdout.output).toContain(
      '[[ $scope == plugin ]] && COMPREPLY=( $(compgen -W "install enable disable uninstall"',
    );
    expect(stdout.output).toContain(
      '[[ $scope == install ]] && COMPREPLY=( $(compgen -W "list plugin enable disable uninstall"',
    );
    expect(stdout.output).toContain("--from");
    expect(stdout.output).toContain("--to --cc --bcc --from --subject --body --html --json");
    expect(stdout.output).toContain("--room-id --body --text --json");
    expect(stdout.output).toContain("--folder --name --mime-type --byte-size --sha256 --json");
    expect(stdout.output).toContain("--event-id --attendee-email --rsvp-token --response --json");
    expect(stdout.output).toContain("--room-id --expires-in-seconds --moderator --json");
    expect(stdout.output).toContain("--event-subject --secret-ref --header --headers");
    expect(stdout.output).toContain("--direction --status --limit --json");
    expect(stdout.output).toContain("app-passwords agent-credentials");
    expect(stdout.output).toContain("--actor-id --label --scope --expires-at --json");
    expect(stdout.output).toContain("--password-id --json");
    expect(stdout.output).toContain("--transport --json");
    expect(stdout.output).toContain("tenant-exports");
    expect(stdout.output).toContain("--include-object-bytes --metadata-only");
    expect(stdout.output).toContain("queue list get status download");
    expect(stdout.output).toContain("--output --force");
    expect(stdout.output).toContain("tenant-imports");
    expect(stdout.output).toContain("dry-run list get status");
    expect(stdout.output).toContain("--row-id-conflicts --principal-references");
    expect(stdout.output).toContain("--status --limit --cursor");
    expect(stdout.output).toContain("tenant-imports ]] && COMPREPLY");
    expect(stdout.output).toContain('compgen -W "succeeded failed"');
    expect(stdout.output).toContain("--thread-id --add --remove --json");
    expect(stdout.output).toContain("--name --priority --enabled --disabled --criteria --actions");
    expect(stdout.output).toContain("--room-id --before --limit --json");
    expect(stdout.output).toContain("--conversation-id --pending-id --classification --json");
    expect(stdout.output).toContain("public standard confidential restricted");
    expect(stdout.output).toContain("login logout auth");
    expect(stderr.output).toBe("");
  });

  it("prints fish completion for the current command aliases and tool metadata", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    await expect(
      runCli(
        ["completion", "fish"],
        {},
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        async () => new Response("{}", { status: 200 }),
      ),
    ).resolves.toBe(0);

    expect(stdout.output).toContain("complete -c helix -f");
    expect(stdout.output).toContain("__helix_tool_ids");
    expect(stdout.output).toContain("completion");
    expect(stdout.output).toContain("bash zsh fish");
    expect(stdout.output).toContain("serve resources");
    expect(stdout.output).toContain("backup");
    expect(stdout.output).toContain("restore");
    expect(stdout.output).toContain("tenant-exports");
    expect(stdout.output).toContain("tenant-imports");
    expect(stdout.output).toContain("dry-run list get status");
    expect(stdout.output).toContain('-l status -x -a "succeeded failed"');
    expect(stdout.output).toContain("install enable disable uninstall");
    expect(stdout.output).toContain("-l from -x");
    expect(stdout.output).toContain(
      "__fish_seen_subcommand_from chat; and __fish_seen_subcommand_from send",
    );
    expect(stdout.output).toContain(
      "__fish_seen_subcommand_from calendar; and __fish_seen_subcommand_from find-time",
    );
    expect(stdout.output).toContain(
      "__fish_seen_subcommand_from webhook; and __fish_seen_subcommand_from outbound",
    );
    expect(stdout.output).toContain(
      "__fish_seen_subcommand_from admin; and __fish_seen_subcommand_from app-passwords",
    );
    expect(stderr.output).toBe("");
  });
});

describe("runCli webhook wrapper commands", () => {
  it("posts typed webhook payloads to the REST tool endpoint", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ id: "webhook-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      runCli(
        [
          "webhook",
          "outbound",
          "create",
          "--name",
          "Build events",
          "--url",
          "https://hooks.example/build",
          "--event-subject",
          "build.finished",
          "--secret-ref",
          "secret/webhooks/build",
          "--header",
          "X-Helix=cli",
          "--metadata",
          '{"team":"platform"}',
          "--disabled",
        ],
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
        url: "https://helix.example/api/tools/webhook.outbound.create",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: "Bearer token-1",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Build events",
            url: "https://hooks.example/build",
            eventSubjects: ["build.finished"],
            secretRef: "secret/webhooks/build",
            headers: { "X-Helix": "cli" },
            metadata: { team: "platform" },
            enabled: false,
          }),
        },
      },
    ]);
    expect(stdout.output).toBe('{\n  "id": "webhook-1"\n}\n');
    expect(stderr.output).toBe("");
  });
});

describe("runCli tenant storage migration operator commands", () => {
  it("calls the tenant storage migration admin API with explicit operator safeguards", async () => {
    const migrationId = "99999999-9999-4999-8999-999999999999";
    const targetStorage = {
      kind: "byo",
      provider: "aws-s3",
      bucket: "acme-helix-data",
      credentials_vault_path: "tenants/acme/byo-storage/aws",
    };
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/byo-storage/test")) {
        return Response.json({
          health: { status: "healthy", checked_at: "2026-05-25T10:00:00Z", message: "ok" },
        });
      }
      if (url.endsWith("/cutover")) {
        return Response.json({
          migration: { id: migrationId, status: "succeeded" },
          tenantConfig: { orgId: "org-1" },
        });
      }
      if (init.method === "GET") {
        return Response.json({ migration: { id: migrationId, status: "queued" } });
      }
      return Response.json({ migration: { id: migrationId, status: "queued" } }, { status: 202 });
    };

    const commands: readonly (readonly string[])[] = [
      ["admin", "storage", "test"],
      [
        "admin",
        "storage-migrations",
        "request",
        "--target",
        "byo",
        "--target-storage",
        JSON.stringify(targetStorage),
      ],
      ["admin", "storage-migrations", "get", migrationId],
      ["admin", "storage-migrations", "cutover", migrationId, "--confirm", "CUTOVER"],
    ];

    for (const args of commands) {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      await expect(
        runCli(
          args,
          { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
          {
            stdin: Readable.from([]),
            stdout,
            stderr,
          },
          fetchImpl,
        ),
      ).resolves.toBe(0);
      expect(stdout.output).toContain("{\n");
      expect(stderr.output).toBe("");
    }

    expect(requests).toEqual([
      {
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
      },
      {
        url: "https://helix.example/api/admin/tenant-config/byo-storage/migrations",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: "Bearer token-1",
            "content-type": "application/json",
          },
          body: JSON.stringify({ target: "byo", dryRun: true, targetStorage }),
        },
      },
      {
        url: `https://helix.example/api/admin/tenant-config/byo-storage/migrations/${migrationId}`,
        init: {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: "Bearer token-1",
          },
        },
      },
      {
        url: `https://helix.example/api/admin/tenant-config/byo-storage/migrations/${migrationId}/cutover`,
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: "Bearer token-1",
            "content-type": "application/json",
          },
          body: '{"confirm":"CUTOVER"}',
        },
      },
    ]);
  });
});

describe("runCli durable tenant export operator commands", () => {
  it("queues, lists, and reads durable tenant export jobs", async () => {
    const exportJobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      if (init.method === "POST") {
        return Response.json({ exportJob: { id: exportJobId, status: "queued" } }, { status: 202 });
      }
      if (url.endsWith(`/${exportJobId}`)) {
        return Response.json({
          exportJob: {
            id: exportJobId,
            status: "succeeded",
            artifact: { downloadUrl: "https://storage.example/archive.tar" },
          },
        });
      }
      return Response.json({ exportJobs: [{ id: exportJobId, status: "queued" }] });
    };

    const commands: readonly (readonly string[])[] = [
      [
        "admin",
        "tenant-exports",
        "queue",
        "acme",
        "--metadata-only",
        "--presigned-url-expires-seconds",
        "600",
      ],
      ["admin", "tenant-exports", "list", "acme", "--status", "queued", "--limit", "10"],
      ["admin", "tenant-exports", "status", "acme", exportJobId],
    ];

    for (const args of commands) {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      await expect(
        runCli(
          args,
          { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
          {
            stdin: Readable.from([]),
            stdout,
            stderr,
          },
          fetchImpl,
        ),
      ).resolves.toBe(0);
      expect(stdout.output).toContain("{\n");
      expect(stderr.output).toBe("");
    }

    expect(requests).toEqual([
      {
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
      },
      {
        url: "https://helix.example/api/admin/tenants/acme/export/jobs?status=queued&limit=10",
        init: {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: "Bearer token-1",
          },
        },
      },
      {
        url: `https://helix.example/api/admin/tenants/acme/export/jobs/${exportJobId}`,
        init: {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: "Bearer token-1",
          },
        },
      },
    ]);
  });

  it("downloads completed tenant export artifacts to a file", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "helix-export-download-"));
    const output = join(tmp, "archive.tar");
    const archiveBytes = Buffer.from([0, 1, 2, 3, 255]);
    const exportJobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      if (url === "https://storage.example/archive.tar") {
        return new Response(archiveBytes);
      }
      return Response.json({
        exportJob: {
          id: exportJobId,
          status: "succeeded",
          artifact: { downloadUrl: "https://storage.example/archive.tar" },
        },
      });
    };
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    try {
      await expect(
        runCli(
          ["admin", "tenant-exports", "download", "acme", exportJobId, "--output", output],
          { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
          {
            stdin: Readable.from([]),
            stdout,
            stderr,
          },
          fetchImpl,
        ),
      ).resolves.toBe(0);

      expect(readFileSync(output)).toEqual(archiveBytes);
      expect(JSON.parse(stdout.output)).toEqual({ output, byteSize: archiveBytes.byteLength });
      expect(stderr.output).toBe("");
      expect(requests).toEqual([
        {
          url: `https://helix.example/api/admin/tenants/acme/export/jobs/${exportJobId}`,
          init: {
            method: "GET",
            headers: {
              accept: "application/json",
              authorization: "Bearer token-1",
            },
          },
        },
        {
          url: "https://storage.example/archive.tar",
          init: { method: "GET", headers: {} },
        },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite tenant export artifact downloads without --force", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "helix-export-download-"));
    const output = join(tmp, "archive.tar");
    writeFileSync(output, "existing");
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const fetchImpl: FetchLike = async () => {
      throw new Error("download should not fetch when output exists");
    };

    try {
      await expect(
        runCli(
          [
            "admin",
            "tenant-exports",
            "download",
            "acme",
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "--output",
            output,
          ],
          { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
          {
            stdin: Readable.from([]),
            stdout,
            stderr,
          },
          fetchImpl,
        ),
      ).resolves.toBe(1);

      expect(readFileSync(output, "utf8")).toBe("existing");
      expect(stdout.output).toBe("");
      expect(stderr.output).toContain("Refusing to overwrite existing file");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uploads tenant import archives for dry-run planning", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "helix-import-dry-run-"));
    const archive = join(tmp, "acme.tar");
    const archiveBytes = Buffer.from([0, 1, 2, 3, 255]);
    writeFileSync(archive, archiveBytes);
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return Response.json({
        ok: true,
        issues: [],
        plan: {
          dryRun: true,
          summary: { operationCount: 3 },
        },
      });
    };

    try {
      await expect(
        runCli(
          ["admin", "tenant-imports", "dry-run", "acme", archive],
          { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
          {
            stdin: Readable.from([]),
            stdout,
            stderr,
          },
          fetchImpl,
        ),
      ).resolves.toBe(0);

      expect(JSON.parse(stdout.output)).toMatchObject({
        ok: true,
        plan: {
          dryRun: true,
          summary: { operationCount: 3 },
        },
      });
      expect(stderr.output).toBe("");
      expect(requests).toEqual([
        {
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
        },
      ]);
      requests.length = 0;
      stdout.output = "";
      stderr.output = "";

      await expect(
        runCli(
          [
            "admin",
            "tenant-imports",
            "dry-run",
            "acme",
            archive,
            "--row-id-conflicts",
            "preserve",
            "--principal-references",
            "null",
            "--verified-state",
            "preserve",
          ],
          { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
          {
            stdin: Readable.from([]),
            stdout,
            stderr,
          },
          fetchImpl,
        ),
      ).resolves.toBe(0);

      expect(requests).toEqual([
        {
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
        },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("lists and reads persisted tenant import jobs", async () => {
    const importJobId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith(`/${importJobId}`)) {
        return Response.json({ importJob: { id: importJobId, status: "succeeded" } });
      }
      return Response.json({ importJobs: [{ id: importJobId, status: "failed" }] });
    };

    const commands: readonly (readonly string[])[] = [
      ["admin", "tenant-imports", "list", "acme", "--status", "failed", "--limit", "10"],
      ["admin", "tenant-imports", "get", "acme", importJobId],
    ];

    for (const args of commands) {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      await expect(
        runCli(
          args,
          { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
          {
            stdin: Readable.from([]),
            stdout,
            stderr,
          },
          fetchImpl,
        ),
      ).resolves.toBe(0);
      expect(stdout.output).toContain("{\n");
      expect(stderr.output).toBe("");
    }

    expect(requests).toEqual([
      {
        url: "https://helix.example/api/admin/tenants/acme/import/jobs?status=failed&limit=10",
        init: {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: "Bearer token-1",
          },
        },
      },
      {
        url: `https://helix.example/api/admin/tenants/acme/import/jobs/${importJobId}`,
        init: {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: "Bearer token-1",
          },
        },
      },
    ]);
  });
});

describe("runCli backup and restore operator commands", () => {
  it("posts backup create requests to the admin API", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ backupId: "backup-20260520T120000Z" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      runCli(
        ["backup", "create"],
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
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
      },
    ]);
    expect(stdout.output).toBe('{\n  "backupId": "backup-20260520T120000Z"\n}\n');
    expect(stderr.output).toBe("");
  });

  it("posts restore requests with the selected backup id and encryption mode", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ restoreId: "restore-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      runCli(
        ["restore", "--from", "backup-20260520T120000Z", "--encrypted"],
        { HELIX_BASE_URL: "https://helix.example" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
        url: "https://helix.example/api/admin/restores",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: '{"backupId":"backup-20260520T120000Z","encrypted":true}',
        },
      },
    ]);
    expect(stdout.output).toBe('{\n  "restoreId": "restore-1"\n}\n');
    expect(stderr.output).toBe("");
  });

  it("posts full search reindex requests to the admin API", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ status: "completed", totalDocuments: 10 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      runCli(
        ["reindex", "--all"],
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
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
      },
    ]);
    expect(stdout.output).toBe('{\n  "status": "completed",\n  "totalDocuments": 10\n}\n');
    expect(stderr.output).toBe("");
  });
});

describe("runCli action status commands", () => {
  it("fetches the pending action status for agents", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response(
        JSON.stringify({
          action: {
            id: "00000000-0000-4000-8000-000000000111",
            status: "pending_confirmation",
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    await expect(
      runCli(
        ["action", "status", "00000000-0000-4000-8000-000000000111"],
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
        url: "https://helix.example/actions/00000000-0000-4000-8000-000000000111",
        init: {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: "Bearer token-1",
          },
        },
      },
    ]);
    expect(stdout.output).toBe(
      '{\n  "action": {\n    "id": "00000000-0000-4000-8000-000000000111",\n    "status": "pending_confirmation"\n  }\n}\n',
    );
    expect(stderr.output).toBe("");
  });

  it("approves pending actions for agents", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ status: "executed", output: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      runCli(
        ["action", "approve", "00000000-0000-4000-8000-000000000111"],
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
        url: "https://helix.example/api/tools/pending/00000000-0000-4000-8000-000000000111/approve",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: "Bearer token-1",
            "content-type": "application/json",
          },
          body: "{}",
        },
      },
    ]);
    expect(stdout.output).toBe(
      '{\n  "status": "executed",\n  "output": {\n    "ok": true\n  }\n}\n',
    );
    expect(stderr.output).toBe("");
  });

  it("cancels pending actions for agents", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response(
        JSON.stringify({
          status: "cancelled",
          pending: {
            id: "00000000-0000-4000-8000-000000000111",
            status: "cancelled",
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    await expect(
      runCli(
        ["action", "cancel", "00000000-0000-4000-8000-000000000111"],
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
        url: "https://helix.example/api/tools/pending/00000000-0000-4000-8000-000000000111/cancel",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: "Bearer token-1",
            "content-type": "application/json",
          },
          body: "{}",
        },
      },
    ]);
    expect(stdout.output).toContain('"status": "cancelled"');
    expect(stderr.output).toBe("");
  });
});

describe("runCli tool discovery commands", () => {
  it("lists tool schemas discovered from the OpenAPI document", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          openapi: "3.1.0",
          paths: {
            "/api/tools/platform.ping": {
              get: {
                operationId: "getTool_platform_ping",
                summary: "Ping the platform",
                "x-helix-tool": {
                  id: "platform.ping",
                  permission: "platform.read",
                  sideEffects: "read",
                  confirmationRequired: false,
                },
                parameters: [{ name: "input", schema: { type: "object" } }],
                responses: {
                  "200": {
                    content: { "application/json": { schema: { type: "object" } } },
                  },
                },
              },
              post: {
                operationId: "postTool_platform_ping",
                summary: "Ping the platform",
                "x-helix-tool": {
                  id: "platform.ping",
                  permission: "platform.read",
                  sideEffects: "read",
                  confirmationRequired: false,
                },
                requestBody: {
                  content: { "application/json": { schema: { type: "object" } } },
                },
                responses: {
                  "200": {
                    content: { "application/json": { schema: { type: "object" } } },
                  },
                },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    await expect(
      runCli(
        ["tool", "list", "--source", "openapi"],
        { HELIX_BASE_URL: "https://helix.example" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(stdout.output)).toEqual({
      tools: [
        {
          id: "platform.ping",
          path: "/api/tools/platform.ping",
          methods: ["get", "post"],
          description: "Ping the platform",
          permission: "platform.read",
          sideEffects: "read",
          confirmationRequired: false,
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
      ],
    });
    expect(stderr.output).toBe("");
  });

  it("describes a single OpenAPI-projected tool", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          openapi: "3.1.0",
          paths: {
            "/api/tools/mail.send": {
              post: {
                summary: "Send mail",
                "x-helix-tool": {
                  id: "mail.send",
                  permission: "mail.send",
                  sideEffects: "external_communication",
                  confirmationRequired: true,
                },
                requestBody: {
                  content: { "application/json": { schema: { required: ["to"] } } },
                },
                responses: {
                  "200": {
                    content: { "application/json": { schema: { required: ["messageId"] } } },
                  },
                },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    await expect(
      runCli(
        ["tool", "describe", "mail.send"],
        { HELIX_BASE_URL: "https://helix.example" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(stdout.output)).toMatchObject({
      id: "mail.send",
      path: "/api/tools/mail.send",
      methods: ["post"],
      inputSchema: { required: ["to"] },
      outputSchema: { required: ["messageId"] },
    });
    expect(stderr.output).toBe("");
  });

  it("lists tools through MCP and normalizes MCP names to ids", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "helix-tool-list",
          result: {
            tools: [
              {
                name: "platform.ping",
                description: "Ping",
                inputSchema: { type: "object" },
                annotations: { permission: "platform.read" },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    await expect(
      runCli(
        ["tool", "list", "--source", "mcp"],
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests[0]).toMatchObject({
      url: "https://helix.example/mcp",
      init: {
        method: "POST",
        body: '{"jsonrpc":"2.0","id":"helix-tool-list","method":"tools/list"}',
      },
    });
    expect(JSON.parse(stdout.output)).toEqual({
      tools: [
        {
          id: "platform.ping",
          name: "platform.ping",
          description: "Ping",
          inputSchema: { type: "object" },
          annotations: { permission: "platform.read" },
        },
      ],
    });
    expect(stderr.output).toBe("");
  });

  it("calls tools through MCP and prints structured content", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "helix-tool-call",
          result: {
            content: [{ type: "text", text: '{"ok":true}' }],
            structuredContent: { ok: true },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    await expect(
      runCli(
        ["tool", "call", "platform.ping", "--transport", "mcp", "--json", '{"echo":true}'],
        { HELIX_BASE_URL: "https://helix.example" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests[0]?.init.body).toBe(
      '{"jsonrpc":"2.0","id":"helix-tool-call","method":"tools/call","params":{"name":"platform.ping","arguments":{"echo":true}}}',
    );
    expect(stdout.output).toBe('{\n  "ok": true\n}\n');
    expect(stderr.output).toBe("");
  });

  it("lists and reads MCP resources", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      const body = typeof init.body === "string" ? init.body : "";
      return new Response(
        body.includes("resources/read")
          ? JSON.stringify({
              jsonrpc: "2.0",
              id: "helix-resource-read",
              result: {
                contents: [
                  {
                    uri: "helix://chat/room/room-1",
                    mimeType: "text/markdown",
                    text: "# Daily standup",
                  },
                ],
              },
            })
          : JSON.stringify({
              jsonrpc: "2.0",
              id: "helix-resource-list",
              result: {
                resources: [
                  {
                    uri: "helix://chat/room/room-1",
                    name: "Daily standup",
                    mimeType: "text/markdown",
                  },
                ],
              },
            }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    await expect(
      runCli(
        ["mcp", "resources", "list"],
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(
        ["mcp", "resources", "read", "helix://chat/room/room-1"],
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests.map((request) => request.init.body)).toEqual([
      '{"jsonrpc":"2.0","id":"helix-resource-list","method":"resources/list"}',
      '{"jsonrpc":"2.0","id":"helix-resource-read","method":"resources/read","params":{"uri":"helix://chat/room/room-1"}}',
    ]);
    expect(stdout.output).toContain('"resources"');
    expect(stdout.output).toContain('"contents"');
    expect(stderr.output).toBe("");
  });

  it("calls mail wrappers through REST tool endpoints", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ sent: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      runCli(
        ["mail", "send", "--to", "ada@example.com", "--subject", "Hi", "--body", "Hello"],
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
        url: "https://helix.example/api/tools/mail.send",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: "Bearer token-1",
            "content-type": "application/json",
          },
          body: '{"to":["ada@example.com"],"subject":"Hi","body":"Hello"}',
        },
      },
    ]);
    expect(stdout.output).toBe('{\n  "sent": true\n}\n');
    expect(stderr.output).toBe("");
  });

  it("calls typed drive wrappers through REST tool endpoints", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ objectId: "object-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      runCli(
        ["drive", "upload", "./report.pdf", "--folder", "44444444-4444-4444-8444-444444444444"],
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
        url: "https://helix.example/api/tools/drive.upload",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: "Bearer token-1",
            "content-type": "application/json",
          },
          body: '{"name":"report.pdf","metadata":{"localPath":"./report.pdf"},"folderId":"44444444-4444-4444-8444-444444444444"}',
        },
      },
    ]);
    expect(stdout.output).toBe('{\n  "objectId": "object-1"\n}\n');
    expect(stderr.output).toBe("");
  });

  it("calls typed chat wrappers through REST tool endpoints", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ messageId: "message-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      runCli(
        ["chat", "send", "--room-id", "room-1", "--body", "Hello"],
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
        url: "https://helix.example/api/tools/chat.send",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: "Bearer token-1",
            "content-type": "application/json",
          },
          body: '{"roomId":"room-1","body":"Hello"}',
        },
      },
    ]);
    expect(stdout.output).toBe('{\n  "messageId": "message-1"\n}\n');
    expect(stderr.output).toBe("");
  });

  it("calls typed calendar wrappers through REST tool endpoints", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ slots: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      runCli(
        [
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
        ],
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
        url: "https://helix.example/api/tools/calendar.find-time",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: "Bearer token-1",
            "content-type": "application/json",
          },
          body: '{"attendeeEmails":["ada@example.com"],"durationMinutes":30,"windowStartsAt":"2026-06-01T09:00:00-04:00","windowEndsAt":"2026-06-01T17:00:00-04:00"}',
        },
      },
    ]);
    expect(stdout.output).toBe('{\n  "slots": []\n}\n');
    expect(stderr.output).toBe("");
  });
});

describe("runCli plugin install", () => {
  it("installs a plugin version from the plugin install alias", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ installed: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      runCli(
        ["plugin", "install", "com.helix.core.mail@1.2.3"],
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
        url: "https://helix.example/api/tools/plugin.install",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: "Bearer token-1",
            "content-type": "application/json",
          },
          body: '{"pluginId":"com.helix.core.mail","version":"1.2.3"}',
        },
      },
    ]);
    expect(stdout.output).toBe('{\n  "installed": true\n}\n');
    expect(stderr.output).toBe("");
  });
});

describe("runCli plugin lifecycle", () => {
  it("posts resolved JSON to the selected plugin lifecycle tool", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ status: "disabled" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      runCli(
        ["plugin", "disable", "com.helix.core.mail", "--json", '{"reason":"maintenance"}'],
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
        url: "https://helix.example/api/tools/plugin.disable",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: "Bearer token-1",
            "content-type": "application/json",
          },
          body: '{"reason":"maintenance","pluginId":"com.helix.core.mail"}',
        },
      },
    ]);
    expect(stdout.output).toBe('{\n  "status": "disabled"\n}\n');
    expect(stderr.output).toBe("");
  });
});

describe("runCli login", () => {
  it("mints an OAuth token and prints an export command without persisting secrets", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ access_token: "token-1", token_type: "Bearer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      runCli(
        ["login", "--client-id", "agent-1", "--client-secret", "secret", "--scope", "tools:read"],
        { HELIX_BASE_URL: "https://helix.example" },
        {
          stdin: Readable.from([]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
        url: "https://helix.example/oauth/token",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "grant_type=client_credentials&client_id=agent-1&client_secret=secret&scope=tools%3Aread",
        },
      },
    ]);
    expect(stdout.output).toBe(
      '{\n  "access_token": "token-1",\n  "token_type": "Bearer"\n}\n\nexport HELIX_ACCESS_TOKEN=\'token-1\'\n',
    );
    expect(stderr.output).toBe("");
  });
});

describe("runCli MCP serve", () => {
  it("forwards line-delimited JSON-RPC messages to the Helix MCP endpoint", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      runCli(
        ["mcp", "serve"],
        { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        {
          stdin: Readable.from(['{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n']),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
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
      },
    ]);
    expect(stdout.output).toBe('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n');
    expect(stderr.output).toBe("");
  });

  it("preserves Content-Length framing for MCP clients", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const body = '{"jsonrpc":"2.0","id":"init","method":"initialize"}';
    const bodyLength = String(Buffer.byteLength(body, "utf8"));
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: "init", result: { protocolVersion: "2024-11-05" } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );

    await expect(
      runCli(
        ["mcp", "serve"],
        { HELIX_BASE_URL: "https://helix.example" },
        {
          stdin: Readable.from([`Content-Length: ${bodyLength}\r\n\r\n${body}`]),
          stdout,
          stderr,
        },
        fetchImpl,
      ),
    ).resolves.toBe(0);

    const responseBody = '{"jsonrpc":"2.0","id":"init","result":{"protocolVersion":"2024-11-05"}}';
    const responseLength = String(Buffer.byteLength(responseBody, "utf8"));
    expect(stdout.output).toBe(`Content-Length: ${responseLength}\r\n\r\n${responseBody}`);
    expect(stderr.output).toBe("");
  });
});

describe("runCli logout", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const noFetch: FetchLike = async () => {
    throw new Error("logout must not perform a network request");
  };

  it("clears a stored credentials file without calling the API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "helix-cli-logout-"));
    tempDirs.push(dir);
    const credentialsFile = join(dir, "credentials.json");
    writeFileSync(credentialsFile, '{"access_token":"token-1"}');

    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    await expect(
      runCli(
        ["logout"],
        { HELIX_CREDENTIALS_FILE: credentialsFile },
        { stdin: Readable.from([]), stdout, stderr },
        noFetch,
      ),
    ).resolves.toBe(0);

    expect(existsSync(credentialsFile)).toBe(false);
    expect(stdout.output).toContain("Cleared stored credentials");
    expect(stderr.output).toBe("");
  });

  it("is idempotent when no credentials file exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "helix-cli-logout-"));
    tempDirs.push(dir);
    const credentialsFile = join(dir, "credentials.json");

    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    await expect(
      runCli(
        ["logout"],
        { HELIX_CREDENTIALS_FILE: credentialsFile },
        { stdin: Readable.from([]), stdout, stderr },
        noFetch,
      ),
    ).resolves.toBe(0);

    expect(stdout.output).toContain("No stored credentials found");
    expect(stderr.output).toBe("");
  });

  it("warns when HELIX_ACCESS_TOKEN is still set in the shell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "helix-cli-logout-"));
    tempDirs.push(dir);
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    await expect(
      runCli(
        ["logout"],
        {
          HELIX_CREDENTIALS_FILE: join(dir, "credentials.json"),
          HELIX_ACCESS_TOKEN: "token-1",
        },
        { stdin: Readable.from([]), stdout, stderr },
        noFetch,
      ),
    ).resolves.toBe(0);

    expect(stderr.output).toContain("unset HELIX_ACCESS_TOKEN");
  });
});
