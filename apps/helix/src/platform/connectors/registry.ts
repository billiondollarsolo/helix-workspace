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
  private currentConnectorId: string | undefined;
  private readonly formatOwners = new Map<string, string>();
  private readonly sourceOwners = new Map<string, string>();

  /** Scope subsequent registrations to a connector id (for ownership tracking). */
  beginConnector(connectorId: string): void {
    this.currentConnectorId = connectorId;
  }

  endConnector(): void {
    this.currentConnectorId = undefined;
  }

  registerWebhookFormat(format: ConnectorWebhookFormat): void {
    if (this.formats.has(format.id)) {
      throw new Error(
        `Connector webhook format "${format.id}" already registered by ${
          this.formatOwners.get(format.id) ?? "unknown"
        }`,
      );
    }
    this.formats.set(format.id, format);
    if (this.currentConnectorId !== undefined) {
      this.formatOwners.set(format.id, this.currentConnectorId);
    }
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
    if (this.currentConnectorId !== undefined) {
      this.sourceOwners.set(source.id, this.currentConnectorId);
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
}
