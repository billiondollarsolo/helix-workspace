import { describe, expect, it } from "vitest";
import {
  assertProductionDeploymentConfiguration,
  ProductionConfigurationError,
} from "./production-assertions.js";

describe("deployment-aware production image pinning", () => {
  const digest = (character: string) => `@sha256:${character.repeat(64)}`;
  const composeImages = {
    HELIX_IMAGE: `ghcr.io/billiondollarsolo/helix-workspace${digest("a")}`,
    HELIX_WEB_IMAGE: `ghcr.io/billiondollarsolo/helix-workspace-web${digest("b")}`,
    HELIX_POSTGRES_IMAGE: `ghcr.io/billiondollarsolo/helix-workspace-postgres${digest("c")}`,
    HELIX_NATS_IMAGE: `ghcr.io/billiondollarsolo/helix-workspace-nats${digest("d")}`,
    HELIX_MEILISEARCH_IMAGE: `ghcr.io/billiondollarsolo/helix-workspace-meilisearch${digest("e")}`,
    HELIX_CERBOS_IMAGE: `ghcr.io/billiondollarsolo/helix-workspace-cerbos${digest("f")}`,
    HELIX_SPAMD_IMAGE: `ghcr.io/billiondollarsolo/helix-workspace-spamassassin${digest("1")}`,
    HELIX_CLAMAV_IMAGE: `ghcr.io/billiondollarsolo/helix-workspace-clamav${digest("2")}`,
  };
  function issues(environment: Record<string, string | undefined>): string[] {
    try {
      assertProductionDeploymentConfiguration({ NODE_ENV: "production", ...environment });
      return [];
    } catch (error) {
      expect(error).toBeInstanceOf(ProductionConfigurationError);
      return (error as ProductionConfigurationError).issues.map((issue) => issue.variable);
    }
  }

  it("requires all eight pinned images for Compose", () => {
    expect(issues({ HELIX_DEPLOYMENT_KIND: "compose", ...composeImages })).toEqual([]);
    for (const variable of Object.keys(composeImages)) {
      expect(
        issues({ HELIX_DEPLOYMENT_KIND: "compose", ...composeImages, [variable]: undefined }),
      ).toEqual([variable]);
    }
  });

  it("requires only the deployed application image for Helm", () => {
    expect(
      issues({ HELIX_DEPLOYMENT_KIND: "helm", HELIX_IMAGE: composeImages.HELIX_IMAGE }),
    ).toEqual([]);
    expect(
      issues({
        HELIX_DEPLOYMENT_KIND: "helm",
        HELIX_IMAGE: `ghcr.io/billiondollarsolo/helix-workspace-fips${digest("9")}`,
      }),
    ).toEqual([]);
    expect(issues({ HELIX_DEPLOYMENT_KIND: "helm" })).toEqual(["HELIX_IMAGE"]);
    // An image variable a Helm release does set must still be pinned.
    expect(
      issues({
        HELIX_DEPLOYMENT_KIND: "helm",
        HELIX_IMAGE: composeImages.HELIX_IMAGE,
        HELIX_POSTGRES_IMAGE: "ghcr.io/billiondollarsolo/helix-workspace-postgres:latest",
      }),
    ).toEqual(["HELIX_POSTGRES_IMAGE"]);
  });

  it.each([undefined, "", "kubernetes", "nomad"])(
    "fails closed for a missing or unknown deployment kind (%s)",
    (kind) => {
      expect(issues({ HELIX_DEPLOYMENT_KIND: kind, ...composeImages })).toEqual([
        "HELIX_DEPLOYMENT_KIND",
      ]);
    },
  );

  it.each([
    ["ghcr.io/helix/helix", "compose"],
    ["ghcr.io/helix/helix", "helm"],
    ["registry.example.internal/helix/helix-fips", "helm"],
    ["ghcr.io/attacker/helix-workspace", "helm"],
  ])("rejects the non-approved repository %s for %s", (repository, kind) => {
    expect(
      issues({
        HELIX_DEPLOYMENT_KIND: kind,
        ...composeImages,
        HELIX_IMAGE: `${repository}${digest("a")}`,
      }),
    ).toEqual(["HELIX_IMAGE"]);
  });

  it("does not apply outside production", () => {
    expect(() => {
      assertProductionDeploymentConfiguration({ NODE_ENV: "development" });
    }).not.toThrow();
  });
});
