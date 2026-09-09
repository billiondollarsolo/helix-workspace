import type {
  ConnectorRegistrationSink,
  ConnectorWebhookFormat,
  ConnectorWebhookSource,
} from "./types.js";

/**
 * Collects everything connectors contribute. The runtime hands a registry to
 * each connector's `register` hook; the server then reads the merged result.
 */
export class ConnectorRegistry implements ConnectorRegistrationSink {
  private readonly formats = new Map<string, ConnectorWebhookFormat>();
  private readonly sources = new Map<string, ConnectorWebhookSource>();
  private readonly formatOwners = new Map<string, string>();
  private readonly sourceOwners = new Map<string, string>();

  registerWebhookFormat(format: ConnectorWebhookFormat): void {
    if (this.formats.has(format.id)) {
      throw new Error(
        `Connector webhook format "${format.id}" already registered by ${
          this.formatOwners.get(format.id) ?? "unknown"
        }`,
      );
    }
    this.formats.set(format.id, format);
  }

  registerWebhookSource(source: ConnectorWebhookSource): void {
    if (this.sources.has(source.id)) {
      throw new Error(
        `Connector webhook source "${source.id}" already registered by ${
          this.sourceOwners.get(source.id) ?? "unknown"
        }`,
      );
    }
    this.sources.set(source.id, source);
  }

  replaceConnector(
    connectorId: string,
    formats: readonly ConnectorWebhookFormat[],
    sources: readonly ConnectorWebhookSource[],
  ): void {
    this.assertConnectorAvailable(connectorId, formats, sources);
    this.removeConnector(connectorId);
    for (const format of formats) {
      this.formats.set(format.id, format);
      this.formatOwners.set(format.id, connectorId);
    }
    for (const source of sources) {
      this.sources.set(source.id, source);
      this.sourceOwners.set(source.id, connectorId);
    }
  }

  assertConnectorAvailable(
    connectorId: string,
    formats: readonly ConnectorWebhookFormat[],
    sources: readonly ConnectorWebhookSource[],
  ): void {
    for (const format of formats) {
      this.assertOwner(this.formats, this.formatOwners, format.id, connectorId);
    }
    for (const source of sources) {
      this.assertOwner(this.sources, this.sourceOwners, source.id, connectorId);
    }
  }

  removeConnector(connectorId: string): void {
    for (const [id, owner] of this.formatOwners) {
      if (owner === connectorId) {
        this.formats.delete(id);
        this.formatOwners.delete(id);
      }
    }
    for (const [id, owner] of this.sourceOwners) {
      if (owner === connectorId) {
        this.sources.delete(id);
        this.sourceOwners.delete(id);
      }
    }
  }

  getWebhookFormat(id: string): ConnectorWebhookFormat | undefined {
    return this.formats.get(id);
  }

  getWebhookSource(id: string): ConnectorWebhookSource | undefined {
    return this.sources.get(id);
  }

  webhookFormats(): readonly ConnectorWebhookFormat[] {
    return [...this.formats.values()];
  }

  webhookSources(): readonly ConnectorWebhookSource[] {
    return [...this.sources.values()];
  }

  private assertOwner(
    values: ReadonlyMap<string, unknown>,
    owners: ReadonlyMap<string, string>,
    id: string,
    connectorId: string,
  ): void {
    const owner = owners.get(id);
    if (owner !== undefined && owner !== connectorId) {
      throw new Error(`Connector hook "${id}" is already registered by ${owner}`);
    }
    if (owner === undefined && values.has(id)) {
      throw new Error(`Connector hook "${id}" is already registered by the platform`);
    }
  }
}
