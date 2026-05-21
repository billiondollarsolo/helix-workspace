/**
 * The connector model — the *real* external-connector plugin path.
 *
 * In the confirmed Helix architecture, the plugin SDK / loader is reserved for
 * **external connectors only**: integrations into other systems (MCP-style
 * tools, inbound/outbound webhooks). Core apps (mail, chat, drive, docs,
 * calendar, meet, assistant) are NOT plugins — they are toggleable platform
 * modules wired directly into the server.
 *
 * A connector is a `kind: "in-process"` plugin whose manifest declares the
 * `connector` category. It is discovered from `/plugins`, validated, loaded,
 * and started by {@link ../connectors/runtime.ts} at server startup. At least
 * one connector ships realized (the Slack outbound-webhook connector) to prove
 * the path end-to-end.
 *
 * Connectors contribute to two bounded extension points:
 *  - **outbound webhook formats** — render a Helix event into a third-party
 *    webhook payload (Slack, Discord, Teams, ...);
 *  - **inbound webhook sources** — verify + parse a third-party webhook.
 *
 * This keeps connectors genuinely loadable without exposing the full
 * monolith's internals.
 */

import type {
  OutboundWebhookEvent,
  RenderedWebhookRequest,
} from "../webhooks/formats/types.js";

/** The manifest category that marks a plugin as an external connector. */
export const CONNECTOR_MANIFEST_CATEGORY = "connector";

/** The manifest category that marks a first-party core-app placeholder. */
export const CORE_APP_MANIFEST_CATEGORY = "core-app";

/**
 * An outbound-webhook format contributed by a connector. Mirrors the platform's
 * own {@link ../webhooks/formats/types.ts WebhookFormatAdapter} so connector
 * formats slot into the same delivery path as the built-in ones.
 */
export interface ConnectorWebhookFormat {
  /** Stable id, e.g. `slack`. Used as the format key in webhook config. */
  readonly id: string;
  readonly render: (event: OutboundWebhookEvent) => RenderedWebhookRequest;
}

/** An inbound-webhook source contributed by a connector. */
export interface ConnectorWebhookSource {
  /** Stable id, e.g. `github`. */
  readonly id: string;
  /** Verify the signature of a received request; throw or return false to reject. */
  readonly verify: (input: {
    readonly headers: Readonly<Record<string, string>>;
    readonly rawBody: string;
    readonly secret: string;
  }) => boolean;
}

/**
 * The registration sink a connector receives in {@link ConnectorPlugin.register}.
 * Deliberately narrow — connectors get exactly the extension points the
 * connector category permits, nothing else.
 */
export interface ConnectorRegistrationSink {
  registerWebhookFormat(format: ConnectorWebhookFormat): void;
  registerWebhookSource(source: ConnectorWebhookSource): void;
}

/**
 * The default export shape of a connector plugin's entry module.
 * `register` is invoked once when the connector is started.
 */
export interface ConnectorPlugin {
  /** Optional id; cross-checked against the manifest when present. */
  readonly id?: string;
  register(sink: ConnectorRegistrationSink): void | Promise<void>;
}

export function isConnectorPlugin(value: unknown): value is ConnectorPlugin {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { register?: unknown }).register === "function"
  );
}
