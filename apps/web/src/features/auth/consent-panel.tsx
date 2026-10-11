/* OAuth 2.1 consent: which app wants access and what it will be able to do.
   Allow or Deny posts the decision back to POST /oauth/authorize, which
   redirects to the app. */

import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { AuthCard } from "./auth-card";

export interface ConsentSearch {
  readonly response_type: string;
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly code_challenge: string;
  readonly code_challenge_method: string;
  readonly scope?: string;
  readonly state?: string;
}

export function ConsentPanel({ search }: { readonly search: ConsentSearch }) {
  const [submitting, setSubmitting] = useState(false);
  const scopes = parseScopes(search.scope);
  const missingParams =
    search.client_id.length === 0 ||
    search.redirect_uri.length === 0 ||
    search.code_challenge.length === 0;

  if (missingParams) {
    return (
      <AuthCard
        title="This sign-in link doesn’t work"
        subtitle="The app that sent you here left out required details. Go back to the app and try again."
        status={{ tone: "danger", icon: <TriangleAlert /> }}
      >
        <p role="alert" className="auth-error">
          This authorization request is missing required parameters and cannot be completed.
        </p>
      </AuthCard>
    );
  }

  const submitDecision = (decision: "approve" | "deny") => {
    // POST the decision as a native form so the browser follows the 302
    // redirect that POST /oauth/authorize issues to the client redirect_uri.
    setSubmitting(true);
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/v1/oauth/authorize";
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
    <AuthCard
      wide
      title="Allow access to your account?"
      subtitle={
        <>
          <strong>{search.client_id}</strong> wants to use your Helix account.
        </>
      }
    >
      <h2 className="auth-section-title" id="consent-scopes">
        It will be able to:
      </h2>
      <ul className="auth-scope-list" aria-labelledby="consent-scopes">
        {scopes.length === 0 ? (
          <li>See basic information about your account</li>
        ) : (
          scopes.map((scope) => (
            <li key={scope}>
              <code>{scope}</code>
            </li>
          ))
        )}
      </ul>
      <p className="auth-fineprint">
        Only allow apps you trust. You can remove this access later from your account.
      </p>
      <div className="auth-actions">
        <button
          className="btn ghost"
          disabled={submitting}
          type="button"
          onClick={() => {
            submitDecision("deny");
          }}
        >
          Deny
        </button>
        <button
          className="btn primary auth-submit"
          disabled={submitting}
          type="button"
          onClick={() => {
            submitDecision("approve");
          }}
        >
          Allow
        </button>
      </div>
    </AuthCard>
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
