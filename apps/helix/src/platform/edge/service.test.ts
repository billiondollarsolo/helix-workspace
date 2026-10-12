import fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { actorFromRequest } from "../../api/test-actor.js";
import {
  createTestCertificateAuthority,
  type TestCertificateAuthority,
  type TestServerCertificate,
} from "../../test-support/tls-fixtures.js";
import { registerEdgeCertificateAdminRoutes } from "./admin-routes.js";
import { EdgeNotRunningError } from "./caddy-target.js";
import {
  parseEdgeCertificate,
  PEM_PRIVATE_KEY_HEADER,
  type EdgeCertificateSummary,
} from "./certificate.js";
import {
  EdgeCertificateReconciler,
  EdgeCertificateService,
  type EdgeCertificateServiceOptions,
  type EdgeCertificateTarget,
} from "./service.js";
import type { EdgeCertificateBundle, StoredEdgeCertificate } from "./store.js";

const hostname = "workspace.example.test";
const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";

/** One organization's stored certificate, as the Postgres store keeps it. */
class MemoryStore {
  bundle: EdgeCertificateBundle | null = null;
  stored: StoredEdgeCertificate | null = null;

  get = () => Promise.resolve(this.stored);
  readBundle = () => Promise.resolve(this.bundle);
  save = (input: {
    readonly chainPem: string;
    readonly keyPem: string;
    readonly summary: EdgeCertificateSummary;
  }) => {
    this.bundle = {
      chainPem: input.chainPem,
      keyPem: input.keyPem,
      fingerprintSha256: input.summary.fingerprintSha256,
    };
    this.stored = { summary: input.summary, updatedAt: "2026-10-12T00:00:00.000Z" };
    return Promise.resolve(this.stored);
  };
  clear = () => {
    const removed = this.stored;
    this.bundle = null;
    this.stored = null;
    return Promise.resolve(removed);
  };
}

/** An edge that serves whatever bundle it last loaded. */
class FakeEdge implements EdgeCertificateTarget {
  written: EdgeCertificateBundle | null = null;
  loaded: EdgeCertificateBundle | null = null;
  reloads = 0;
  automatic: EdgeCertificateSummary;
  reloadFails = false;

  constructor(automatic: EdgeCertificateSummary) {
    this.automatic = automatic;
  }

  write = (bundle: EdgeCertificateBundle | null) => {
    const changed = bundle?.fingerprintSha256 !== this.written?.fingerprintSha256;
    this.written = bundle;
    return Promise.resolve(changed);
  };
  reload = () => {
    if (this.reloadFails) return Promise.reject(new Error("edge is down"));
    this.reloads += 1;
    this.loaded = this.written;
    return Promise.resolve();
  };
  served = (): EdgeCertificateSummary =>
    this.loaded === null
      ? this.automatic
      : { ...this.automatic, fingerprintSha256: this.loaded.fingerprintSha256 };
}

describe("edge certificate management", () => {
  let authority: TestCertificateAuthority;
  let certificate: TestServerCertificate;
  let renewal: TestServerCertificate;
  let store: MemoryStore;
  let edge: FakeEdge;
  const now = () => new Date(Date.now() + 60_000);

  beforeAll(() => {
    authority = createTestCertificateAuthority();
    certificate = authority.issue([hostname]);
    renewal = authority.issue([hostname]);
  });

  afterAll(() => {
    authority.dispose();
  });

  beforeEach(() => {
    store = new MemoryStore();
    edge = new FakeEdge({
      subject: hostname,
      issuer: "Automatic CA",
      names: [hostname],
      notBefore: "2026-10-01T00:00:00.000Z",
      notAfter: "2026-12-30T00:00:00.000Z",
      fingerprintSha256: "a".repeat(64),
    });
  });

  function service(overrides: Partial<EdgeCertificateServiceOptions> = {}) {
    return new EdgeCertificateService({
      hostname,
      deploymentSource: "automatic",
      singleTenant: true,
      store,
      target: edge,
      probe: () => Promise.resolve(edge.served()),
      inOrganization: (_orgId, work) => work(),
      now,
      applyDelaysMs: [0],
      ...overrides,
    });
  }

  const upload = (subject: EdgeCertificateService, pair = certificate) =>
    subject.upload({
      orgId,
      actorId,
      certificatePem: pair.certificatePem + authority.intermediatePem,
      privateKeyPem: pair.privateKeyPem,
    });

  it("reports the automatic certificate until one is uploaded", async () => {
    await expect(service().status(orgId)).resolves.toMatchObject({
      hostname,
      source: "automatic",
      manageable: true,
      unavailableReason: null,
      uploaded: null,
      applied: true,
      served: { issuer: "Automatic CA" },
    });
  });

  it("stores an uploaded certificate, hands it to the edge and reports it applied", async () => {
    const subject = service();

    const stored = await upload(subject);
    await expect(subject.status(orgId)).resolves.toMatchObject({
      source: "uploaded",
      applied: false,
      uploaded: { issuer: "Test Issuing CA", names: [hostname] },
    });

    await expect(subject.apply(orgId)).resolves.toBe("reloaded");
    expect(edge.loaded?.fingerprintSha256).toBe(stored.summary.fingerprintSha256);
    expect(edge.loaded?.keyPem).toContain(PEM_PRIVATE_KEY_HEADER);
    await expect(subject.status(orgId)).resolves.toMatchObject({ applied: true });
    // Nothing left to do: the edge is not reloaded again.
    await expect(subject.apply(orgId)).resolves.toBe("unchanged");
    expect(edge.reloads).toBe(1);
  });

  it("returns the edge to automatic HTTPS when the certificate is removed", async () => {
    const subject = service();
    await upload(subject);
    await subject.apply(orgId);

    await expect(subject.remove(orgId)).resolves.toMatchObject({ summary: { subject: hostname } });
    await expect(subject.apply(orgId)).resolves.toBe("reloaded");

    expect(edge.written).toBeNull();
    await expect(subject.status(orgId)).resolves.toMatchObject({
      source: "automatic",
      uploaded: null,
      applied: true,
      served: { fingerprintSha256: "a".repeat(64) },
    });
    await expect(subject.remove(orgId)).resolves.toBeNull();
  });

  it("reloads an edge that has the bundle but serves something else, without hammering it", async () => {
    let clock = Date.now() + 60_000;
    const subject = service({ now: () => new Date(clock) });
    await upload(subject);
    await subject.apply(orgId);
    // The edge restarted and lost the loaded certificate.
    edge.loaded = null;

    await expect(subject.apply(orgId)).resolves.toBe("reloaded");
    edge.loaded = null;
    await expect(subject.apply(orgId)).resolves.toBe("unchanged");
    clock += 10 * 60 * 1000;
    await expect(subject.apply(orgId)).resolves.toBe("reloaded");
  });

  it("leaves the bundle for an edge that is not running to load when it starts", async () => {
    const onError = vi.fn();
    const subject = service({
      onError,
      target: { write: edge.write, reload: () => Promise.reject(new EdgeNotRunningError()) },
    });
    await upload(subject);

    await expect(subject.apply(orgId)).resolves.toBe("unchanged");

    expect(edge.written).not.toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("explains why a certificate cannot be uploaded here", async () => {
    await expect(service({ deploymentSource: "files" }).status(orgId)).resolves.toMatchObject({
      source: "deployment-files",
      manageable: false,
      unavailableReason:
        "This deployment serves a certificate from files on the server. Replace those files and restart the edge to change it.",
    });
    await expect(service({ target: null }).status(orgId)).resolves.toMatchObject({
      manageable: false,
      unavailableReason: "Certificate management is not set up for this deployment.",
    });
    await expect(service({ singleTenant: false }).status(orgId)).resolves.toMatchObject({
      manageable: false,
      unavailableReason: "The certificate for this address is managed by the platform operator.",
    });
    await expect(service({ target: null }).apply(orgId)).resolves.toBe("unchanged");
  });

  it("applies a requested change after the request, and reports a failing edge", async () => {
    const onError = vi.fn();
    const subject = service({ onError });
    await upload(subject);

    subject.requestApply(orgId);
    await vi.waitFor(() => {
      expect(edge.reloads).toBe(1);
    });

    await upload(subject, renewal);
    edge.reloadFails = true;
    subject.requestApply(orgId);
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    expect(String(onError.mock.calls[0]?.[0])).toContain("edge is down");
  });

  describe("reconciler", () => {
    it("restores the edge and warns once a day while the certificate is close to expiring", async () => {
      const subject = service();
      const stored = await upload(subject);
      const onReloaded = vi.fn();
      const onExpiring = vi.fn();
      const notAfter = new Date(stored.summary.notAfter).getTime();
      let clock = notAfter - 40 * 24 * 60 * 60 * 1000;
      const reconciler = new EdgeCertificateReconciler({
        service: subject,
        orgId,
        onReloaded,
        onExpiring,
        now: () => new Date(clock),
      });

      await reconciler.runOnce();
      expect(onReloaded).toHaveBeenCalledTimes(1);
      expect(onExpiring).not.toHaveBeenCalled();

      clock = notAfter - 10 * 24 * 60 * 60 * 1000 - 1000;
      await reconciler.runOnce();
      await reconciler.runOnce();
      expect(onExpiring).toHaveBeenCalledTimes(1);
      expect(onExpiring).toHaveBeenCalledWith({ hostname, days: 10 });
      expect(onReloaded).toHaveBeenCalledTimes(1);

      clock += 24 * 60 * 60 * 1000;
      await reconciler.runOnce();
      expect(onExpiring).toHaveBeenLastCalledWith({ hostname, days: 9 });
    });

    it("does not run where certificates cannot be managed", () => {
      const subject = service({ target: null });
      const apply = vi.spyOn(subject, "apply");
      const reconciler = new EdgeCertificateReconciler({ service: subject, orgId });

      reconciler.start();

      expect(apply).not.toHaveBeenCalled();
    });
  });

  describe("admin routes", () => {
    const headers = (scopes: string) => ({
      "x-helix-actor-id": actorId,
      "x-helix-org-id": orgId,
      "x-helix-scopes": scopes,
    });

    function build(subject = service()) {
      const audit: { verb: string; objectId?: string; metadata?: Record<string, unknown> }[] = [];
      const app = fastify();
      registerEdgeCertificateAdminRoutes(app, {
        service: subject,
        actorFromRequest,
        auditSink: {
          append: (record) => {
            audit.push(record);
            return Promise.resolve({ id: "audit", thisHash: "hash" });
          },
        },
      });
      return { app, audit };
    }

    const pem = (pair = certificate) => ({
      certificatePem: pair.certificatePem + authority.intermediatePem,
      privateKeyPem: pair.privateKeyPem,
    });

    it("lets a reader see the certificate and only a writer change it", async () => {
      const { app, audit } = build();

      const read = await app.inject({
        method: "GET",
        url: "/api/admin/edge/certificate",
        headers: headers("admin.console.read"),
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ certificate: { source: "automatic", hostname } });

      for (const [method, scopes] of [
        ["GET", "mail.read"],
        ["PUT", "admin.console.read"],
        ["DELETE", "admin.console.read"],
      ] as const) {
        const refused = await app.inject({
          method,
          url: "/api/admin/edge/certificate",
          headers: headers(scopes),
          ...(method === "PUT" ? { payload: pem() } : {}),
        });
        expect(refused.statusCode).toBe(403);
      }
      expect(store.stored).toBeNull();
      expect(audit).toEqual([]);
    });

    it("uploads, audits without the key, applies, and removes", async () => {
      const { app, audit } = build();
      const expected = parseEdgeCertificate({ ...pem(), hostname, now: now() }).summary;

      const uploaded = await app.inject({
        method: "PUT",
        url: "/api/admin/edge/certificate",
        headers: headers("admin.console.write"),
        payload: pem(),
      });

      expect(uploaded.statusCode).toBe(200);
      expect(uploaded.json()).toMatchObject({
        certificate: {
          source: "uploaded",
          uploaded: { fingerprintSha256: expected.fingerprintSha256 },
        },
      });
      expect(uploaded.body).not.toContain("PRIVATE KEY");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        verb: "edge.tls.certificate_uploaded",
        metadata: {
          hostname,
          fingerprintSha256: expected.fingerprintSha256,
          names: [hostname],
          replacedFingerprintSha256: null,
        },
      });
      // The audit log's object id is a UUID column; a fingerprint is not one.
      expect(audit.every((record) => record.objectId === undefined)).toBe(true);
      expect(JSON.stringify(audit)).not.toContain("PRIVATE KEY");
      await vi.waitFor(() => {
        expect(edge.loaded?.fingerprintSha256).toBe(expected.fingerprintSha256);
      });

      const removed = await app.inject({
        method: "DELETE",
        url: "/api/admin/edge/certificate",
        headers: headers("admin.console.write"),
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({
        certificate: { source: "automatic", uploaded: null },
      });
      expect(audit[1]).toMatchObject({ verb: "edge.tls.certificate_removed" });
      await vi.waitFor(() => {
        expect(edge.written).toBeNull();
      });

      // Removing nothing is not an event.
      await app.inject({
        method: "DELETE",
        url: "/api/admin/edge/certificate",
        headers: headers("admin.console.write"),
      });
      expect(audit).toHaveLength(2);
    });

    it("names the field and the fix when the certificate is unusable", async () => {
      const { app, audit } = build();
      const other = authority.issue(["other.example.test"]);

      const wrongName = await app.inject({
        method: "PUT",
        url: "/api/admin/edge/certificate",
        headers: headers("admin.console.write"),
        payload: pem(other),
      });
      expect(wrongName.statusCode).toBe(400);
      expect(wrongName.json()).toEqual({
        error: `This certificate covers other.example.test. It must cover ${hostname}.`,
        code: "invalid_request",
        issues: [{ path: ["certificate"] }],
      });

      const wrongKey = await app.inject({
        method: "PUT",
        url: "/api/admin/edge/certificate",
        headers: headers("admin.console.write"),
        payload: { ...pem(), privateKeyPem: renewal.privateKeyPem },
      });
      expect(wrongKey.json()).toMatchObject({ issues: [{ path: ["privateKey"] }] });

      const empty = await app.inject({
        method: "PUT",
        url: "/api/admin/edge/certificate",
        headers: headers("admin.console.write"),
        payload: {},
      });
      expect(empty.statusCode).toBe(400);
      expect(store.stored).toBeNull();
      expect(audit).toEqual([]);
    });

    it("refuses changes where the deployment provides the certificate", async () => {
      const { app } = build(service({ deploymentSource: "files" }));

      for (const method of ["PUT", "DELETE"] as const) {
        const refused = await app.inject({
          method,
          url: "/api/admin/edge/certificate",
          headers: headers("admin.console.write"),
          ...(method === "PUT" ? { payload: pem() } : {}),
        });
        expect(refused.statusCode).toBe(409);
        expect(refused.json()).toMatchObject({ code: "conflict" });
      }
      expect(store.stored).toBeNull();
    });
  });
});
