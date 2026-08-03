import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod3";
import type { Actor } from "@helix/sdk";
import {
  canReadPlatformConfig,
  canWritePlatformConfig,
  platformConfigAdminScopes,
  type PlatformConfigAdminService,
} from "../config/admin.js";
import {
  CORE_APPS,
  isCoreAppEnabled,
  isCoreAppId,
  resolveCoreAppStatuses,
  type CoreAppId,
} from "./core-apps.js";

/**
 * Admin API for org-wide core-app enablement.
 *
 * Core apps are toggleable platform modules. An org admin can enable/disable
 * any core app globally (default: all enabled). Enablement is stored as
 * `config.modules[appId].enabled` and flows through the same platform-config
 * store + NATS hot-reload path as the rest of platform config.
 *
 * Note: a toggle takes full effect on the next deploy/restart, since modules
 * are registered (routes/tools/workers) at startup. The response advertises
 * `effective` so the admin UI can show "pending restart" where the running
 * registration differs from the newly-saved config.
 */

export interface RegisterCoreAppsAdminRoutesOptions {
  readonly service: PlatformConfigAdminService;
  /** The role this process booted as (informational, for the admin UI). */
  readonly role: string;
  /**
   * The app set this process booted with — `CoreAppRegistrationPlan.appIds`.
   *
   * Required, not optional: `role` is a display string, and deriving `inRole`
   * from it threw for every process that set `HELIX_APPS` (role `"custom"`).
   */
  readonly appIds: ReadonlySet<CoreAppId>;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
}

const coreAppToggleSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export interface CoreAppAdminView {
  readonly id: CoreAppId;
  readonly name: string;
  readonly description: string;
  /** The org-wide enablement saved in config (default true). */
  readonly enabled: boolean;
  /** True if this process's booting role runs this app. */
  readonly inRole: boolean;
  /** True iff `enabled && inRole` — the app is actually served by this process. */
  readonly registered: boolean;
}

export interface CoreAppsAdminStatus {
  readonly role: string;
  readonly apps: readonly CoreAppAdminView[];
}

function permissionDeniedResponse(scope: string): { readonly error: string } {
  return { error: `Missing required scope: ${scope}` };
}

/** The `GET /api/admin/core-apps` body.
 *
 *  Exported so `GET /api/admin/overview` can serve the identical shape from the
 *  same code rather than a second implementation that could drift away from it. */
export async function buildCoreAppsAdminStatus(
  options: Pick<RegisterCoreAppsAdminRoutesOptions, "service" | "role" | "appIds">,
): Promise<CoreAppsAdminStatus> {
  const status = await options.service.getStatus();
  const modules = status.config.modules;
  /* Fresh `modules` because an admin toggle changes `enabled` at runtime; the
     boot-resolved `appIds` because `inRole` cannot change without a restart. */
  const { statuses } = resolveCoreAppStatuses({
    ...(modules === undefined ? {} : { modules }),
    role: options.role,
    appIds: options.appIds,
  });
  return {
    role: options.role,
    apps: statuses.map((appStatus) => ({
      id: appStatus.id,
      name: appStatus.name,
      description: appStatus.description,
      enabled: appStatus.enabled,
      inRole: appStatus.inRole,
      registered: appStatus.registered,
    })),
  };
}

export async function registerCoreAppsAdminRoutes(
  app: FastifyInstance,
  options: RegisterCoreAppsAdminRoutesOptions,
): Promise<void> {
  const buildStatus = () => buildCoreAppsAdminStatus(options);

  app.get("/api/admin/core-apps", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadPlatformConfig(actor)) {
      return reply.code(403).send(permissionDeniedResponse(platformConfigAdminScopes.read));
    }
    return buildStatus();
  });

  app.patch("/api/admin/core-apps/:appId", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWritePlatformConfig(actor)) {
      return reply.code(403).send(permissionDeniedResponse(platformConfigAdminScopes.write));
    }
    const appId = (request.params as { appId?: string }).appId ?? "";
    if (!isCoreAppId(appId)) {
      return reply.code(404).send({
        error: `Unknown core app "${appId}".`,
        knownApps: CORE_APPS.map((coreApp) => coreApp.id),
      });
    }
    const parsed = coreAppToggleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid core-app toggle.", issues: parsed.error.issues });
    }

    const current = await options.service.getStatus();
    const wasEnabled = isCoreAppEnabled(current.config.modules, appId);
    // Persist `modules[appId].enabled`. The platform-config update is shallow-
    // merged, so other module keys are preserved.
    await options.service.update({ modules: { [appId]: { enabled: parsed.data.enabled } } }, actor);

    const status = await buildStatus();
    return {
      ...status,
      changed: {
        appId,
        from: wasEnabled,
        to: parsed.data.enabled,
        // The change is config-level; it takes effect at the next process
        // start because modules are registered once at boot.
        requiresRestart: wasEnabled !== parsed.data.enabled,
      },
    };
  });
}
