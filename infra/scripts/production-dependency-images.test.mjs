import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dockerfiles = Object.fromEntries(
  ["postgres", "nats", "meilisearch", "cerbos", "spamassassin"].map((name) => [
    name,
    readFileSync(resolve(`infra/${name}/Dockerfile`), "utf8"),
  ]),
);
const spamassassinEntrypoint = readFileSync(resolve("infra/spamassassin/entrypoint.sh"), "utf8");

const SHA256 = "[a-f0-9]{64}";
const COMMIT = "[a-f0-9]{40}";

describe("production dependency image build contracts", () => {
  it("pins the Dockerfile frontend and every external base or source image by digest", () => {
    for (const [name, dockerfile] of Object.entries(dockerfiles)) {
      expect(dockerfile, `${name} Dockerfile frontend`).toMatch(
        new RegExp(`^# syntax=docker/dockerfile:1\\.7@sha256:${SHA256}$`, "mu"),
      );

      for (const match of dockerfile.matchAll(/^ARG \S*(?:BASE|IMAGE)=([^\\s]+)$/gmu)) {
        expect(match[1], `${name} ${match[0]}`).toMatch(
          new RegExp(`^[^\\s]+@sha256:${SHA256}$`, "u"),
        );
      }
    }
  });

  it("builds source dependencies from immutable commits and checksum-verified archives", () => {
    for (const name of ["postgres", "nats", "cerbos"]) {
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
      "PGVECTOR_COMMIT=778dacf20c07caf904557a88705142631818d8cb",
    );
    expect(dockerfiles.nats).toContain("go get golang.org/x/crypto@v0.52.0");
    expect(dockerfiles.cerbos).toContain("go get google.golang.org/grpc@v1.82.1");
  });

  it("repackages Meilisearch into a minimal patched runtime from an immutable source image", () => {
    expect(dockerfiles.meilisearch).toContain("SOURCE_IMAGE=getmeili/meilisearch:v1.45.1@sha256:");
    expect(dockerfiles.meilisearch).toContain("RUNTIME_BASE=alpine:3.23.5@sha256:");
    expect(dockerfiles.meilisearch).toContain("COPY --from=source /bin/meilisearch");
    expect(dockerfiles.meilisearch).not.toContain("getmeili/meilisearch:v1.10");
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
});
