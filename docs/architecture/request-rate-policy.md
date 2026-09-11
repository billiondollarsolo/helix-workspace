# HTTP request rate policy

Verified human sessions have a sliding allowance of 120 requests per ten seconds,
per organization and actor. Admin REST and tRPC requests use a separate allowance,
so a busy workspace tab cannot consume the requests needed for admin controls.
Other people in the organization also retain their own allowance.

The existing `api_rps_limit` tenant quota applies to integration API and agent
credentials, and requests without a verified human session. A bearer token or API
key retains that quota even when accompanied by a valid session cookie. A cookie
name, client identity header, user-agent, or admin URL does not establish a human
session: the existing Better Auth verifier, active membership, tenant binding,
and session policy must succeed. The verified result is cached only for the
current HTTP request, including its admin session policy check.

Both Redis and the in-memory limiter enforce these windows atomically. A refused
request receives HTTP 429 and `Retry-After`. Browser responses identify their
policy and ten-second window in `x-helix-rate-limit-policy` and
`x-helix-rate-limit-window-ms`, with `x-helix-browser-rate-limit-*` counters.
Integration requests retain their `x-helix-quota-api-rps-*` counters. Browser
abuse therefore remains bounded without changing tenant integration quotas.

Authentication routes retain their separate controls. Existing action, AI cost,
and concurrent stream limits also remain in force. The notification feed loads
when opened; the shell's shared core-apps query is deduplicated across consumers.
Read retries remain limited to three attempts after a 429, respecting
`Retry-After`; mutations are not automatically replayed.
