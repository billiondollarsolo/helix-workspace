#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  DATA_PLANE_EVIDENCE_SCHEMA,
  DATA_PLANE_SCENARIOS,
  assertNoSensitiveEvidence,
  createDataPlaneEvidenceSkeleton,
  validateDataPlaneEvidence,
} from "./data-plane-live-evidence-contract.mjs";
import {
  composeArgs,
  installPki,
  natsArgs,
  postgresRun,
  prepareSecrets,
  productionEnvironment,
  redisRun,
  requireFailure,
  requireSuccess,
  run,
  timedScenario,
  waitHealthy,
} from "./data-plane-live-fixture.mjs";

export {
  DATA_PLANE_EVIDENCE_SCHEMA,
  DATA_PLANE_SCENARIOS,
  assertNoSensitiveEvidence,
  createDataPlaneEvidenceSkeleton,
  validateDataPlaneEvidence,
};

function runLocalEvidence() {
  const evidence = createDataPlaneEvidenceSkeleton();
  evidence.mode = "local";
  evidence.status = "running";
  evidence.startedAt = new Date().toISOString();
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "helix-data-plane-smoke-"));
  const project = `helixdp${randomBytes(6).toString("hex")}`;
  const network = `${project}-data-plane`;
  const environment = productionEnvironment(temporaryDirectory, project);
  let stackStarted = false;

  try {
    const credentials = prepareSecrets(temporaryDirectory);
    requireSuccess(
      run("docker", composeArgs(project, "up", "-d", "--build", "postgres", "redis", "nats"), {
        env: environment,
        timeout: 600_000,
      }),
      "data-plane stack startup",
    );
    stackStarted = true;
    for (const service of ["postgres", "redis", "nats"]) {
      waitHealthy(environment, project, service);
    }

    timedScenario(evidence, "postgres_tls_only", () => {
      requireFailure(
        postgresRun(
          network,
          temporaryDirectory,
          credentials.appPassword,
          "disable",
          "helix_app",
          "select 1",
        ),
        "plaintext PostgreSQL connection",
      );
      requireSuccess(
        postgresRun(
          network,
          temporaryDirectory,
          credentials.appPassword,
          "verify-full",
          "helix_app",
          "select 1",
        ),
        "TLS PostgreSQL connection",
      );
    });

    timedScenario(evidence, "postgres_least_privilege_roles", () => {
      const role = requireSuccess(
        postgresRun(
          network,
          temporaryDirectory,
          credentials.appPassword,
          "verify-full",
          "helix_app",
          "select current_user || ':' || rolsuper::text || ':' || rolcreatedb::text || ':' || rolcreaterole::text from pg_roles where rolname = current_user",
        ),
        "application role inspection",
      ).trim();
      if (role !== "helix_app:false:false:false") {
        throw new Error("application PostgreSQL role is over-privileged");
      }
      requireFailure(
        postgresRun(
          network,
          temporaryDirectory,
          credentials.appPassword,
          "verify-full",
          "helix_app",
          "create table public.helix_data_plane_forbidden(id integer)",
        ),
        "application schema mutation",
      );
      requireSuccess(
        postgresRun(
          network,
          temporaryDirectory,
          credentials.migrationPassword,
          "verify-full",
          "helix_migrator",
          "create table public.helix_data_plane_smoke(id integer primary key)",
        ),
        "migration schema mutation",
      );
      requireSuccess(
        postgresRun(
          network,
          temporaryDirectory,
          credentials.appPassword,
          "verify-full",
          "helix_app",
          "insert into public.helix_data_plane_smoke values (1); select count(*) from public.helix_data_plane_smoke",
        ),
        "application DML",
      );
    });

    timedScenario(evidence, "redis_tls_only", () => {
      requireFailure(
        redisRun(network, temporaryDirectory, credentials.redisPassword, false, true),
        "plaintext Redis connection",
      );
      requireSuccess(
        redisRun(network, temporaryDirectory, credentials.redisPassword, true, true),
        "TLS Redis connection",
      );
    });

    timedScenario(evidence, "redis_authentication", () => {
      const denied = redisRun(network, temporaryDirectory, credentials.redisPassword, true, false);
      if (!/NOAUTH/iu.test(`${denied.stdout}\n${denied.stderr}`)) {
        throw new Error("unauthenticated Redis connection was not denied");
      }
      if (
        requireSuccess(
          redisRun(network, temporaryDirectory, credentials.redisPassword, true, true),
          "authenticated Redis connection",
        ).trim() !== "PONG"
      ) {
        throw new Error("authenticated Redis response was not PONG");
      }
    });

    timedScenario(evidence, "nats_mutual_tls", () => {
      requireFailure(
        run(
          "docker",
          natsArgs(
            network,
            temporaryDirectory,
            credentials.natsPassword,
            false,
            true,
            "pub",
            "helix.smoke",
            "probe",
          ),
        ),
        "NATS connection without client certificate",
      );
      requireSuccess(
        run(
          "docker",
          natsArgs(
            network,
            temporaryDirectory,
            credentials.natsPassword,
            true,
            true,
            "pub",
            "helix.smoke",
            "probe",
          ),
        ),
        "mutually authenticated NATS connection",
      );
    });

    timedScenario(evidence, "nats_authentication", () => {
      requireFailure(
        run(
          "docker",
          natsArgs(
            network,
            temporaryDirectory,
            credentials.natsPassword,
            true,
            false,
            "pub",
            "helix.smoke",
            "probe",
          ),
        ),
        "NATS connection without application authentication",
      );
    });

    timedScenario(evidence, "nats_subject_permissions", () => {
      requireSuccess(
        run(
          "docker",
          natsArgs(
            network,
            temporaryDirectory,
            credentials.natsPassword,
            true,
            true,
            "pub",
            "helix.smoke",
            "probe",
          ),
        ),
        "authorized NATS publish",
      );
      requireFailure(
        run(
          "docker",
          natsArgs(
            network,
            temporaryDirectory,
            credentials.natsPassword,
            true,
            true,
            "pub",
            "outside.smoke",
            "probe",
          ),
        ),
        "unauthorized NATS publish",
      );
    });

    timedScenario(evidence, "certificate_rotation", () => {
      const oldCa = join(temporaryDirectory, "old-ca.pem");
      copyFileSync(credentials.ca, oldCa);
      installPki(temporaryDirectory, "rotated");
      requireSuccess(
        run("docker", composeArgs(project, "restart", "postgres", "redis", "nats"), {
          env: environment,
          timeout: 180_000,
        }),
        "data-plane certificate rotation restart",
      );
      for (const service of ["postgres", "redis", "nats"]) {
        waitHealthy(environment, project, service);
      }
      requireSuccess(
        postgresRun(
          network,
          temporaryDirectory,
          credentials.appPassword,
          "verify-full",
          "helix_app",
          "select 1",
        ),
        "PostgreSQL after certificate rotation",
      );
      requireSuccess(
        redisRun(network, temporaryDirectory, credentials.redisPassword, true, true),
        "Redis after certificate rotation",
      );
      requireSuccess(
        run(
          "docker",
          natsArgs(
            network,
            temporaryDirectory,
            credentials.natsPassword,
            true,
            true,
            "pub",
            "helix.smoke",
            "rotated",
          ),
        ),
        "NATS after certificate rotation",
      );

      copyFileSync(oldCa, join(temporaryDirectory, "postgres_ca"));
      requireFailure(
        postgresRun(
          network,
          temporaryDirectory,
          credentials.appPassword,
          "verify-full",
          "helix_app",
          "select 1",
        ),
        "PostgreSQL connection using retired CA",
      );
    });

    evidence.status = "passed";
    evidence.completedAt = new Date().toISOString();
    return validateDataPlaneEvidence(evidence, true);
  } catch (error) {
    evidence.status = "failed";
    evidence.completedAt = new Date().toISOString();
    evidence.failure = { code: "data_plane_live_smoke_failed" };
    for (const scenario of DATA_PLANE_SCENARIOS) {
      if (evidence.scenarios[scenario]?.status === "not_run") {
        evidence.scenarios[scenario] = {
          status: "not_run",
          reason: "live run aborted before this scenario was evidenced",
        };
      }
    }
    validateDataPlaneEvidence(evidence);
    throw Object.assign(error instanceof Error ? error : new Error("data-plane smoke failed"), {
      evidence,
    });
  } finally {
    if (stackStarted) {
      run("docker", composeArgs(project, "down", "--volumes", "--remove-orphans"), {
        env: environment,
        timeout: 180_000,
      });
    }
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function emit(evidence) {
  const output = `${JSON.stringify(evidence, null, 2)}\n`;
  if (process.env.HELIX_DATA_PLANE_EVIDENCE_OUTPUT !== undefined) {
    writeFileSync(process.env.HELIX_DATA_PLANE_EVIDENCE_OUTPUT, output, "utf8");
  }
  process.stdout.write(output);
}

async function main(argv = process.argv.slice(2)) {
  const args = argv.filter((argument) => argument !== "--");
  if (args.length !== 1 || !["--static", "--local"].includes(args[0])) {
    throw new Error("usage: data-plane-live-evidence.mjs --static|--local");
  }
  if (args[0] === "--static") {
    emit(validateDataPlaneEvidence(createDataPlaneEvidenceSkeleton()));
    return;
  }
  try {
    emit(runLocalEvidence());
  } catch (error) {
    const evidence = error?.evidence ?? createDataPlaneEvidenceSkeleton();
    emit(evidence);
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
