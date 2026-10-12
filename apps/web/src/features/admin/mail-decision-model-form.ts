import {
  CLOUDFLARE_DECISION_MODELS,
  DEFAULT_DECISION_MODELS,
  type DecisionModelMode,
  type DecisionModelProvider,
  type DecisionModelSettingsInput,
  type DecisionModelView,
} from "./mail-decision-model-api";

/* Pure form logic for the AI decision model card: the editable draft, how it
 * is seeded from the server view, how it becomes the PUT body, and the client
 * checks that mirror the backend schema so most mistakes are caught before a
 * round trip. The server stays authoritative; its `issues` land on the same
 * field keys. */

export const DECISION_PROVIDER_LABELS: Readonly<Record<DecisionModelProvider, string>> = {
  cloudflare: "Cloudflare Workers AI",
  typesafe: "TypeSafe",
};

export const DECISION_CREDENTIAL_LABELS: Readonly<Record<DecisionModelProvider, string>> = {
  cloudflare: "Cloudflare API token",
  typesafe: "TypeSafe API key",
};

/** Numbers stay strings while editing so a half-typed "0." is not coerced away. */
export interface DecisionDraft {
  readonly mode: DecisionModelMode;
  readonly provider: DecisionModelProvider;
  readonly cloudflareModel: string;
  readonly typesafeModel: string;
  readonly cloudflareAccountId: string;
  readonly baseUrl: string;
  readonly spamThreshold: string;
  readonly phishingThreshold: string;
  readonly categoryThreshold: string;
  readonly applyCategories: boolean;
  readonly dailyMessageCap: string;
  readonly inputPrice: string;
}

/** Field keys shared by client checks and server `issues`. */
export type DecisionField =
  | "mode"
  | "provider"
  | "model"
  | "cloudflareAccountId"
  | "baseUrl"
  | "spamThreshold"
  | "phishingThreshold"
  | "categoryThreshold"
  | "dailyMessageCap"
  | "inputPricePerMillionTokensUsd"
  | "apiKey";

export type DecisionFieldErrors = Partial<Record<DecisionField, string>>;

/** How the stored key is treated on save. */
export type CredentialIntent = "keep" | "replace" | "remove";

export function draftFromView(view: DecisionModelView | undefined): DecisionDraft {
  const provider = view?.provider ?? "cloudflare";
  const model = view?.model ?? DEFAULT_DECISION_MODELS[provider];
  const price = view?.inputPricePerMillionTokensUsd ?? null;
  return {
    mode: view?.mode ?? "off",
    provider,
    cloudflareModel:
      provider === "cloudflare" && isCloudflareModel(model)
        ? model
        : DEFAULT_DECISION_MODELS.cloudflare,
    typesafeModel: provider === "typesafe" ? model : DEFAULT_DECISION_MODELS.typesafe,
    cloudflareAccountId: view?.cloudflareAccountId ?? "",
    baseUrl: view?.baseUrl ?? "",
    spamThreshold: String(view?.spamThreshold ?? 0.9),
    phishingThreshold: String(view?.phishingThreshold ?? 0.8),
    categoryThreshold: String(view?.categoryThreshold ?? 0.75),
    applyCategories: view?.applyCategories ?? false,
    dailyMessageCap: String(view?.dailyMessageCap ?? 5000),
    inputPrice: price === null ? "" : String(price),
  };
}

function isCloudflareModel(model: string): boolean {
  return (CLOUDFLARE_DECISION_MODELS as readonly string[]).includes(model);
}

/** The strict `settings` body: provider-specific fields only for their provider, blanks omitted. */
export function settingsFromDraft(draft: DecisionDraft): DecisionModelSettingsInput {
  const cloudflare = draft.provider === "cloudflare";
  const model = cloudflare ? draft.cloudflareModel : draft.typesafeModel.trim();
  const accountId = draft.cloudflareAccountId.trim();
  const baseUrl = draft.baseUrl.trim();
  const price = draft.inputPrice.trim();
  return {
    mode: draft.mode,
    provider: draft.provider,
    ...(model === "" ? {} : { model }),
    ...(cloudflare && accountId !== "" ? { cloudflareAccountId: accountId } : {}),
    ...(!cloudflare && baseUrl !== "" ? { baseUrl } : {}),
    spamThreshold: Number(draft.spamThreshold),
    phishingThreshold: Number(draft.phishingThreshold),
    categoryThreshold: Number(draft.categoryThreshold),
    applyCategories: draft.applyCategories,
    dailyMessageCap: Number(draft.dailyMessageCap),
    ...(price === "" ? {} : { inputPricePerMillionTokensUsd: Number(price) }),
  };
}

const ACCOUNT_ID = /^[A-Fa-f0-9]{32}$/u;
const MODEL_ID = /^[A-Za-z0-9~][A-Za-z0-9._~/-]{0,99}$/u;

function thresholdError(value: string): string | undefined {
  const number = Number(value);
  return value.trim() !== "" && Number.isFinite(number) && number >= 0.5 && number <= 1
    ? undefined
    : "Enter a confidence between 0.5 and 1.";
}

function baseUrlError(value: string): string | undefined {
  if (value === "") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.username === "" && url.password === "") {
      return url.search === "" && url.hash === ""
        ? undefined
        : "Remove the query string or fragment from the base URL.";
    }
  } catch {
    // fall through
  }
  return "Enter an https:// URL, such as https://api.typesafe.ai.";
}

/**
 * Client checks mirroring the backend schema. `purpose: "save"` also requires
 * a usable key before turning shadow or enforce on, as the server does.
 */
export function validateDraft(
  draft: DecisionDraft,
  credential: {
    readonly stored: boolean;
    readonly intent: CredentialIntent;
    readonly apiKey: string;
  },
  purpose: "save" | "test",
): DecisionFieldErrors {
  const errors: DecisionFieldErrors = {};
  const accountId = draft.cloudflareAccountId.trim();
  if (draft.provider === "cloudflare") {
    if (
      accountId === "" ? draft.mode !== "off" || purpose === "test" : !ACCOUNT_ID.test(accountId)
    ) {
      errors.cloudflareAccountId =
        "Enter the 32-character account ID from the Cloudflare dashboard.";
    }
  } else {
    const model = draft.typesafeModel.trim();
    if (model !== "" && !MODEL_ID.test(model)) {
      errors.model = "Enter a TypeSafe model ID, such as jev-latest.";
    }
    const urlError = baseUrlError(draft.baseUrl.trim());
    if (urlError !== undefined) errors.baseUrl = urlError;
  }
  for (const field of ["spamThreshold", "phishingThreshold", "categoryThreshold"] as const) {
    const error = thresholdError(draft[field]);
    if (error !== undefined) errors[field] = error;
  }
  const cap = Number(draft.dailyMessageCap);
  if (!Number.isInteger(cap) || cap < 1 || cap > 1_000_000) {
    errors.dailyMessageCap = "Enter a whole number from 1 to 1,000,000.";
  }
  const price = draft.inputPrice.trim();
  if (
    price !== "" &&
    !(Number.isFinite(Number(price)) && Number(price) >= 0 && Number(price) <= 1000)
  ) {
    errors.inputPricePerMillionTokensUsd = "Enter a price from 0 to 1000 USD, or leave it blank.";
  }
  const typed = credential.apiKey.trim();
  if (typed !== "" && (typed.length < 8 || typed.length > 4096 || /\s/u.test(credential.apiKey))) {
    errors.apiKey = "Paste the whole key: at least 8 characters, with no spaces.";
  } else if (purpose === "save" && draft.mode !== "off") {
    const usable = typed !== "" || (credential.stored && credential.intent !== "remove");
    if (!usable) {
      errors.apiKey = `Add the ${DECISION_CREDENTIAL_LABELS[draft.provider]} before turning on ${draft.mode} mode.`;
    }
  }
  return errors;
}

/** The notice for the draft's provider; the server's wording when it is the saved provider. */
export function providerNotice(draft: DecisionDraft, view: DecisionModelView): string {
  return draft.provider === view.provider
    ? view.notice
    : `Message content is sent to ${DECISION_PROVIDER_LABELS[draft.provider]} for classification. Mail labelled confidential or restricted is never sent.`;
}

/** "94%" from 0.94; "—" when unknown. */
export function formatConfidence(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${String(Math.round(value * 100))}%`;
}
