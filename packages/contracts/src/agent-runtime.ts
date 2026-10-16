import { z } from "zod";
export const agentRuntimeConfigSchema = z
  .object({
    mode: z.enum(["external", "helix"]),
    enabled: z.boolean().default(false),
    credentialId: z.string().uuid().nullable().default(null),
    modelId: z.string().trim().min(1).max(300).nullable().default(null),
    instructions: z
      .string()
      .trim()
      .max(4000)
      .default(
        "Respond helpfully to people who message or mention you. Read the triggering message before replying. Use Chat tools to reply in the same room. Ask for human approval when required.",
      ),
    events: z
      .array(z.enum(["chat.direct", "chat.mentioned", "mail.received", "approval.updated"]))
      .min(1)
      .max(4)
      .default(["chat.direct", "chat.mentioned", "approval.updated"]),
    turnsPerHour: z.number().int().min(1).max(120).default(20),
  })
  .strict()
  .refine(
    (v) => v.mode !== "helix" || !v.enabled || (v.credentialId !== null && v.modelId !== null),
    { message: "Choose a credential and model before enabling Helix hosting." },
  );
export type AgentRuntimeConfig = z.infer<typeof agentRuntimeConfigSchema>;
export const agentRuntimeSchema = z.object({
  actorId: z.string().uuid(),
  config: agentRuntimeConfigSchema,
  cursor: z.number().int().nonnegative(),
  version: z.number().int(),
  state: z.enum(["paused", "listening", "working", "waiting_approval", "error"]),
  lastError: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  conversationId: z.string().uuid().nullable(),
  interrupted: z.boolean(),
});
export type AgentRuntime = z.infer<typeof agentRuntimeSchema>;
