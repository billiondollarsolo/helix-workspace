import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import type { env } from "../config/env.js";
import type { AdminConsoleAuditSink } from "../platform/admin/console-shared.js";
import {
  CaddyEdgeTarget,
  EdgeCertificateReconciler,
  EdgeCertificateService,
  PostgresEdgeCertificateStore,
  probeServedCertificate,
  registerEdgeCertificateAdminRoutes,
  type EdgeTlsDeploymentSource,
} from "../platform/edge/index.js";
import type { SupervisedWorker } from "../platform/leader/election.js";
import type { TenantEnvelopeCipher } from "../platform/secrets/envelope.js";
import {
  detachedFromTenantPostgresContext,
  withTenantPostgresContext,
} from "../platform/tenancy/postgres-roles.js";

/** The edge's `tls` setting: empty or `automatic`, `internal`, or file paths. */
function deploymentSource(value: string | undefined): EdgeTlsDeploymentSource {
  const source = value?.trim() ?? "";
  if (source === "" || source === "automatic") return "automatic";
  return source === "internal" ? "internal" : "files";
}

/**
 * Admin → Domains → HTTPS certificate. The routes always exist so the console
 * can say where the certificate comes from; uploading needs an edge that
 * shares its certificate folder and admin socket with Helix, which the
 * production Compose stack provides.
 */
export function installEdgeCertificateManagement(input: {
  readonly app: FastifyInstance;
  readonly sql: postgres.Sql;
  readonly bootEnv: ReturnType<typeof env>;
  readonly cipher: TenantEnvelopeCipher;
  readonly auditSink: AdminConsoleAuditSink;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly defaultOrgId: string;
  readonly leaderGatedWorkers: { readonly name: string; readonly worker: SupervisedWorker }[];
}): void {
  const { app, sql, bootEnv } = input;
  const publicUrl = bootEnv.HELIX_PUBLIC_URL ?? bootEnv.PUBLIC_BASE_URL ?? bootEnv.BETTER_AUTH_URL;
  if (publicUrl === undefined) return;
  const hostname = new URL(publicUrl).hostname;
  const directory = bootEnv.HELIX_EDGE_CERT_DIR;
  const adminSocketPath = bootEnv.HELIX_EDGE_ADMIN_SOCKET;
  const [probeHost, probePort] = (bootEnv.HELIX_EDGE_PROBE_ADDRESS ?? `${hostname}:443`).split(":");

  const service = new EdgeCertificateService({
    hostname,
    deploymentSource: deploymentSource(bootEnv.HELIX_EDGE_TLS_SOURCE),
    singleTenant: bootEnv.HELIX_MODE === "single-tenant",
    store: new PostgresEdgeCertificateStore(sql, input.cipher),
    target:
      directory === undefined || adminSocketPath === undefined
        ? null
        : // Both containers mount the certificate volume at the same path.
          new CaddyEdgeTarget({ directory, edgeDirectory: directory, adminSocketPath }),
    probe: () =>
      probeServedCertificate({
        host: probeHost ?? hostname,
        port: Number(probePort ?? 443),
        servername: hostname,
      }),
    inOrganization: (orgId, work) =>
      detachedFromTenantPostgresContext(() => withTenantPostgresContext(sql, { orgId }, work)),
    onError: (error) => {
      app.log.error({ error }, "Could not hand the HTTPS certificate to the edge");
    },
  });

  registerEdgeCertificateAdminRoutes(app, {
    service,
    actorFromRequest: input.actorFromRequest,
    auditSink: input.auditSink,
  });

  input.leaderGatedWorkers.push({
    name: "edge-certificate-reconciler",
    worker: new EdgeCertificateReconciler({
      service: {
        apply: (orgId) => service.apply(orgId),
        status: (orgId) =>
          detachedFromTenantPostgresContext(() =>
            withTenantPostgresContext(sql, { orgId }, () => service.status(orgId)),
          ),
        manageable: service.manageable,
      },
      orgId: input.defaultOrgId,
      onReloaded: () => {
        app.log.info({ address: hostname }, "The edge reloaded its HTTPS certificate");
      },
      onExpiring: ({ days }) => {
        app.log.warn(
          { address: hostname, days },
          days < 0
            ? "The uploaded HTTPS certificate has expired. Upload its renewal in Admin → Domains."
            : "The uploaded HTTPS certificate expires soon. Upload its renewal in Admin → Domains.",
        );
      },
      onError: (error) => {
        app.log.error({ error }, "HTTPS certificate reconciliation failed");
      },
    }),
  });
}
