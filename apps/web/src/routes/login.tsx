import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { LogIn } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requestOAuthClientCredentialsToken, storeAccessToken } from "@/lib/auth";

export const Route = createFileRoute("/login")({
  component: LoginRoute,
});

const clientIdSchema = z.string().trim().min(1, "Client ID is required.");
const clientSecretSchema = z.string().min(1, "Client secret is required.");
const scopeSchema = z.string().trim();

const loginDefaultValues = {
  clientId: "helix-local-oauth-client",
  clientSecret: "",
  scope: "platform.read mail.read chat.read docs.read drive.read calendar.read",
};

function LoginRoute() {
  const navigate = Route.useNavigate();
  const [status, setStatus] = useState<"idle" | "submitting" | "ready">("idle");
  const [error, setError] = useState<string | null>(null);
  const loginForm = useForm({
    defaultValues: loginDefaultValues,
    onSubmit: async ({ value }) => {
      setStatus("submitting");
      setError(null);
      try {
        const token = await requestOAuthClientCredentialsToken({
          clientId: value.clientId.trim(),
          clientSecret: value.clientSecret,
          scope: value.scope.trim(),
        });
        storeAccessToken(token.accessToken);
        setStatus("ready");
        await navigate({ to: "/mail", search: { message: undefined, thread: undefined } });
      } catch (caught) {
        setStatus("idle");
        setError(caught instanceof Error ? caught.message : "Sign in failed.");
      }
    },
  });

  return (
    <main className="auth-screen">
      <section className="auth-panel">
        <div className="brand-mark" aria-hidden="true">
          H
        </div>
        <h1>Sign in to Helix</h1>
        <p>Use OAuth client credentials from a seeded local or deployed Helix client.</p>
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            void loginForm.handleSubmit();
          }}
        >
          <loginForm.Field name="clientId" validators={{ onChange: validateWith(clientIdSchema) }}>
            {(field) => (
              <label>
                <span>Client ID</span>
                <Input
                  autoComplete="username"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  required
                />
                <FieldErrors errors={field.state.meta.errors} />
              </label>
            )}
          </loginForm.Field>
          <loginForm.Field
            name="clientSecret"
            validators={{ onChange: validateWith(clientSecretSchema) }}
          >
            {(field) => (
              <label>
                <span>Client secret</span>
                <Input
                  autoComplete="current-password"
                  type="password"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  required
                />
                <FieldErrors errors={field.state.meta.errors} />
              </label>
            )}
          </loginForm.Field>
          <loginForm.Field name="scope" validators={{ onChange: validateWith(scopeSchema) }}>
            {(field) => (
              <label>
                <span>Scopes</span>
                <Input
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldErrors errors={field.state.meta.errors} />
              </label>
            )}
          </loginForm.Field>
          {error === null ? null : <p role="alert">{error}</p>}
          <Button disabled={status === "submitting"} type="submit">
            <LogIn aria-hidden="true" />
            {status === "submitting" ? "Signing in" : "Sign in"}
          </Button>
        </form>
      </section>
    </main>
  );
}

function validateWith(schema: z.ZodString) {
  return ({ value }: { readonly value: string }) => {
    const result = schema.safeParse(value);
    return result.success ? undefined : result.error.issues[0]?.message;
  };
}

function FieldErrors({ errors }: { readonly errors: readonly unknown[] }) {
  const messages = errors.filter((error): error is string => typeof error === "string");
  return messages.length === 0 ? null : <span role="alert">{messages.join(" ")}</span>;
}
