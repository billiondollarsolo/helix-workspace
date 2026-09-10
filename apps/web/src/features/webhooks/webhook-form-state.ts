import { z } from "zod";
import type { InboundWebhook, OutboundWebhook } from "./types";
import { errorMessage, isRecord } from "./webhook-format";

type OutboundEditorStep = "destination" | "payload" | "review";

type InboundEditorStep = "receiver" | "action" | "review";

export interface OutboundFormState {
  readonly mode: "create" | "edit";
  readonly id?: string;
  readonly name: string;
  readonly url: string;
  readonly eventSubjects: string;
  readonly enabled: boolean;
  readonly format: string;
  readonly template: string;
  readonly headersJson: string;
  readonly metadataJson: string;
}

export interface InboundFormState {
  readonly mode: "create" | "edit";
  readonly id?: string;
  readonly name: string;
  readonly slug: string;
  readonly source: string;
  readonly enabled: boolean;
  readonly actionToolId: string;
  readonly actionScopes: string;
  readonly actionInputJson: string;
  readonly metadataJson: string;
}

export const outboundFormats = ["generic", "slack", "discord", "teams", "custom"] as const;

export const inboundSources = [
  "generic",
  "github",
  "gitlab",
  "stripe",
  "linear",
  "grafana",
  "prometheus",
] as const;

export const webhookNameSchema = z.string().trim().min(1, "Name is required.");

export const outboundUrlSchema = z
  .string()
  .refine(isValidHttpUrl, "Destination URL must be a valid HTTP or HTTPS URL.");

export const outboundEventSubjectsSchema = z.string();

export const outboundFormatSchema = z.enum(outboundFormats);

export const outboundTemplateSchema = z.string();

export const outboundHeadersJsonSchema = jsonRecordFieldSchema("Headers JSON").superRefine(
  (value, context) => {
    let parsedHeaders: Record<string, unknown>;
    try {
      parsedHeaders = parseJsonRecord(value);
    } catch {
      return;
    }
    if (Object.values(parsedHeaders).some((headerValue) => typeof headerValue !== "string")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Headers JSON values must be strings.",
      });
    }
  },
);

export const metadataJsonSchema = jsonRecordFieldSchema("Metadata JSON");

export const webhookEnabledSchema = z.boolean();

export const inboundSlugSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9-]*$/u,
    "Slug must start with a lowercase letter or number and use only lowercase letters, numbers, and hyphens.",
  );

export const inboundSourceSchema = z.enum(inboundSources);

export const inboundActionToolIdSchema = z.string();

export const inboundActionScopesSchema = z.string();

export const inboundActionInputJsonSchema = z.string().superRefine((value, context) => {
  if (value.trim() === "") {
    return;
  }
  try {
    JSON.parse(value) as unknown;
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Action input JSON is invalid: ${errorMessage(error)}`,
    });
  }
});

export const outboundEditorSteps: readonly {
  readonly id: OutboundEditorStep;
  readonly label: string;
}[] = [
  { id: "destination", label: "Destination" },
  { id: "payload", label: "Payload" },
  { id: "review", label: "Review" },
];

export const inboundEditorSteps: readonly {
  readonly id: InboundEditorStep;
  readonly label: string;
}[] = [
  { id: "receiver", label: "Receiver" },
  { id: "action", label: "Action" },
  { id: "review", label: "Review" },
];

export const emptyOutboundForm: OutboundFormState = {
  mode: "create",
  name: "",
  url: "",
  eventSubjects: "platform.pending_action.created",
  enabled: true,
  format: "generic",
  template: "",
  headersJson: "{}",
  metadataJson: "{}",
};

export const emptyInboundForm: InboundFormState = {
  mode: "create",
  name: "",
  slug: "",
  source: "generic",
  enabled: true,
  actionToolId: "",
  actionScopes: "admin.webhooks",
  actionInputJson: "",
  metadataJson: "{}",
};

export function outboundInputFromForm(form: OutboundFormState) {
  const metadata = parseJsonRecord(form.metadataJson);
  return {
    name: form.name.trim(),
    url: form.url.trim(),
    eventSubjects: splitList(form.eventSubjects),
    headers: parseJsonRecord(form.headersJson) as Record<string, string>,
    enabled: form.enabled,
    metadata: compactRecord({
      ...metadata,
      format: form.format,
      template: form.template.trim() === "" ? undefined : form.template,
    }),
  };
}

export function inboundInputFromForm(form: InboundFormState) {
  const metadata = parseJsonRecord(form.metadataJson);
  const actionToolId = form.actionToolId.trim();
  return {
    name: form.name.trim(),
    slug: form.slug.trim(),
    source: form.source,
    enabled: form.enabled,
    metadata: compactRecord({
      ...metadata,
      action:
        actionToolId === ""
          ? undefined
          : compactRecord({
              toolId: actionToolId,
              scopes: splitList(form.actionScopes),
              input:
                form.actionInputJson.trim() === "" ? undefined : JSON.parse(form.actionInputJson),
            }),
    }),
  };
}

export function validateOutboundForm(
  form: OutboundFormState,
): { readonly step: OutboundEditorStep; readonly message: string } | null {
  const nameError = schemaError(webhookNameSchema, form.name);
  if (nameError !== null) return { step: "destination", message: nameError };
  const urlError = schemaError(outboundUrlSchema, form.url);
  if (urlError !== null) return { step: "destination", message: urlError };
  const headersError = schemaError(outboundHeadersJsonSchema, form.headersJson);
  if (headersError !== null) return { step: "payload", message: headersError };
  const metadataError = schemaError(metadataJsonSchema, form.metadataJson);
  if (metadataError !== null) return { step: "review", message: metadataError };
  return null;
}

export function validateInboundForm(
  form: InboundFormState,
): { readonly step: InboundEditorStep; readonly message: string } | null {
  const nameError = schemaError(webhookNameSchema, form.name);
  if (nameError !== null) return { step: "receiver", message: nameError };
  const slugError = schemaError(inboundSlugSchema, form.slug);
  if (slugError !== null) return { step: "receiver", message: slugError };
  const sourceError = schemaError(inboundSourceSchema, form.source);
  if (sourceError !== null) return { step: "receiver", message: sourceError };
  const actionInputError = schemaError(inboundActionInputJsonSchema, form.actionInputJson);
  if (actionInputError !== null) return { step: "action", message: actionInputError };
  const metadataError = schemaError(metadataJsonSchema, form.metadataJson);
  if (metadataError !== null) return { step: "review", message: metadataError };
  return null;
}

function jsonRecordFieldSchema(label: string) {
  return z.string().superRefine((value, context) => {
    try {
      parseJsonRecord(value);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} is invalid: ${errorMessage(error)}`,
      });
    }
  });
}

export function validateWithZod(schema: z.ZodTypeAny) {
  return ({ value }: { readonly value: unknown }) => schemaError(schema, value) ?? undefined;
}

function schemaError(schema: z.ZodTypeAny, value: unknown): string | null {
  const result = schema.safeParse(value);
  return result.success ? null : (result.error.issues[0]?.message ?? "Invalid value.");
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function outboundFormFromWebhook(webhook: OutboundWebhook): OutboundFormState {
  return {
    mode: "edit",
    id: webhook.id,
    name: webhook.name,
    url: webhook.url,
    eventSubjects: webhook.eventSubjects.join("\n"),
    enabled: webhook.enabled,
    format: stringMetadata(webhook.metadata, "format") ?? "generic",
    template: stringMetadata(webhook.metadata, "template") ?? "",
    headersJson: JSON.stringify(webhook.headers, null, 2),
    metadataJson: JSON.stringify(webhook.metadata, null, 2),
  };
}

export function inboundFormFromWebhook(webhook: InboundWebhook): InboundFormState {
  const action = isRecord(webhook.metadata.action) ? webhook.metadata.action : {};
  return {
    mode: "edit",
    id: webhook.id,
    name: webhook.name,
    slug: webhook.slug,
    source: webhook.source,
    enabled: webhook.enabled,
    actionToolId: typeof action.toolId === "string" ? action.toolId : "",
    actionScopes: Array.isArray(action.scopes)
      ? action.scopes.filter((scope): scope is string => typeof scope === "string").join(", ")
      : "",
    actionInputJson: action.input === undefined ? "" : JSON.stringify(action.input, null, 2),
    metadataJson: JSON.stringify(webhook.metadata, null, 2),
  };
}

export function formKey(form: Pick<OutboundFormState | InboundFormState, "id" | "mode">): string {
  return `${form.mode}:${form.id ?? "new"}`;
}

function parseJsonRecord(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (trimmed === "") {
    return {};
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("JSON value must be an object.");
  }
  return parsed;
}

export function splitList(value: string): readonly string[] {
  return value
    .split(/[\n,]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

export function actionLabel(metadata: Record<string, unknown>): string {
  const action = metadata.action;
  if (!isRecord(action) || typeof action.toolId !== "string") {
    return "Record only";
  }
  return action.toolId;
}
