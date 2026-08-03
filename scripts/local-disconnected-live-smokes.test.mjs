import { describe, expect, it, vi } from "vitest";
import {
  buildReportSkeleton,
  checkHealth,
  parseArgs,
  RBAC_UNIT_SUITES,
  runLocalDisconnectedLiveSmokes,
  runMultiUserRbacProbes,
} from "./local-disconnected-live-smokes.mjs";

describe("local-disconnected-live-smokes", () => {
  it("parses static-only by default and execute with iterations", () => {
    expect(parseArgs([]).mode).toBe("static-only");
    const exec = parseArgs(["--execute", "--iterations", "10", "--base-url", "http://127.0.0.1:9"]);
    expect(exec.mode).toBe("execute");
    expect(exec.iterations).toBe(10);
    expect(exec.baseUrl).toBe("http://127.0.0.1:9");
    // pnpm inserts a bare "--" separator
    expect(parseArgs(["--", "--static-only"]).mode).toBe("static-only");
  });

  it("lists multi-surface RBAC unit suites covering mail drive chat agents admin tenancy", () => {
    const joined = RBAC_UNIT_SUITES.join("\n");
    expect(joined).toMatch(/mail/);
    expect(joined).toMatch(/drive/);
    expect(joined).toMatch(/chat/);
    expect(joined).toMatch(/agent/);
    expect(joined).toMatch(/tenancy|cross-tenant/);
    expect(joined).toMatch(/admin-users/);
    expect(RBAC_UNIT_SUITES.length).toBeGreaterThanOrEqual(10);
  });

  it("report skeleton never forges external mail deliverability", () => {
    const report = buildReportSkeleton(parseArgs(["--static-only"]));
    expect(report.external.gmail.status).toBe("not_run");
    expect(report.external.microsoft365.status).toBe("not_run");
    expect(report.external.provider_sandbox.status).toBe("not_run");
  });

  it("multi-user RBAC probes expect admin allow and user deny for admin.users", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      const path = String(url);
      const auth = init?.headers?.authorization ?? "";
      if (path.includes("/api/admin/users") && !path.includes("offboard")) {
        if (auth.includes("admin-token")) {
          return { status: 200, ok: true };
        }
        return { status: 403, ok: false };
      }
      if (path.includes("/offboard") && init?.method === "POST") {
        return { status: 404, ok: false };
      }
      if (path.includes("/offboard")) {
        return { status: 403, ok: false };
      }
      if (path.includes("/api/tools")) {
        return { status: 200, ok: true };
      }
      return { status: 404, ok: false };
    });

    const result = await runMultiUserRbacProbes({
      baseUrl: "http://127.0.0.1:9",
      adminToken: "admin-token",
      userToken: "user-token",
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(result.results.find((r) => r.name === "admin.users.admin_ok")?.status).toBe(200);
    expect(result.results.find((r) => r.name === "admin.users.user_denied")?.status).toBe(403);
    expect(result.results.find((r) => r.name === "offboard.foreign_404")?.status).toBe(404);
  });

  it("checkHealth reports unreachable without throwing", async () => {
    const health = await checkHealth("http://127.0.0.1:1", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(health.ok).toBe(false);
    expect(health.error).toMatch(/ECONNREFUSED/);
  });

  it("orchestrator static-only records external not_run and runs command phases", async () => {
    const calls = [];
    const report = await runLocalDisconnectedLiveSmokes(
      {
        mode: "static-only",
        iterations: 2,
        outputDir: `/tmp/grok-goal-2e655f163fbf/implementer/local-smokes-unit-${Date.now()}`,
        baseUrl: "http://127.0.0.1:9",
        skipUnit: true,
        skipLiveAuth: true,
      },
      {
        runCommand: async (command, args) => {
          calls.push([command, ...args].join(" "));
          return {
            command: [command, ...args].join(" "),
            code: 0,
            durationMs: 1,
            stdout: '{"status":"static_validated"}\n',
            stderr: "",
          };
        },
      },
    );
    expect(report.external.gmail.status).toBe("not_run");
    expect(report.summary.failed).toBe(0);
    expect(report.summary.passed).toBeGreaterThanOrEqual(4);
    expect(calls.some((c) => c.includes("mail-live-evidence-smoke"))).toBe(true);
    expect(calls.some((c) => c.includes("negative-security-matrix"))).toBe(true);
    expect(report.claims.external_mail_deliverability).toBe(false);
    expect(report.claims.final_release_go).toBe(false);
  });
});
