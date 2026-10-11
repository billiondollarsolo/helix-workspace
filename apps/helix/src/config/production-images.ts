import type { ProductionConfigurationIssue } from "./production-assertions.js";

const PRODUCTION_IMAGE_REPOSITORIES = {
  HELIX_IMAGE: "ghcr.io/billiondollarsolo/helix-workspace",
  HELIX_WEB_IMAGE: "ghcr.io/billiondollarsolo/helix-workspace-web",
  HELIX_POSTGRES_IMAGE: "ghcr.io/billiondollarsolo/helix-workspace-postgres",
  HELIX_NATS_IMAGE: "ghcr.io/billiondollarsolo/helix-workspace-nats",
  HELIX_MEILISEARCH_IMAGE: "ghcr.io/billiondollarsolo/helix-workspace-meilisearch",
  HELIX_CERBOS_IMAGE: "ghcr.io/billiondollarsolo/helix-workspace-cerbos",
  HELIX_SPAMD_IMAGE: "ghcr.io/billiondollarsolo/helix-workspace-spamassassin",
  HELIX_CLAMAV_IMAGE: "ghcr.io/billiondollarsolo/helix-workspace-clamav",
} as const;
/**
 * Application images a Helm release may run: the official build and the
 * sovereign FIPS build (chart `image.repository` / `fips.imageRepository`).
 */
const HELM_APPLICATION_IMAGE_REPOSITORIES = [
  "ghcr.io/billiondollarsolo/helix-workspace",
  "ghcr.io/billiondollarsolo/helix-workspace-fips",
] as const;
const DEPLOYMENT_KINDS = ["compose", "helm"] as const;
export type ProductionDeploymentConfiguration = {
  readonly NODE_ENV?: string | undefined;
  readonly HELIX_WORKSPACE_PROFILE?: string | undefined;
  readonly HELIX_DEPLOYMENT_KIND?: string | undefined;
} & { readonly [K in keyof typeof PRODUCTION_IMAGE_REPOSITORIES]?: string | undefined };
function normalized(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result === undefined || result.length === 0 ? undefined : result;
}
function pinnedImageIssue(
  variable: string,
  imageReference: string | undefined,
  repositories: readonly string[],
): ProductionConfigurationIssue | undefined {
  const pinned = repositories.some((repository) => {
    const expectedPrefix = `${repository}@sha256:`;
    return (
      imageReference?.startsWith(expectedPrefix) === true &&
      /^[a-f0-9]{64}$/u.test(imageReference.slice(expectedPrefix.length))
    );
  });
  return pinned
    ? undefined
    : {
        variable,
        message: `must be the promoted ${repositories.join(" or ")} image pinned by an immutable sha256 digest`,
      };
}
/**
 * Every image a deployment actually runs must be pinned by digest to an
 * approved repository. Compose runs the full eight-image stack; a Helm release
 * runs only the application image (dependencies are external services or the
 * chart-validated CloudNativePG operand), so it pins HELIX_IMAGE and any other
 * image variable it chooses to set.
 */
export function validateProductionDeploymentConfiguration(
  environment: ProductionDeploymentConfiguration,
  issues: ProductionConfigurationIssue[],
): void {
  const kind = normalized(environment.HELIX_DEPLOYMENT_KIND)?.toLowerCase();
  if (kind !== "compose" && kind !== "helm") {
    issues.push({
      variable: "HELIX_DEPLOYMENT_KIND",
      message: `must be ${DEPLOYMENT_KINDS.join(" or ")}; docker-compose.production.yml and the Helm chart set it, so set it explicitly only for another deployment method`,
    });
    return;
  }
  for (const [variable, repository] of Object.entries(PRODUCTION_IMAGE_REPOSITORIES)) {
    const imageReference = normalized(
      environment[variable as keyof typeof PRODUCTION_IMAGE_REPOSITORIES],
    );
    if (kind === "helm" && variable !== "HELIX_IMAGE" && imageReference === undefined) {
      continue;
    }
    const repositories =
      kind === "helm" && variable === "HELIX_IMAGE"
        ? HELM_APPLICATION_IMAGE_REPOSITORIES
        : [repository];
    const issue = pinnedImageIssue(variable, imageReference, repositories);
    if (issue !== undefined) {
      issues.push(issue);
    }
  }
}
