# Provider-assisted setup proposal

Status: proposed; provider sign-in and automatic infrastructure changes are
not implemented. The public [admin guide](../../apps/web/public/admin-setup.md)
and [agent guide](../../apps/web/public/agent-setup.md) describe current manual
setup and supported Helix credentials.

The first implementation should connect Cloudflare DNS and AWS SES. Keep manual
setup available. A connected account does not authorize arbitrary provider
changes: the administrator chooses the zone, sending domain and AWS region.

## Administrator flow

1. Connect the provider with its supported delegated authorization or a scoped
   credential. Explain the resources and permissions before connection.
2. Read existing configuration and show a concrete plan: each DNS record, SES
   identity and mail setting to create or change, with current and proposed
   values. Flag conflicting MX records and an existing mail provider.
3. Require an administrator's approval of that exact plan. Reuse Helix's action
   approval and audit mechanisms. An agent may prepare a plan; it cannot approve
   its own request or read the provider secret.
4. Apply only approved changes. Check the observed configuration again before
   writing so another administrator's intervening change is not overwritten.
   Retry safely; record partial progress and compensating changes.
5. Verify authoritative DNS, public resolution, identity/DKIM status, SMTP
   delivery and a real inbound test separately. Show pending propagation and
   provider sandbox restrictions as actionable steps.
6. Offer disconnect and credential revocation. Preserve configuration the
   administrator wants to keep; deleting infrastructure is a separate approval.

## Provider connections

Cloudflare now supports [OAuth applications](https://developers.cloudflare.com/fundamentals/oauth/)
on all plans. A Connect Cloudflare button requires a registered OAuth client,
configured redirect URLs and the appropriate provider permissions; it is not
available just because the user can log in to Cloudflare. Follow its
[client registration](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)
and integration requirements. Bind authorization state to the administrator's
session and tenant, validate the callback origin, and use PKCE where supported.
For self-hosted installations, offer a zone-scoped DNS API token as the manual
fallback. Never request the global API key or account password.

For AWS, prefer short-lived credentials or a dedicated, narrowly scoped role.
A self-hosted Helix server must already have an authenticated AWS principal or
configured federation before it can assume a role. Provide a guided policy and
trust setup for SES in the selected account and region; do not imply that an AWS
console sign-in popup grants API access. Cross-account access must use a
tenant-bound external ID and explicit trust, following
[AWS's third-party role guidance](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_common-scenarios_third-party.html).
Do not request root credentials. SES API setup credentials and the separate
SMTP delivery credential have different purposes and lifecycles.

Store provider credentials through Helix's existing tenant secret encryption.
Return only opaque connection handles to MCP/CLI. Enforce tenant, zone, account,
region and operation scopes server-side; exclude keys, tokens and authorization
codes from logs, audit payloads, prompts and the public guides. Record who
connected, approved and executed each change, plus its verified result.

Add other providers only when their real authorization flow and supported
configuration APIs have been checked. The shared user flow can stay the same;
permissions, identity setup and verification remain provider-specific.
