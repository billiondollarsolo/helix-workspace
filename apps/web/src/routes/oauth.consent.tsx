import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { optionalRawStringSearchParam, stringSearchParam } from "@/lib/search-params";

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

interface ConsentSearch {
  readonly response_type: string;
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly code_challenge: string;
  readonly code_challenge_method: string;
  readonly scope?: string;
  readonly state?: string;
}

export const Route = createFileRoute("/oauth/consent")({
  validateSearch: (search): ConsentSearch => ({
    response_type: stringSearchParam(search.response_type, "code"),
    client_id: stringSearchParam(search.client_id),
    redirect_uri: stringSearchParam(search.redirect_uri),
    code_challenge: stringSearchParam(search.code_challenge),
    code_challenge_method: stringSearchParam(search.code_challenge_method, "S256"),
    scope: optionalRawStringSearchParam(search.scope),
    state: optionalRawStringSearchParam(search.state),
  }),
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
