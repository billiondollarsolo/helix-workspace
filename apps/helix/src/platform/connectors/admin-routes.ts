import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Actor } from "@helix/sdk";
import {
  canReadPlatformConfig,
  platformConfigAdminScopes,
} from "../config/admin.js";
import type { ConnectorLoadResult } from "./runtime.js";
import { manifestCategory } from "./runtime.js";

/**
 * Admin read API exposing which external connectors were genuinely loaded by
 * the connector runtime at startup. This makes the connector model verifiable:
 * operators can confirm a connector's `register` hook actually ran and which
 * extension points it contributed.
 */

export interface RegisterConnectorsAdminRouteOptions {
  readonly connectors: ConnectorLoadResult;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
}

export interface ConnectorAdminView {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly category: string;
  readonly kind: string;
  readonly provides: readonly string[];
}

export interface ConnectorsAdminStatus {
  readonly loaded: readonly ConnectorAdminView[];
  readonly webhookFormats: readonly string[];
  readonly webhookSources: readonly string[];
}

export function registerConnectorsAdminRoute(
  app: FastifyInstance,
  options: RegisterConnectorsAdminRouteOptions,
): void {
  app.get("/api/admin/connectors", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadPlatformConfig(actor)) {
      return reply
        .code(403)
        .send({ error: `Missing required scope: ${platformConfigAdminScopes.read}` });
    }
    const status: ConnectorsAdminStatus = {
      loaded: options.connectors.loaded.map((connector) => ({
        id: connector.manifest.id,
        name: connector.manifest.name,
        version: connector.manifest.version,
        category: manifestCategory(connector.manifest) ?? "connector",
        kind: connector.manifest.kind,
        provides: connector.manifest.capabilities.provides,
      })),
      webhookFormats: options.connectors.registry
        .webhookFormats()
        .map((format) => format.id),
      webhookSources: options.connectors.registry
        .webhookSources()
        .map((source) => source.id),
    };
    return status;
  });
}
