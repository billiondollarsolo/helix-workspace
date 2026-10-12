/* Admin → Mail → Spam filtering → "AI decision model" card.
 *
 * Provider, model, credentials (write-only), mode, thresholds, inbox tabs,
 * daily limit and pricing, with a connection test that uses the unsaved
 * settings and typed key. The form is seeded from the server through
 * `useServerSeededDraft`, so a refetch never wipes what someone is typing. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AdminInput, AdminSelect } from "@/features/admin/console/controls";
import { formatAbsoluteTime } from "@/features/admin/console/format";
import {
  ErrorNotice,
  LoadingState,
  PanelHeading,
  QueryFailureBanner,
  StatusChip,
  useQueryFailure,
} from "@/features/admin/console/primitives";
import { SettingToggle } from "@/features/admin/console/widgets";
import { useServerSeededDraft } from "@/lib/use-server-seeded-draft";
import { mailAdminQueryKeys } from "./mail-admin-api";
import {
  CLOUDFLARE_DECISION_MODELS,
  DECISION_MODEL_MODES,
  DECISION_MODEL_PROVIDERS,
  DecisionModelRequestError,
  decisionModelQueryKeys,
  decisionModelQueryOptions,
  saveDecisionModel,
  testDecisionModelConnection,
  type DecisionModelMode,
  type DecisionModelTestResult,
  type DecisionModelView,
  type SaveDecisionModelInput,
  type TestDecisionModelInput,
} from "./mail-decision-model-api";
import {
  DECISION_CREDENTIAL_LABELS,
  DECISION_PROVIDER_LABELS,
  draftFromView,
  formatConfidence,
  providerNotice,
  settingsFromDraft,
  validateDraft,
  type CredentialIntent,
  type DecisionDraft,
  type DecisionField,
  type DecisionFieldErrors,
} from "./mail-decision-model-form";

const MODE_OPTIONS: Readonly<
  Record<DecisionModelMode, { readonly label: string; readonly description: string }>
> = {
  off: { label: "Off", description: "No mail is sent to the model." },
  shadow: {
    label: "Shadow — record only",
    description:
      "The model classifies external mail and records its verdicts for the report below. Nothing in anyone's mailbox changes.",
  },
  enforce: {
    label: "Enforce — act on high-confidence verdicts",
    description:
      "Mail the model is confident is spam or phishing moves to Spam with an explanation. Everything else is delivered as usual.",
  },
};

const PROVIDER_OPTIONS = {
  cloudflare: "Cloudflare — Clef",
  typesafe: "TypeSafe — Jev",
} as const;

const CLOUDFLARE_MODEL_LABELS: Readonly<Record<string, string>> = {
  "clef-flash": "clef-flash (default — faster, lower cost)",
  clef: "clef (larger model)",
};

const MODE_CHIP: Readonly<Record<DecisionModelMode, { tone: string; label: string }>> = {
  off: { tone: "", label: "Off" },
  shadow: { tone: "info", label: "Shadow" },
  enforce: { tone: "success", label: "Enforce" },
};

function FieldShell({
  controlId,
  label,
  hint,
  error,
  children,
}: {
  readonly controlId: string;
  readonly label: string;
  readonly hint?: ReactNode;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="admin-field content-start">
      <label htmlFor={controlId} className="admin-field-label">
        {label}
      </label>
      {children}
      {hint === undefined ? null : (
        <span id={`${controlId}-hint`} className="admin-muted">
          {hint}
        </span>
      )}
      {error === undefined ? null : (
        <span id={`${controlId}-error`} className="type-caption text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

function testSummary(result: DecisionModelTestResult): string {
  const answer =
    result.answer === null
      ? ""
      : ` Test message classified as “${result.answer}” (${formatConfidence(result.confidence)} confidence).`;
  return `Connected to ${DECISION_PROVIDER_LABELS[result.provider]} · ${result.model} · ${String(Math.round(result.latencyMs))} ms.${answer}`;
}

export function DecisionModelSettings() {
  const queryClient = useQueryClient();
  const query = useQuery(decisionModelQueryOptions());
  const failure = useQueryFailure(query, () => {
    void queryClient.invalidateQueries({
      queryKey: decisionModelQueryKeys.settings(),
      exact: true,
    });
  });
  if (query.data !== undefined) {
    return <DecisionModelForm view={query.data} />;
  }
  return (
    <section className="admin-card" aria-labelledby="mail-decision-model-heading">
      <PanelHeading id="mail-decision-model-heading" title="AI decision model" />
      {failure === null ? (
        <LoadingState label="Loading AI decision model settings…" />
      ) : (
        <QueryFailureBanner
          summary="Couldn't load the AI decision model settings"
          subject="the AI decision model settings"
          error={failure.error}
          isRetrying={failure.isRetrying}
          onRetry={failure.retry}
        />
      )}
    </section>
  );
}

function DecisionModelForm({ view }: { readonly view: DecisionModelView }) {
  const uid = useId();
  const queryClient = useQueryClient();
  const { draft, setDraft, isDirty, markSaved, reset } = useServerSeededDraft(view, draftFromView);
  const [intent, setIntent] = useState<CredentialIntent>("keep");
  const [apiKey, setApiKey] = useState("");
  const [errors, setErrors] = useState<DecisionFieldErrors>({});
  const [savedMessage, setSavedMessage] = useState("");
  const [testResult, setTestResult] = useState<DecisionModelTestResult | null>(null);
  const focusNext = useRef<"key" | "keep" | null>(null);

  const stored = view.credentialConfigured && draft.provider === view.provider;
  const showKeyInput = !stored || intent === "replace";
  const credentialLabel = DECISION_CREDENTIAL_LABELS[draft.provider];
  const credential = { stored, intent, apiKey };

  const requestCredential = (): Pick<SaveDecisionModelInput, "apiKey" | "clearApiKey"> => {
    const typed = apiKey.trim();
    if (showKeyInput && typed !== "") return { apiKey: typed };
    if (stored && intent === "remove") return { clearApiKey: true };
    return {};
  };

  const save = useMutation({
    mutationFn: (input: {
      readonly submitted: DecisionDraft;
      readonly body: SaveDecisionModelInput;
    }) => saveDecisionModel(input.body),
    onMutate: () => setSavedMessage(""),
    onSuccess: (next, input) => {
      markSaved(input.submitted);
      queryClient.setQueryData(decisionModelQueryKeys.settings(), next);
      void queryClient.invalidateQueries({ queryKey: mailAdminQueryKeys.spam(), exact: true });
      setIntent("keep");
      setApiKey("");
      setSavedMessage(
        `Saved. The AI decision model is ${MODE_CHIP[next.mode].label.toLowerCase()}.`,
      );
    },
    onError: (error) => {
      if (error instanceof DecisionModelRequestError) setErrors(error.fieldErrors);
    },
  });

  const test = useMutation({
    mutationFn: (input: TestDecisionModelInput) => testDecisionModelConnection(input),
    onMutate: () => setTestResult(null),
    onSuccess: (result) => setTestResult(result),
    onError: (error) => {
      if (error instanceof DecisionModelRequestError) setErrors(error.fieldErrors);
    },
  });

  const clearFeedback = (field?: DecisionField) => {
    setSavedMessage("");
    setTestResult(null);
    save.reset();
    test.reset();
    if (field !== undefined && errors[field] !== undefined) {
      setErrors((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
    }
  };

  const update = <K extends keyof DecisionDraft>(
    key: K,
    value: DecisionDraft[K],
    field?: DecisionField,
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    clearFeedback(field);
  };

  const onSave = () => {
    const found = validateDraft(draft, credential, "save");
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    save.mutate({
      submitted: draft,
      body: { settings: settingsFromDraft(draft), ...requestCredential() },
    });
  };

  const onTest = () => {
    clearFeedback();
    const found = validateDraft(draft, credential, "test");
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const typed = apiKey.trim();
    test.mutate({
      settings: settingsFromDraft(draft),
      ...(showKeyInput && typed !== "" ? { apiKey: typed } : {}),
    });
  };

  const control = (field: DecisionField, hint = false) => {
    const id = `${uid}-${field}`;
    const describedBy = [
      hint ? `${id}-hint` : null,
      errors[field] === undefined ? null : `${id}-error`,
    ]
      .filter((value) => value !== null)
      .join(" ");
    return {
      id,
      "aria-invalid": errors[field] === undefined ? undefined : true,
      "aria-describedby": describedBy === "" ? undefined : describedBy,
    };
  };

  const chooseIntent = (next: CredentialIntent, focus: "key" | "keep" | null) => {
    focusNext.current = focus;
    setIntent(next);
    setApiKey("");
    clearFeedback("apiKey");
  };
  const focusOnMount = (target: "key" | "keep") => (element: HTMLElement | null) => {
    if (element !== null && focusNext.current === target) {
      focusNext.current = null;
      element.focus();
    }
  };

  const chip = MODE_CHIP[view.mode];
  const saveError = save.error;
  const testError = test.error;

  return (
    <section className="admin-card" aria-labelledby={`${uid}-heading`}>
      <PanelHeading
        id={`${uid}-heading`}
        title="AI decision model"
        subtitle="A second opinion on external mail from a hosted classification model. Try it in shadow mode, check the report, then enforce."
        actions={<StatusChip tone={chip.tone} label={`Saved mode: ${chip.label}`} />}
      />
      <form
        className="grid gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FieldShell controlId={`${uid}-provider`} label="Provider">
            <AdminSelect
              {...control("provider")}
              value={draft.provider}
              onChange={(event) => {
                const provider = DECISION_MODEL_PROVIDERS.find((id) => id === event.target.value);
                if (provider !== undefined) update("provider", provider, "provider");
              }}
            >
              {DECISION_MODEL_PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>
                  {PROVIDER_OPTIONS[provider]}
                </option>
              ))}
            </AdminSelect>
          </FieldShell>
          {draft.provider === "cloudflare" ? (
            <FieldShell controlId={`${uid}-model`} label="Model" error={errors.model}>
              <AdminSelect
                {...control("model")}
                value={draft.cloudflareModel}
                onChange={(event) => update("cloudflareModel", event.target.value, "model")}
              >
                {CLOUDFLARE_DECISION_MODELS.map((model) => (
                  <option key={model} value={model}>
                    {CLOUDFLARE_MODEL_LABELS[model] ?? model}
                  </option>
                ))}
              </AdminSelect>
            </FieldShell>
          ) : (
            <FieldShell
              controlId={`${uid}-model`}
              label="Model"
              hint={`Leave blank for ${view.provider === "typesafe" ? view.defaultModel : "jev-latest"}.`}
              error={errors.model}
            >
              <AdminInput
                {...control("model", true)}
                value={draft.typesafeModel}
                placeholder="jev-latest"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => update("typesafeModel", event.target.value, "model")}
              />
            </FieldShell>
          )}
          {draft.provider === "cloudflare" ? (
            <FieldShell
              controlId={`${uid}-cloudflareAccountId`}
              label="Cloudflare account ID"
              hint="32 characters, shown on the Workers AI page of the Cloudflare dashboard."
              error={errors.cloudflareAccountId}
            >
              <AdminInput
                {...control("cloudflareAccountId", true)}
                value={draft.cloudflareAccountId}
                autoComplete="off"
                spellCheck={false}
                className="mono"
                onChange={(event) =>
                  update("cloudflareAccountId", event.target.value, "cloudflareAccountId")
                }
              />
            </FieldShell>
          ) : null}
          <div>
            {showKeyInput ? (
              <FieldShell
                controlId={`${uid}-apiKey`}
                label={credentialLabel}
                hint={
                  stored
                    ? "The new key replaces the stored one when you save."
                    : "Write-only: stored encrypted and never shown again."
                }
                error={errors.apiKey}
              >
                <AdminInput
                  {...control("apiKey", true)}
                  ref={focusOnMount("key")}
                  type="password"
                  value={apiKey}
                  autoComplete="new-password"
                  spellCheck={false}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    clearFeedback("apiKey");
                  }}
                />
                {stored ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="justify-self-start"
                    onClick={() => chooseIntent("keep", null)}
                  >
                    Keep the stored key
                  </Button>
                ) : null}
              </FieldShell>
            ) : (
              <div className="grid gap-1" role="group" aria-labelledby={`${uid}-stored-label`}>
                <span id={`${uid}-stored-label`} className="admin-field-label">
                  {credentialLabel}
                </span>
                {intent === "remove" ? (
                  <span className="admin-muted">The stored key will be removed when you save.</span>
                ) : (
                  <span className="admin-muted">
                    Stored{" "}
                    {view.credentialUpdatedAt === null
                      ? ""
                      : formatAbsoluteTime(view.credentialUpdatedAt)}
                  </span>
                )}
                <div className="flex flex-wrap gap-2">
                  {intent === "remove" ? (
                    <Button
                      ref={focusOnMount("keep")}
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => chooseIntent("keep", null)}
                    >
                      Keep the stored key
                    </Button>
                  ) : (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => chooseIntent("replace", "key")}
                      >
                        Replace
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => chooseIntent("remove", "keep")}
                      >
                        Remove
                      </Button>
                    </>
                  )}
                </div>
                {errors.apiKey === undefined ? null : (
                  <span className="type-caption text-destructive">{errors.apiKey}</span>
                )}
              </div>
            )}
          </div>
        </div>
        {draft.provider === "typesafe" ? (
          <details
            className="admin-disclosure"
            open={draft.baseUrl !== "" || errors.baseUrl !== undefined}
          >
            <summary>Advanced</summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <FieldShell
                controlId={`${uid}-baseUrl`}
                label="TypeSafe base URL"
                hint="Only for a dedicated TypeSafe deployment. Leave blank for https://api.typesafe.ai."
                error={errors.baseUrl}
              >
                <AdminInput
                  {...control("baseUrl", true)}
                  type="url"
                  inputMode="url"
                  value={draft.baseUrl}
                  placeholder="https://api.typesafe.ai"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => update("baseUrl", event.target.value, "baseUrl")}
                />
              </FieldShell>
            </div>
          </details>
        ) : null}

        <fieldset
          className="grid gap-2"
          aria-describedby={draft.mode === "off" ? undefined : `${uid}-notice`}
        >
          <legend className="admin-field-label mb-1">Mode</legend>
          {DECISION_MODEL_MODES.map((mode) => (
            <label key={mode} className="flex items-start gap-2">
              <input
                type="radio"
                name={`${uid}-mode`}
                value={mode}
                checked={draft.mode === mode}
                className="mt-1 focus-ring"
                aria-describedby={`${uid}-mode-${mode}`}
                onChange={() => update("mode", mode, "apiKey")}
              />
              <span className="grid">
                <span className="type-body-sm font-medium">{MODE_OPTIONS[mode].label}</span>
                <span id={`${uid}-mode-${mode}`} className="admin-muted">
                  {MODE_OPTIONS[mode].description}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {draft.mode === "off" ? null : (
          <div id={`${uid}-notice`} className="admin-notice flex items-start gap-2">
            <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong>Data sent outside Helix.</strong> {providerNotice(draft, view)}
            </span>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <FieldShell
            controlId={`${uid}-spamThreshold`}
            label="Spam confidence"
            hint="0.5–1. Mail moves to Spam only at or above this confidence."
            error={errors.spamThreshold}
          >
            <AdminInput
              {...control("spamThreshold", true)}
              type="number"
              inputMode="decimal"
              min={0.5}
              max={1}
              step={0.01}
              value={draft.spamThreshold}
              onChange={(event) => update("spamThreshold", event.target.value, "spamThreshold")}
            />
          </FieldShell>
          <FieldShell
            controlId={`${uid}-phishingThreshold`}
            label="Phishing confidence"
            hint="0.5–1. Phishing at or above this is moved to Spam with a warning."
            error={errors.phishingThreshold}
          >
            <AdminInput
              {...control("phishingThreshold", true)}
              type="number"
              inputMode="decimal"
              min={0.5}
              max={1}
              step={0.01}
              value={draft.phishingThreshold}
              onChange={(event) =>
                update("phishingThreshold", event.target.value, "phishingThreshold")
              }
            />
          </FieldShell>
        </div>

        <div className="admin-setting-list">
          <SettingToggle
            label="Also set inbox tabs"
            description="In enforce mode, sort mail into Primary, Updates, Promotions and Social when the model is confident enough."
            checked={draft.applyCategories}
            onCheckedChange={(checked) => update("applyCategories", checked)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {draft.applyCategories ? (
            <FieldShell
              controlId={`${uid}-categoryThreshold`}
              label="Inbox tab confidence"
              hint="0.5–1."
              error={errors.categoryThreshold}
            >
              <AdminInput
                {...control("categoryThreshold", true)}
                type="number"
                inputMode="decimal"
                min={0.5}
                max={1}
                step={0.01}
                value={draft.categoryThreshold}
                onChange={(event) =>
                  update("categoryThreshold", event.target.value, "categoryThreshold")
                }
              />
            </FieldShell>
          ) : null}
          <FieldShell
            controlId={`${uid}-dailyMessageCap`}
            label="Daily message limit"
            hint="Mail past the limit is delivered without a verdict."
            error={errors.dailyMessageCap}
          >
            <AdminInput
              {...control("dailyMessageCap", true)}
              type="number"
              inputMode="numeric"
              min={1}
              max={1_000_000}
              step={1}
              value={draft.dailyMessageCap}
              onChange={(event) => update("dailyMessageCap", event.target.value, "dailyMessageCap")}
            />
          </FieldShell>
          <FieldShell
            controlId={`${uid}-inputPricePerMillionTokensUsd`}
            label="Price per million input tokens (USD)"
            hint="Optional. Overrides the published price in the report's cost estimate."
            error={errors.inputPricePerMillionTokensUsd}
          >
            <AdminInput
              {...control("inputPricePerMillionTokensUsd", true)}
              type="number"
              inputMode="decimal"
              min={0}
              max={1000}
              step="any"
              value={draft.inputPrice}
              onChange={(event) =>
                update("inputPrice", event.target.value, "inputPricePerMillionTokensUsd")
              }
            />
          </FieldShell>
        </div>

        {saveError === null ? null : (
          <ErrorNotice title="Settings not saved">{saveError.message}</ErrorNotice>
        )}
        {testError === null ? null : (
          <ErrorNotice title="Connection test failed">
            {testError.message}
            {testError instanceof DecisionModelRequestError && testError.providerCode !== null
              ? ` (provider code: ${testError.providerCode})`
              : null}
          </ErrorNotice>
        )}
        <div role="status" className="admin-muted">
          {test.isPending ? "Testing the connection…" : null}
          {testResult === null ? null : testSummary(testResult)}
          {testResult !== null && savedMessage !== "" ? " " : null}
          {savedMessage}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          <Button type="button" variant="outline" disabled={test.isPending} onClick={onTest}>
            {test.isPending ? "Testing…" : "Test connection"}
          </Button>
          {isDirty || intent !== "keep" || apiKey !== "" ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                reset();
                setIntent("keep");
                setApiKey("");
                setErrors({});
                clearFeedback();
              }}
            >
              Discard changes
            </Button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
