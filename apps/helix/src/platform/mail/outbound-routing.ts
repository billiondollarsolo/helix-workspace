import type { JsonObject } from "@helix/sdk-types";
import { normalizeMailDomain } from "./address-normalization.js";
import type {
  CreateOutboundProviderInput,
  CreateSendingDomainInput,
  MailSendingDomainRecord,
  OutboundProviderStore,
  SendingDomainStore,
  UpdateOutboundProviderInput,
} from "./admin-store.js";
import { MailProviderConfigurationError } from "./errors.js";
import {
  ProviderMailTransport,
  createOutboundMailProvider,
  type FetchLike,
  type OutboundMailProviderKind,
  type OutboundProviderConfig,
} from "./providers.js";
import type { OutboundMailTransport } from "./outbound.js";

export type OutboundProviderDecisionSource = "sending_domain" | "org_default" | "environment";

export interface ResolvedOutboundTransport {
  readonly transport: OutboundMailTransport;
  readonly providerId: string;
  readonly providerKind: string;
  readonly source: OutboundProviderDecisionSource;
  readonly fromDomain: string;
}

export type OutboundTransportFor = (
  orgId: string,
  fromDomain: string,
  lockedProviderId?: string | null,
) => Promise<ResolvedOutboundTransport>;

/** Secret values are fetched for each dispatch call and are never cached. */
export interface MailSecretProvider {
  resolveSecret(ref: string): Promise<string | undefined>;
}

export interface ManagedEnvironmentMailProvider {
  readonly id: string;
  readonly kind: OutboundMailProviderKind;
  /** Must be an established API/SMTP relay. Direct-to-MX is never permitted. */
  readonly managed: true;
  buildTransport(): Promise<OutboundMailTransport>;
}

export interface DispatchTimeTransportResolverOptions {
  readonly providerStore: OutboundProviderStore;
  readonly domainStore: SendingDomainStore;
  readonly secrets: MailSecretProvider;
  readonly environmentFallback?: ManagedEnvironmentMailProvider;
  readonly fetch?: FetchLike;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

interface OrgRoutingSnapshot {
  readonly expiresAt: number;
  readonly providers: readonly OutboundProviderConfig[];
  readonly domains: readonly MailSendingDomainRecord[];
}

/**
 * Resolves provider configuration at dispatch time.
 *
 * Only non-secret rows are cached. Explicit invalidation is used by the admin
 * store decorators below; the short TTL is a second line of defence.
 */
export class DispatchTimeTransportResolver {
  readonly #cache = new Map<string, OrgRoutingSnapshot>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(private readonly options: DispatchTimeTransportResolverOptions) {
    this.#ttlMs = options.cacheTtlMs ?? 15_000;
    this.#now = options.now ?? Date.now;
  }

  readonly transportFor: OutboundTransportFor = async (orgId, rawFromDomain, lockedProviderId) => {
    const fromDomain = normalizeMailDomain(rawFromDomain);
    const snapshot = await this.#snapshot(orgId);

    if (lockedProviderId !== undefined && lockedProviderId !== null) {
      if (lockedProviderId.startsWith("environment:")) {
        return this.#environmentDecision(fromDomain, lockedProviderId);
      }
      const locked = snapshot.providers.find((provider) => provider.id === lockedProviderId);
      if (locked === undefined || !locked.enabled) {
        throw new MailProviderConfigurationError(
          "MAIL_PROVIDER_DISABLED",
          `The provider bound to this queued message is disabled or no longer available.`,
        );
      }
      return this.#providerDecision(
        locked,
        fromDomain,
        this.#sourceFor(snapshot, locked, fromDomain),
      );
    }

    const domain = snapshot.domains.find(
      (candidate) => normalizeMailDomain(candidate.domain) === fromDomain,
    );
    if (domain !== undefined && domain.verifiedAt !== null && domain.providerId !== null) {
      const dedicated = snapshot.providers.find((provider) => provider.id === domain.providerId);
      if (dedicated === undefined || !dedicated.enabled) {
        throw new MailProviderConfigurationError(
          "MAIL_PROVIDER_DISABLED",
          `The dedicated provider for ${fromDomain} is disabled or unavailable.`,
        );
      }
      return this.#providerDecision(dedicated, fromDomain, "sending_domain");
    }

    const configuredDefault = snapshot.providers.find((provider) => provider.isDefault);
    if (configuredDefault !== undefined) {
      if (!configuredDefault.enabled) {
        throw new MailProviderConfigurationError(
          "MAIL_PROVIDER_DISABLED",
          `The organization's default outbound provider is disabled.`,
        );
      }
      return this.#providerDecision(configuredDefault, fromDomain, "org_default");
    }

    if (this.options.environmentFallback !== undefined) {
      return this.#environmentDecision(
        fromDomain,
        `environment:${this.options.environmentFallback.id}`,
      );
    }
    throw new MailProviderConfigurationError(
      "MAIL_PROVIDER_NOT_CONFIGURED",
      `No managed outbound provider is configured for organization ${orgId} and domain ${fromDomain}.`,
    );
  };

  invalidateOrg(orgId: string): void {
    this.#cache.delete(orgId);
  }

  clear(): void {
    this.#cache.clear();
  }

  async #snapshot(orgId: string): Promise<OrgRoutingSnapshot> {
    const cached = this.#cache.get(orgId);
    if (cached !== undefined && cached.expiresAt > this.#now()) {
      return cached;
    }
    const [providers, domains] = await Promise.all([
      this.options.providerStore.listProviders(orgId),
      this.options.domainStore.listDomains(orgId),
    ]);
    const snapshot = { providers, domains, expiresAt: this.#now() + this.#ttlMs };
    this.#cache.set(orgId, snapshot);
    return snapshot;
  }

  async #providerDecision(
    config: OutboundProviderConfig,
    fromDomain: string,
    source: Exclude<OutboundProviderDecisionSource, "environment">,
  ): Promise<ResolvedOutboundTransport> {
    const secret =
      config.secretRef === null
        ? undefined
        : await this.options.secrets.resolveSecret(config.secretRef);
    const provider = createOutboundMailProvider(
      config,
      (ref) => (ref === config.secretRef ? secret : undefined),
      this.options.fetch === undefined ? {} : { fetch: this.options.fetch },
    );
    return {
      transport: new ProviderMailTransport(provider),
      providerId: config.id,
      providerKind: config.kind,
      source,
      fromDomain,
    };
  }

  async #environmentDecision(
    fromDomain: string,
    expectedId: string,
  ): Promise<ResolvedOutboundTransport> {
    const fallback = this.options.environmentFallback;
    if (fallback === undefined || expectedId !== `environment:${fallback.id}`) {
      throw new MailProviderConfigurationError(
        "MAIL_PROVIDER_DISABLED",
        `The environment provider bound to this queued message is unavailable.`,
      );
    }
    return {
      transport: await fallback.buildTransport(),
      providerId: expectedId,
      providerKind: fallback.kind,
      source: "environment",
      fromDomain,
    };
  }

  #sourceFor(
    snapshot: OrgRoutingSnapshot,
    provider: OutboundProviderConfig,
    fromDomain: string,
  ): Exclude<OutboundProviderDecisionSource, "environment"> {
    const domain = snapshot.domains.find(
      (candidate) =>
        normalizeMailDomain(candidate.domain) === fromDomain &&
        candidate.verifiedAt !== null &&
        candidate.providerId === provider.id,
    );
    return domain === undefined ? "org_default" : "sending_domain";
  }
}

/**
 * Decorate admin stores so successful provider/domain mutations immediately
 * evict their organization's routing snapshot.
 */
export function withOutboundRoutingInvalidation(
  providerStore: OutboundProviderStore,
  domainStore: SendingDomainStore,
  invalidateOrg: (orgId: string) => void,
): {
  readonly providerStore: OutboundProviderStore;
  readonly domainStore: SendingDomainStore;
} {
  return {
    providerStore: {
      listProviders: (orgId) => providerStore.listProviders(orgId),
      getProvider: (orgId, id) => providerStore.getProvider(orgId, id),
      getDefaultProvider: (orgId) => providerStore.getDefaultProvider(orgId),
      createProvider: async (input: CreateOutboundProviderInput) => {
        const result = await providerStore.createProvider(input);
        invalidateOrg(input.orgId);
        return result;
      },
      updateProvider: async (input: UpdateOutboundProviderInput) => {
        const result = await providerStore.updateProvider(input);
        if (result !== null) invalidateOrg(input.orgId);
        return result;
      },
      deleteProvider: async (orgId, id) => {
        const result = await providerStore.deleteProvider(orgId, id);
        if (result) invalidateOrg(orgId);
        return result;
      },
    },
    domainStore: {
      listDomains: (orgId) => domainStore.listDomains(orgId),
      getDomain: (orgId, id) => domainStore.getDomain(orgId, id),
      createDomain: async (input: CreateSendingDomainInput) => {
        const result = await domainStore.createDomain(input);
        invalidateOrg(input.orgId);
        return result;
      },
      setDomainVerified: async (orgId, id, verified) => {
        const result = await domainStore.setDomainVerified(orgId, id, verified);
        if (result !== null) invalidateOrg(orgId);
        return result;
      },
      deleteDomain: async (orgId, id) => {
        const result = await domainStore.deleteDomain(orgId, id);
        if (result) invalidateOrg(orgId);
        return result;
      },
    },
  };
}

/** Safe metadata stored with attempts; it intentionally excludes config and secrets. */
export function providerDecisionMetadata(
  decision: Pick<
    ResolvedOutboundTransport,
    "providerId" | "providerKind" | "source" | "fromDomain"
  >,
): JsonObject {
  return {
    providerId: decision.providerId,
    providerKind: decision.providerKind,
    providerDecisionSource: decision.source,
    fromDomain: decision.fromDomain,
  };
}
