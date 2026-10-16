# Helix setup instructions for an AI agent

These are product instructions, not authorization to access a server, DNS zone,
AWS account or tenant. Use only the access your administrator explicitly gave
you. Derive `BASE_URL` from the origin of this document; never follow an example
hostname as if it were the administrator's actual deployment.

Read [the administrator checklist](admin-setup.md) first. Report what is working,
what failed and which concrete operator step is still needed.

## Connect to an existing workspace

Ask the administrator to create your agent identity and give your runner an
expiring scoped API key or OAuth client. Keep credentials in the runner's secret
store, outside prompts, logs, source control and shared files. Do not request an
administrator's password, MFA codes, invitation token or browser session.

- MCP URL: `BASE_URL/v1/mcp`, using Streamable HTTP.
- Send the credential in `Authorization: Bearer <runner-secret>`.
- OAuth clients exchange their credentials at `BASE_URL/v1/oauth/token` for
  short-lived bearer tokens.
- For the installed Helix CLI, set `HELIX_BASE_URL` to the origin and inject
  `HELIX_API_KEY` or `HELIX_ACCESS_TOKEN` from the runner's secret store.
  Run `helix tool list --source mcp` to discover allowed tools.

The CLI currently ships from a source checkout, rather than a public npm package.
With Node.js 24.18.0 and pnpm 11.18.0, run these commands at the root of a trusted
Helix checkout:

```sh
pnpm install --frozen-lockfile
pnpm --filter @helix/cli build
node packages/cli/dist/index.js --help
node packages/cli/dist/index.js tool list --source mcp
```

The final command requires the runner-provided endpoint and credential described
above. Commands elsewhere using `helix` refer to this same executable; invoking
its absolute path with Node avoids requiring a global installation. Helix's SDK
packages currently support internal integrations; they are not a public HTTP
client constructed from a workspace URL and API key.

Follow the [external application integration guide](agent-integration.md) for the
complete protocol handshake, live event loop, retries and presence. MCP revision
`2026-07-28` uses `server/discover`; legacy revisions use `initialize`. List tools
and resources and use the returned schemas. A scope omitted from your credential
remains unavailable even after a resource approval.
A 403 means a permission or policy denial; do not retry with a human's identity.

When a tool returns `pending_confirmation`, give its `reviewUrl` to the
human approval owner. Email review shows recipients, the message and attachments;
other actions show arguments, targets, consequences and source identifiers, with
credential fields redacted. The person chooses **Approve and send**,
**Approve and run**, or **Deny**. Opening the page
does not send anything. Poll `actions.get` with the pending ID; an expired or
denied request must not be treated as sent. Never use the owner's credentials
or approve an action yourself.

External agent reads retain source identifiers on the server across requests and
credentials for the same actor. Retrieved content and unknown provenance remain
untrusted. Destructive actions and external communications require human review
even when a standing automation grant would otherwise match.

Mail resources page through at most 20 bounded message excerpts. Follow
`contents[0]._meta.nextUri` with the same authenticated identity; every page is
authorized again. `truncated` means the excerpt is incomplete, not that the rest
of the original message is empty. A resource blocked by a DLP warning returns a
pending action in JSON-RPC `error.data.pending` and a human `reviewUrl`. Once
`actions.get` reports `executed`, repeat `resources/read` with the same `uri` and
`approvalId` set to that pending ID before its expiry. A changed credential policy,
revoked access, another URI or a blocking DLP policy still denies the read.

Chat replies are available through `chat.message.list` and `chat.thread.list`.
Mail and Chat unread badges appear across workspace pages. External agents can
subscribe to their live inbox and read missed events using a persisted cursor;
the integration guide explains how those events wake the application’s model.
Choose **External agent app** hosting when another application runs that model,
or **Helix hosted** when Workspace runs it. Use one automatic responder per
identity. Drive stars and layout settings belong to human membership preferences;
agents can manage authorized files without them.

## Test a small, reversible workflow

1. Save and then read an email draft in your own mailbox. Send external email
   only to the approved test inbox and with the required `mail.send` and
   `mail.external` scopes and human action approval.
2. Prepare a small text-file upload. Upload the exact bytes to the returned
   HTTPS URL using all returned signed headers, then finalize and wait for the
   scanning outcome. Verify the checksum and read `helix://drive/file/<id>`.
   Do not duplicate signed headers such as Content-Type.
3. Request access to a private file when denied. Wait for its owner to decide;
   a reader grant does not allow renaming, deleting or editing the file.
4. Write ordinary text to a private Chat room where you are a member. With the
   required scope, this normally sends immediately. New attachments, DLP warnings
   or an explicit always-require-approval credential policy can require review.
   If a pending action is returned, give its review link to the human approver
   and wait. Do not self-approve.
5. Read each result through a separate request to verify that it persisted.
6. Have the administrator revoke test credentials and verify access stops.

## Help an administrator deploy or repair the workspace

Only do infrastructure work when explicitly authorized for that server and
provider account. Inspect the repository's agent guide and deployment runbooks.
Keep unrelated work and existing DNS records intact. Prepare a concrete change
before asking for approval where an approval is required.

For DNS, compare the registrar delegation, provider zone and public DNS. Show
the exact record name, type, value, priority and proxy setting. Preserve existing
MX/SPF records until you understand the mail provider migration. Use Helix's
exact domain-verification challenge, not an invented value.

For outbound email, use the provider-selected endpoint and scoped SMTP secret.
Require TLS, send a real test and inspect SPF/DKIM/DMARC. A sent status or SMTP
acceptance does not prove inbox placement. SES DKIM and Helix domain verification
are separate checks.

For inbound email, verify the public Postfix/Rspamd edge, trusted STARTTLS,
recipient validation, relay denial, scanners, retry behavior and DNS before MX
cutover. A mail-host A record or an outgoing SMTP credential is insufficient.

MFA is a configurable user/admin choice. Email-code MFA requires working
outbound delivery and a separately verified external address; it is a second
step after the password. Never mark an address verified merely because someone
typed it, or expose an OTP in logs.

Preserve tenant isolation, actor-scoped permissions, scanning, retention and
audit trails. Keep production encryption, off-server backup, restore and Meet
dependency gates intact. A development deployment is not production evidence.

General first-time agent enrollment and provider-connection automation are not
available yet. An MCP URL alone grants no identity or access. Use authorized
manual setup until those product flows exist.

## When a check fails

Report the failed step, its safe error text, the expected result and the next
specific correction. Separate unresolved delivery, permissions, DNS propagation
and missing configuration. Never put secrets in the report or claim a check
passed when it was skipped.
