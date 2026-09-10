import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import {
  DetailRow,
  EditorSteps,
  EditorTitle,
  FormActions,
  FormError,
  SelectField,
  TextField,
  TextareaField,
  useEditorStepper,
} from "./webhook-controls";
import {
  type InboundFormState,
  type OutboundFormState,
  inboundActionInputJsonSchema,
  inboundActionScopesSchema,
  inboundActionToolIdSchema,
  inboundEditorSteps,
  inboundSlugSchema,
  inboundSourceSchema,
  inboundSources,
  metadataJsonSchema,
  outboundEditorSteps,
  outboundEventSubjectsSchema,
  outboundFormatSchema,
  outboundFormats,
  outboundHeadersJsonSchema,
  outboundTemplateSchema,
  outboundUrlSchema,
  splitList,
  validateInboundForm,
  validateOutboundForm,
  validateWithZod,
  webhookEnabledSchema,
  webhookNameSchema,
} from "./webhook-form-state";

export function OutboundForm({
  form,
  isSaving,
  onCancel,
  onSubmit,
}: {
  readonly form: OutboundFormState;
  readonly isSaving: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (form: OutboundFormState) => void;
}) {
  const { step, setStep, isLastStep, onBack, onNext } = useEditorStepper(
    outboundEditorSteps,
    "destination",
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const editorForm = useForm({
    defaultValues: form,
    onSubmit: ({ value }) => {
      const validationError = validateOutboundForm(value);
      if (validationError !== null) {
        setSubmitError(validationError.message);
        setStep(validationError.step);
        return;
      }
      setSubmitError(null);
      onSubmit(value);
    },
  });

  return (
    <form
      className="webhooks-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void editorForm.handleSubmit();
      }}
    >
      <EditorTitle mode={form.mode} title="outbound webhook" onCancel={onCancel} />
      <EditorSteps
        activeStep={step}
        ariaLabel="Outbound webhook setup steps"
        onStepChange={setStep}
        steps={outboundEditorSteps}
      />
      {submitError !== null ? <FormError message={submitError} /> : null}
      {step === "destination" ? (
        <>
          <editorForm.Field
            name="name"
            validators={{ onChange: validateWithZod(webhookNameSchema) }}
          >
            {(field) => (
              <TextField
                label="Name"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                required
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="url"
            validators={{ onChange: validateWithZod(outboundUrlSchema) }}
          >
            {(field) => (
              <TextField
                label="Destination URL"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                required
                type="url"
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="enabled"
            validators={{ onChange: validateWithZod(webhookEnabledSchema) }}
          >
            {(field) => (
              <label className="webhooks-checkbox">
                <input
                  checked={field.state.value}
                  onChange={(event) => field.handleChange(event.target.checked)}
                  type="checkbox"
                />
                Enabled
              </label>
            )}
          </editorForm.Field>
        </>
      ) : null}
      {step === "payload" ? (
        <>
          <editorForm.Field
            name="eventSubjects"
            validators={{ onChange: validateWithZod(outboundEventSubjectsSchema) }}
          >
            {(field) => (
              <TextareaField
                label="Event subjects"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                rows={3}
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="format"
            validators={{ onChange: validateWithZod(outboundFormatSchema) }}
          >
            {(field) => (
              <SelectField
                label="Format"
                value={field.state.value}
                values={outboundFormats}
                onChange={(value) => field.handleChange(value)}
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="template"
            validators={{ onChange: validateWithZod(outboundTemplateSchema) }}
          >
            {(field) => (
              <TextareaField
                label="Template"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                rows={4}
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="headersJson"
            validators={{ onChange: validateWithZod(outboundHeadersJsonSchema) }}
          >
            {(field) => (
              <TextareaField
                label="Headers JSON"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                rows={4}
              />
            )}
          </editorForm.Field>
        </>
      ) : null}
      {step === "review" ? (
        <>
          <editorForm.Field
            name="metadataJson"
            validators={{ onChange: validateWithZod(metadataJsonSchema) }}
          >
            {(field) => (
              <TextareaField
                label="Metadata JSON"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                rows={5}
              />
            )}
          </editorForm.Field>
          <editorForm.Subscribe selector={(state) => state.values}>
            {(values) => <OutboundReview values={values} />}
          </editorForm.Subscribe>
        </>
      ) : null}
      <FormActions
        isSaving={isSaving}
        isLastStep={isLastStep}
        onBack={onBack}
        onCancel={onCancel}
        onNext={onNext}
      />
    </form>
  );
}

export function InboundForm({
  form,
  isSaving,
  onCancel,
  onSubmit,
}: {
  readonly form: InboundFormState;
  readonly isSaving: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (form: InboundFormState) => void;
}) {
  const { step, setStep, isLastStep, onBack, onNext } = useEditorStepper(
    inboundEditorSteps,
    "receiver",
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const editorForm = useForm({
    defaultValues: form,
    onSubmit: ({ value }) => {
      const validationError = validateInboundForm(value);
      if (validationError !== null) {
        setSubmitError(validationError.message);
        setStep(validationError.step);
        return;
      }
      setSubmitError(null);
      onSubmit(value);
    },
  });

  return (
    <form
      className="webhooks-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void editorForm.handleSubmit();
      }}
    >
      <EditorTitle mode={form.mode} title="inbound webhook" onCancel={onCancel} />
      <EditorSteps
        activeStep={step}
        ariaLabel="Inbound webhook setup steps"
        onStepChange={setStep}
        steps={inboundEditorSteps}
      />
      {submitError !== null ? <FormError message={submitError} /> : null}
      {step === "receiver" ? (
        <>
          <editorForm.Field
            name="name"
            validators={{ onChange: validateWithZod(webhookNameSchema) }}
          >
            {(field) => (
              <TextField
                label="Name"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                required
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="slug"
            validators={{ onChange: validateWithZod(inboundSlugSchema) }}
          >
            {(field) => (
              <TextField
                label="Slug"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                pattern="[a-z0-9][a-z0-9-]*"
                required
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="source"
            validators={{ onChange: validateWithZod(inboundSourceSchema) }}
          >
            {(field) => (
              <SelectField
                label="Source"
                value={field.state.value}
                values={inboundSources}
                onChange={(value) => field.handleChange(value)}
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="enabled"
            validators={{ onChange: validateWithZod(webhookEnabledSchema) }}
          >
            {(field) => (
              <label className="webhooks-checkbox">
                <input
                  checked={field.state.value}
                  onChange={(event) => field.handleChange(event.target.checked)}
                  type="checkbox"
                />
                Enabled
              </label>
            )}
          </editorForm.Field>
        </>
      ) : null}
      {step === "action" ? (
        <>
          <editorForm.Field
            name="actionToolId"
            validators={{ onChange: validateWithZod(inboundActionToolIdSchema) }}
          >
            {(field) => (
              <TextField
                label="Action tool ID"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="actionScopes"
            validators={{ onChange: validateWithZod(inboundActionScopesSchema) }}
          >
            {(field) => (
              <TextField
                label="Action scopes"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
              />
            )}
          </editorForm.Field>
          <editorForm.Field
            name="actionInputJson"
            validators={{ onChange: validateWithZod(inboundActionInputJsonSchema) }}
          >
            {(field) => (
              <TextareaField
                label="Action input JSON"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                rows={4}
              />
            )}
          </editorForm.Field>
        </>
      ) : null}
      {step === "review" ? (
        <>
          <editorForm.Field
            name="metadataJson"
            validators={{ onChange: validateWithZod(metadataJsonSchema) }}
          >
            {(field) => (
              <TextareaField
                label="Metadata JSON"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
                rows={5}
              />
            )}
          </editorForm.Field>
          <editorForm.Subscribe selector={(state) => state.values}>
            {(values) => <InboundReview values={values} />}
          </editorForm.Subscribe>
        </>
      ) : null}
      <FormActions
        isSaving={isSaving}
        isLastStep={isLastStep}
        onBack={onBack}
        onCancel={onCancel}
        onNext={onNext}
      />
    </form>
  );
}

function OutboundReview({ values }: { readonly values: OutboundFormState }) {
  const subjects = splitList(values.eventSubjects);
  return (
    <>
      <DetailRow label="Destination" value={values.url.trim() === "" ? "-" : values.url.trim()} />
      <DetailRow
        label="Events"
        value={subjects.length === 0 ? "All events" : subjects.join(", ")}
      />
      <DetailRow label="Format" value={values.format} />
      <DetailRow label="Status" value={values.enabled ? "Enabled" : "Disabled"} />
    </>
  );
}

function InboundReview({ values }: { readonly values: InboundFormState }) {
  const toolId = values.actionToolId.trim();
  return (
    <>
      <DetailRow
        label="Endpoint"
        value={values.slug.trim() === "" ? "-" : `/v1/webhooks/${values.slug.trim()}`}
      />
      <DetailRow label="Source" value={values.source} />
      <DetailRow label="Action" value={toolId === "" ? "Record only" : toolId} />
      <DetailRow label="Status" value={values.enabled ? "Enabled" : "Disabled"} />
    </>
  );
}
