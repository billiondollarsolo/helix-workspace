import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";

/**
 * OAuth 2.1 Authorization Code consent screen (PRD §13.6).
 *
 * The Helix `GET /oauth/authorize` endpoint redirects the browser here with
 * the authorization-request parameters preserved in the query string. The
 * user reviews the requesting client and scopes and either approves or
 * denies; the decision is submitted back to `POST /oauth/authorize`, which
 * issues a single-use authorization code and redirects to the client's
 * `redirect_uri`.
 */

const consentSearchSchema = z.object({
  response_type: z.string().default("code"),
  client_id: z.string().default(""),
  redirect_uri: z.string().default(""),
  code_challenge: z.string().default(""),
  code_challenge_method: z.string().default("S256"),
  scope: z.string().optional(),
  state: z.string().optional(),
});

type ConsentSearch = z.infer<typeof consentSearchSchema>;

export const Route = createFileRoute("/oauth/consent")({
  validateSearch: (search): ConsentSearch => consentSearchSchema.parse(search),
  component: OAuthConsentRoute,
});

function OAuthConsentRoute() {
  const search = Route.useSearch();
  const [submitting, setSubmitting] = useState(false);
  const scopes = parseScopes(search.scope);
  const missingParams =
    search.client_id.length === 0 ||
    search.redirect_uri.length === 0 ||
    search.code_challenge.length === 0;

  if (missingParams) {
    return (
      <main className="auth-screen">
        <section className="auth-panel">
          <h1>Authorization request is invalid</h1>
          <p role="alert">
            This authorization request is missing required parameters and cannot be completed.
          </p>
        </section>
      </main>
    );
  }

  const submitDecision = (decision: "approve" | "deny") => {
    // POST the decision as a native form so the browser follows the 302
    // redirect that POST /oauth/authorize issues to the client redirect_uri.
    setSubmitting(true);
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/oauth/authorize";
    appendHidden(form, "response_type", search.response_type);
    appendHidden(form, "client_id", search.client_id);
    appendHidden(form, "redirect_uri", search.redirect_uri);
    appendHidden(form, "code_challenge", search.code_challenge);
    appendHidden(form, "code_challenge_method", search.code_challenge_method);
    if (search.scope !== undefined) {
      appendHidden(form, "scope", search.scope);
    }
    if (search.state !== undefined) {
      appendHidden(form, "state", search.state);
    }
    appendHidden(form, "decision", decision);
    document.body.append(form);
    form.submit();
  };

  return (
    <main className="auth-screen">
      <section className="auth-panel">
        <div className="brand-mark" aria-hidden="true">
          H
        </div>
        <h1>Authorize access</h1>
        <p>
          The application <strong>{search.client_id}</strong> is requesting access to your Helix
          account.
        </p>
        <p>It will be able to:</p>
        <ul aria-label="Requested scopes">
          {scopes.length === 0 ? (
            <li>Basic access</li>
          ) : (
            scopes.map((scope) => (
              <li key={scope}>
                <code>{scope}</code>
              </li>
            ))
          )}
        </ul>
        <div className="auth-form">
          <Button
            disabled={submitting}
            type="button"
            onClick={() => {
              submitDecision("approve");
            }}
          >
            Allow access
          </Button>
          <Button
            disabled={submitting}
            type="button"
            variant="outline"
            onClick={() => {
              submitDecision("deny");
            }}
          >
            Deny
          </Button>
        </div>
      </section>
    </main>
  );
}

function parseScopes(scope: string | undefined): readonly string[] {
  if (scope === undefined || scope.trim().length === 0) {
    return [];
  }
  return [...new Set(scope.split(" ").filter((token) => token.length > 0))];
}

function appendHidden(form: HTMLFormElement, name: string, value: string): void {
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = name;
  input.value = value;
  form.append(input);
}
