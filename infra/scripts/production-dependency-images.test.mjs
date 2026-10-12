import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const dockerfiles = {
  ...Object.fromEntries(
    ["postgres", "nats", "meilisearch", "cerbos", "spamassassin", "clamav"].map((name) => [
      name,
      readFileSync(resolve(`infra/${name}/Dockerfile`), "utf8"),
    ]),
  ),
  "postgres-cnpg": readFileSync(resolve("infra/postgres/Dockerfile.cnpg"), "utf8"),
};
const spamassassinEntrypoint = readFileSync(resolve("infra/spamassassin/entrypoint.sh"), "utf8");
const dataPlaneFixture = readFileSync(resolve("infra/scripts/data-plane-live-fixture.mjs"), "utf8");
const workspaceDockerfile = readFileSync(resolve("infra/docker/Dockerfile"), "utf8");
const SHA256 = "[a-f0-9]{64}";
const COMMIT = "[a-f0-9]{40}";
describe("production dependency image build contracts", () => {
  it("pins the Dockerfile frontend and every external base or source image by digest", () => {
    for (const [name, dockerfile] of Object.entries(dockerfiles)) {
      expect(dockerfile, `${name} Dockerfile frontend`).toMatch(
        new RegExp(`^# syntax=docker/dockerfile:1\\.25\\.0@sha256:${SHA256}$`, "mu"),
      );
      for (const match of dockerfile.matchAll(/^ARG \S*(?:BASE|IMAGE)=([^\\s]+)$/gmu)) {
        expect(match[1], `${name} ${match[0]}`).toMatch(
          new RegExp(`^[^\\s]+@sha256:${SHA256}$`, "u"),
        );
      }
    }
  });
  it("builds source dependencies from immutable commits and checksum-verified archives", () => {
    for (const name of ["postgres", "postgres-cnpg", "nats", "cerbos"]) {
      const dockerfile = dockerfiles[name];
      expect(dockerfile, `${name} source commit`).toMatch(
        new RegExp(`^ARG \\S*_COMMIT=${COMMIT}$`, "mu"),
      );
      expect(dockerfile, `${name} archive checksum`).toMatch(
        new RegExp(`^ARG \\S*_ARCHIVE_SHA256=${SHA256}$`, "mu"),
      );
      expect(dockerfile, `${name} verified archive`).toContain("ADD --checksum=sha256:${");
    }
  });
  it("keeps patched security-sensitive dependency versions explicit", () => {
    expect(dockerfiles.postgres).toContain("go get golang.org/x/sys@v0.45.0");
    expect(dockerfiles.postgres).toContain(
      "PGVECTOR_COMMIT=159b79aaad5983fb7459c1e3df2897fbb2d11788",
    );
    expect(dockerfiles.nats).toContain("go get golang.org/x/crypto@v0.55.0");
    expect(dockerfiles.cerbos).toContain(
      "go get google.golang.org/grpc@v1.83.2 golang.org/x/net@v0.60.0",
    );
  });
  it("builds the CloudNativePG operand from the Compose PostgreSQL major and pgvector source", () => {
    const pinned = (dockerfile, name) =>
      new RegExp(`^ARG ${name}=(\\S+)$`, "mu").exec(dockerfile)?.[1];
    for (const name of ["PGVECTOR_COMMIT", "PGVECTOR_ARCHIVE_SHA256"]) {
      expect(pinned(dockerfiles["postgres-cnpg"], name), name).toBe(
        pinned(dockerfiles.postgres, name),
      );
    }
    const composeBase = pinned(dockerfiles.postgres, "POSTGRES_BASE");
    const cnpgBase = pinned(dockerfiles["postgres-cnpg"], "CNPG_POSTGRES_BASE");
    expect(composeBase).toMatch(/^postgres:18\.6-/u);
    expect(cnpgBase).toMatch(
      new RegExp(
        `^ghcr\\.io/cloudnative-pg/postgresql:18\\.6-minimal-trixie@sha256:${SHA256}$`,
        "u",
      ),
    );
    expect(dockerfiles["postgres-cnpg"]).toContain('"postgresql-server-dev-18=${server_version}"');
    expect(dockerfiles["postgres-cnpg"]).toMatch(/^USER 26$/mu);
  });
  it("pins data-plane validation clients to the production service lines", () => {
    expect(dataPlaneFixture).toContain("natsio/nats-box:0.19.7@sha256:");
    expect(dataPlaneFixture).toContain("postgres:18.6-alpine3.24@sha256:");
    expect(dataPlaneFixture).toContain("redis:8.10.2-alpine@sha256:");
    expect(dataPlaneFixture).not.toMatch(/(?:postgres|redis):(?:17|7)-alpine/u);
  });
  it("repackages Meilisearch into a minimal patched runtime from an immutable source image", () => {
    expect(dockerfiles.meilisearch).toContain("SOURCE_IMAGE=getmeili/meilisearch:v1.51.0@sha256:");
    expect(dockerfiles.meilisearch).toContain("RUNTIME_BASE=alpine:3.24.2@sha256:");
    expect(dockerfiles.meilisearch).toContain("COPY --from=source /bin/meilisearch");
    expect(dockerfiles.meilisearch).not.toContain("getmeili/meilisearch:v1.10");
  });
  it("installs the exact Alpine packages that close current high-severity advisories", () => {
    for (const dockerfile of [dockerfiles.nats, dockerfiles.meilisearch, workspaceDockerfile]) {
      expect(dockerfile).toContain("libcrypto3=3.5.9-r0");
      expect(dockerfile).toContain("libssl3=3.5.9-r0");
    }
    expect(dockerfiles.postgres).toContain("c-ares=1.34.8-r0");
  });
  it("bakes an integrity-checked Apache SpamAssassin ruleset and validates it", () => {
    expect(dockerfiles.spamassassin).toContain(
      "RULES_URL=https://downloads.apache.org/spamassassin/source/Mail-SpamAssassin-rules-4.0.2.r1928015.tgz",
    );
    expect(dockerfiles.spamassassin).toContain(
      "RULES_SHA256=f82128687117113dbe40bdc4e3141b87f96c2b01519c9022597da47e726a613e",
    );
    expect(dockerfiles.spamassassin).toContain("sha256sum -c -");
    expect(dockerfiles.spamassassin).toContain("sa-update");
    expect(dockerfiles.spamassassin).toContain("--install");
    expect(dockerfiles.spamassassin).toContain(
      "/var/lib/spamassassin/4.000002/updates_spamassassin_org/72_active.cf",
    );
    expect(dockerfiles.spamassassin).toContain(
      'ENTRYPOINT ["/usr/local/bin/helix-spamassassin-entrypoint"]',
    );
    expect(dockerfiles.spamassassin).toContain('CMD ["/init.sh"]');
    expect(spamassassinEntrypoint).toContain(
      'if [ ! -s "${active_rules}/updates_spamassassin_org/72_active.cf" ]',
    );
    expect(spamassassinEntrypoint).toContain('cp -a "${baked_rules}/." "${active_rules}/"');
    expect(dockerfiles.spamassassin).toContain("c-ares=1.34.8-r0");
  });
  it("rebuilds ClamAV on its pinned upstream image with patched pcre2", () => {
    expect(dockerfiles.clamav).toMatch(
      new RegExp(`^ARG SOURCE_IMAGE=clamav/clamav:1\\.5\\.4@sha256:${SHA256}$`, "mu"),
    );
    expect(dockerfiles.clamav).toContain("apk add --no-cache --upgrade pcre2=10.49-r0");
    expect(dockerfiles.clamav).not.toMatch(/^(?:ENTRYPOINT|CMD|USER) /mu);
  });
});
