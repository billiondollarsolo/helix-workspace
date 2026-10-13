import type { Actor, ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import { ForbiddenError, NotFoundError } from "../../api/api-error.js";
import type { OutboundHttpClientOptions } from "../outbound-http.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import {
  checkSecretRequest,
  secretMayBeSentTo,
  secretHttpRequestSchema,
  secretHttpResponseSchema,
  sendWithSecret,
} from "./request.js";
import type { PostgresAgentSecretStore } from "./store.js";

const genericObjectJsonSchema = { type: "object", additionalProperties: true } as const;
const permission = "secrets.use";

const nameSchema = z.object({ name: z.string().min(1).max(63) }).strict();
const emptySchema = z.object({}).strict();

const grantedSecretSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** `use_only` secrets can be sent with `secrets.http_request` but never read. */
  mode: z.enum(["use_only", "handover"]),
  /** Hosts `secrets.http_request` may send it to. Empty when it is never sent. */
  allowedHosts: z.array(z.string()),
  version: z.number().int(),
});

const listResultSchema = z.object({ secrets: z.array(grantedSecretSchema) });
const revealedSecretSchema = z.object({
  name: z.string(),
  value: z.string(),
  version: z.number().int(),
});

/** How often one agent may send one secret without a person confirming. */
const UNATTENDED_REQUESTS_PER_MINUTE = 60;
const UNATTENDED_REQUESTS_PER_DAY = 5_000;

export interface AgentSecretToolOptions {
  readonly store: Pick<PostgresAgentSecretStore, "listGranted" | "open" | "recordUse">;
  /**
   * Whether the organization lets agents send the secrets they were granted
   * without a person confirming each request. When it does not, every request
   * waits like any other agent action.
   */
  readonly requestsRunUnattended: (orgId: string) => Promise<boolean>;
  /** Test seam for the outgoing request. */
  readonly outbound?: Pick<OutboundHttpClientOptions, "resolve" | "transport">;
}

/** Secrets are granted to agents and service accounts, never to people. */
function requireAgent(actor: Actor): void {
  if (actor.type !== "agent" && actor.type !== "service_account") {
    throw new ForbiddenError("Secrets are available only to agents and service accounts.");
  }
}

export function createAgentSecretTools(options: AgentSecretToolOptions): readonly ToolDefinition[] {
  const { store } = options;
  const notAvailable = (name: string) =>
    new NotFoundError(
      `No secret named ${name} is available to this agent. Call secrets.list to see what an administrator has granted.`,
    );

  return [
    defineTool<z.output<typeof emptySchema>, z.output<typeof listResultSchema>>({
      id: "secrets.list",
      description:
        "List the secrets an administrator has granted to this agent: names, what they are for, and how each may be used. Values are never listed.",
      permission,
      sideEffects: "read",
      inputSchema: zodToolSchema(emptySchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(listResultSchema, genericObjectJsonSchema),
      handler: async (_input, ctx) => {
        requireAgent(ctx.actor);
        const granted = await store.listGranted({ orgId: ctx.actor.orgId, actorId: ctx.actor.id });
        return {
          secrets: granted.map((secret) => ({
            name: secret.name,
            description: secret.description,
            mode: secret.mode,
            allowedHosts: [...secret.allowedHosts],
            version: secret.version,
          })),
        };
      },
    }),
    defineTool<z.output<typeof nameSchema>, z.output<typeof revealedSecretSchema>>({
      id: "secrets.get",
      description:
        "Get the value of a secret granted to this agent, for use in another system. Works only for secrets an administrator marked as handed to the agent; every call is recorded. Do not repeat the value in messages, files, or logs.",
      permission,
      sideEffects: "read",
      rateLimit: { perActor: { perMinute: 60 } },
      sensitiveOutputKeys: ["value"],
      inputSchema: zodToolSchema(nameSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(revealedSecretSchema, genericObjectJsonSchema),
      handler: async ({ name }, ctx) => {
        requireAgent(ctx.actor);
        const scope = { orgId: ctx.actor.orgId, actorId: ctx.actor.id };
        const secret = await store.open({ ...scope, name });
        if (secret === null) {
          await ctx.audit("agent_secret.access_denied", { secret: name, reason: "not_granted" });
          throw notAvailable(name);
        }
        if (secret.mode !== "handover") {
          await ctx.audit("agent_secret.access_denied", {
            secretId: secret.id,
            secret: name,
            reason: "use_only",
          });
          throw new ForbiddenError(
            `The secret ${name} is use-only and cannot be read. Send it with secrets.http_request instead.`,
          );
        }
        // Recorded first: a value that cannot be accounted for is not handed over.
        await ctx.audit("agent_secret.revealed", {
          secretId: secret.id,
          secret: name,
          version: secret.version,
        });
        await store.recordUse({ ...scope, secretId: secret.id });
        return { name: secret.name, value: secret.value, version: secret.version };
      },
    }),
    defineTool<z.output<typeof secretHttpRequestSchema>, z.output<typeof secretHttpResponseSchema>>(
      {
        id: "secrets.http_request",
        description:
          "Make one HTTPS request with a granted secret added by Helix, so the secret never has to be read. Name the secret, the method, and the URL; the URL's host must be one the secret may be sent to (see secrets.list). Do not set the authentication header yourself. Returns the status and up to 1 MiB of response text. A request the organization has not authorized in advance waits for a person to confirm it.",
        permission,
        sideEffects: "external_communication",
        rateLimit: { perActor: { perMinute: 60 } },
        inputSchema: zodToolSchema(secretHttpRequestSchema, genericObjectJsonSchema),
        outputSchema: zodToolSchema(secretHttpResponseSchema, genericObjectJsonSchema),
        // An administrator stored this secret for these hosts and granted it to
        // this agent: that is the authorization for exactly this request. Any
        // other request waits for a person, and is then refused by the handler.
        standingAuthorization: async (input, actor) => {
          if (actor.type !== "agent" && actor.type !== "service_account") return null;
          if (!(await options.requestsRunUnattended(actor.orgId))) return null;
          const granted = await store.listGranted({ orgId: actor.orgId, actorId: actor.id });
          const secret = granted.find((candidate) => candidate.name === input.secret);
          return secret === undefined || !secretMayBeSentTo(secret, input.url)
            ? null
            : {
                id: `agent-secret-grant:${secret.id}`,
                version: String(secret.version),
                requestsPerMinute: UNATTENDED_REQUESTS_PER_MINUTE,
                requestsPerDay: UNATTENDED_REQUESTS_PER_DAY,
              };
        },
        handler: async (input, ctx) => {
          requireAgent(ctx.actor);
          const scope = { orgId: ctx.actor.orgId, actorId: ctx.actor.id };
          const secret = await store.open({ ...scope, name: input.secret });
          if (secret === null) {
            await ctx.audit("agent_secret.access_denied", {
              secret: input.secret,
              reason: "not_granted",
            });
            throw notAvailable(input.secret);
          }
          const { host } = checkSecretRequest(secret, input);
          await ctx.audit("agent_secret.used", {
            secretId: secret.id,
            secret: secret.name,
            version: secret.version,
            method: input.method,
            host,
          });
          await store.recordUse({ ...scope, secretId: secret.id });
          return sendWithSecret(secret, input, options.outbound);
        },
      },
    ),
  ];
}

export function registerAgentSecretTools(
  registry: RuntimeToolRegistry,
  options: AgentSecretToolOptions,
): void {
  for (const tool of createAgentSecretTools(options)) registry.register(tool);
}
