import { createFileRoute } from "@tanstack/react-router";
import { ConsentPanel, type ConsentSearch } from "@/features/auth/consent-panel";
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
  return <ConsentPanel search={Route.useSearch()} />;
}
