# Helix Bot: local development and trusted installation

Updated 2026-10-16. This runbook describes the local working tree and development
services on `beastnode1`. Both repositories are now under `/home/mj/mjcode/helix-all`.
The apps remain independently deployable and connect through approved per-bot accounts,
not shared database access. This runbook does not claim a production deployment.

## Connect to the running development stack

| Surface                    | Address                                         |
| -------------------------- | ----------------------------------------------- |
| Web and human approval UI  | `http://localhost:5173`                         |
| Direct REST base           | `http://127.0.0.1:3000`                         |
| MCP HTTP endpoint          | `http://127.0.0.1:3000/v1/mcp`                  |
| Tool inventory             | `http://127.0.0.1:3000/v1/api/tools`            |
| Human bot-account review   | `http://localhost:5173/admin/agent-credentials` |
| Human bot oversight        | Settings → Apps → Bot workspaces                |
| Captured development email | `http://localhost:29458` (Mailpit)              |

The API and web server listen on loopback. Another process on this host, including
Helix Bot, can connect directly. From your workstation:

```sh
ssh -N -L 5173:127.0.0.1:5173 -L 3000:127.0.0.1:3000 -L 29458:127.0.0.1:29458 mj@10.10.69.200
```

Open `http://localhost:5173`. The existing local demo administrator is
`admin@helix.local`; its development-only password is the admin entry in
`apps/helix/src/db/demo-seed/company.ts`. Do not use this seed account on a public
installation. The original local login configuration was retained; temporary
TOTP enrollment used to exercise sensitive-action verification was removed after
the approval test.

**Connect the Helix Bot installation with `setup.env`.** It is installed outside
the repository and readable only by the local user:

- `/home/mj/.local/state/helix-workspace-dev/setup.env`: **Helix Bot local setup**,
  trusted installation credential with `platform.read` and `agent.accounts.request`.
- `/home/mj/.local/state/helix-workspace-dev/beacon.env`: an **optional test fixture**,
  named Beacon, created solely to prove the approved-account path. Beacon is not
  the Helix Bot installation and is not required to connect it. It has its own
  `beacon@helix.local` mailbox; the local demo administrator owns it.
- `connection.json` in that directory contains their non-secret identity mapping.

Both keys expire after 30 days. Read these files into the connector's server-side
configuration; do not paste their contents into chat, model prompts or logs. The
setup key cannot read mail, files or chats. Beacon cannot approve accounts or enroll
other bots. No credentials were copied into Helix Bot automatically.

From this repository, test the **installation connection** with:

```sh
set -a
. /home/mj/.local/state/helix-workspace-dev/setup.env
set +a
pnpm exec tsx packages/cli/src/index.ts tool call platform.ping --json '{}'
pnpm exec tsx packages/cli/src/index.ts tool call agent.account.requests.list --transport mcp --json '{}'
```

Use the same key in `Authorization: Bearer …` for REST or MCP. For a remote MCP
client configure the full `/v1/mcp` endpoint. The CLI's `mcp serve` command is also
available as a stdio bridge. See the [handoff](../plans/2026-10-15-helix-bot-workspace-handoff.md)
for protocol negotiation, tool pagination, durable events and approval handling.

The current server supports protocol `2026-07-28` with `server/discover` and the
required per-request metadata; do not send an `initialize` request under that
version. Legacy `2025-06-18` negotiation is a separate supported path.

### Start, stop and inspect

```sh
systemctl --user status helix-workspace-dev-api helix-workspace-dev-web
systemctl --user restart helix-workspace-dev-api helix-workspace-dev-web
journalctl --user -u helix-workspace-dev-api -n 100
curl --fail http://localhost:5173/readyz
```

The user units are enabled. API source changes require an API restart; Vite handles
web changes. Existing `helix-local-dev` Docker infrastructure was reused and its
volumes were not reset. A database snapshot before the migrations is stored as
`/home/mj/.local/state/helix-workspace-dev/before-bot-integration.dump` (private).
The services depend on that Docker infrastructure remaining available.

Outbound mail is captured by local Mailpit, **not SES**. This stack has no public
inbound mail routing. Meet and external AI depend on their own configuration;
starting the API does not certify media recording, transcription or paid providers.

## Bot-side work before direct HTTP connection

Workspace's private HTTP connection has been tested. The initial read-only Bot
review found the following client constraints; these are historical findings,
not a fresh review of the other agent's ongoing changes:

- `apps/server/connections.ts`, `configuration()` rejects non-HTTPS URLs.
- `apps/server/connection-adapters.ts`, `http()` also rejects non-HTTPS URLs and
  uses `node:https.request` for every request.

The Bot integration agent should verify that the current connector has an
**administrator-configured internal Workspace endpoint**, permits HTTP only for that explicitly trusted connection,
and selects `node:http` for it. Preserve the existing credential, revocation,
timeout, response-size, hostname and redirect controls. Do not globally allow
arbitrary model-provided HTTP URLs or forward credentials across redirects.
Test approved Compose/Kubernetes service hosts, unapproved hosts, changed
configuration, redirects and revoked installation keys. Configure protocol
`2026-07-28` explicitly; the current HTTP connector supports that shape but its
default remains `2025-11-25`, which Workspace does not advertise.

The Workspace CLI can test the endpoint immediately, as shown above. Its stdio
bridge also works with compatible clients, but the current **Bot stdio adapter**
hardcodes `2025-11-25` too; it needs compatible negotiation before using that
bridge. Do not treat stdio alone as a verified workaround for Bot's current
connector. No changes were made in the sibling Bot repository.

## Trust the installation once, approve each bot

“Trusted installation” means an explicitly authorized non-human principal and
credential. It does not mean a trusted source IP, an administrator token, or an
exemption from Workspace authorization.

1. In Admin, create a dedicated agent/service identity for the installation, such
   as **Helix Bot — team cluster**. Keep it separate from individual bots.
2. In Agent credentials, issue that identity an expiring API key with only
   `platform.read` and `agent.accounts.request`. Credential issuance follows the
   organization's sensitive-action MFA and approval settings. Install the key
   in the Bot backend's secret store once; individual bot prompts never receive it.
3. When Bot needs a persistent account, generate and securely persist a new
   `helix_ak_` key locally. Submit `agent.account.request` with only its SHA-256
   hash and the requested identity/resources. The complete manifest, key format
   and examples are in the handoff. Ordinary bot scopes cannot include enrollment
   authority; a trusted installation cannot grant that authority to its children.
   Submission runs immediately under the installation's enrollment permission;
   there is no preliminary action approval by default. A credential explicitly
   configured to always require confirmation still honors that override.
4. Workspace notifies eligible administrators and puts the request in Admin →
   Agent credentials → Bot account requests. An administrator chooses the human
   owner, expiry, verified email domain and exact granted scopes. Account approval
   requires a signed-in human session and follows sensitive-action policy.
5. Bot polls `agent.account.request.get` using the installation credential. Only
   after `approved` may it use the pre-generated bot key. Persist the returned
   account/credential IDs, approved scopes, address and credential expiry.
6. Every bot uses its own key for mail, files, chats and events. Resource sharing
   and external-mail/action approval policies still apply. Routine internal
   collaboration uses the approved scopes without repeated approval. Observers see only the bots they
   are authorized to observe; oversight does not grant sending authority.

Retry a lost request with the **same** installation principal, external bot ID,
manifest and key hash. Changed manifests conflict rather than creating another
account. Rejecting or expiring a request never activates its proposed key.

Revoke the setup credential to stop new requests. Disable the installation
principal to block approval of its pending requests too. Already approved bots
have independent credentials: revoke/disable them explicitly if removing the
installation. Revocation is not a cascading deletion of their mail or files.
Do not delete/recreate the installation principal during routine key rotation;
request ownership is tied to that principal.

### Local enrollment recovery: Juniper, Scout and Forge

On 2026-10-16, the three initial submission actions expired before creating
account requests. After removing the redundant default submission confirmation,
their original manifests and key hashes were resubmitted under the same trusted
installation. The user then explicitly approved all three accounts. Each now has
its requested `@helix.local` mailbox and original 15 approved scopes, owned by the
local demo administrator, with credentials expiring 2026-11-15. Their original
bot keys remain valid; no replacement key needs to be installed.

| Bot     | External bot ID                        | Account request ID                     |
| ------- | -------------------------------------- | -------------------------------------- |
| Juniper | `fa9cbef2-c22a-4efa-b0af-13ea8f28618c` | `945bde20-d84c-4ed6-ad5e-4cdada823663` |
| Scout   | `01ae1a3f-c0ce-4088-981c-e9747908be6b` | `aa184f54-6f41-4af0-b227-1ee12def7908` |
| Forge   | `9922be35-af3e-4822-be7c-4bc40f4b82aa` | `62a24aee-2711-4d92-80e0-2a7f4d2f79b6` |

Bot's connector should reconcile these through `agent.account.requests.list`
using the installation credential, match `externalBotId`, then persist the new
request ID and returned `reviewUrl`. Keep the original locally stored bot keys.
The old `/approvals/...` links describe expired submissions; the account reviews
are at `http://localhost:5173/admin/agent-credentials?botRequest=<request-id>`.
All 15 originally requested scopes were approved, including Meet. Actual Meet
media still requires configured dependencies. New requests can also request
`chat.create`; the original credentials retain their approved scope set and can
use `chat.dm.open` with `chat.post` for direct/group conversations.

### Local collaboration verification — 2026-10-16

Live checks used Juniper, Scout and Forge's actual Workspace identities with
separate temporary credentials carrying their original approved scopes:

- MCP direct/group chat creation, participant-set reuse, message exchange and
  private-conversation denial.
- Internal email and reply delivered to the respective bot mailboxes, with read
  state changes and no per-message approval.
- Real object-store upload and malware scan, private-file denial, inherited
  reader/editor sharing, owner-only resharing and immediate access revocation.
- Human-session chat replies readable by bots, a bot-shared file readable by a
  human, and a human-shared editable folder accepting a bot's contribution.
- The CLI `chat dm` command reused the expected direct conversation.

All temporary bot credentials were revoked and returned HTTP 401 afterward; the
original approved credentials remain active. The temporary admin session and
MFA enrollment were removed, restoring the original local login configuration.
Test conversations/files remain available as development artifacts.

Regression checks passed: formatting, TypeScript, lint, full workspace tests,
build and dependency boundaries; 12 database integration tests exercised local
mail routing changes, chat privacy, sharing and account isolation. Ten Playwright
checks covered account review, approval handling, unread indicators and included
accessibility scans. The default full test run skips environment-dependent suites;
these focused live/database checks provide the additional evidence above.

These are Workspace endpoint checks, not an end-to-end Bot model/orchestrator or
same-server deployment certification.

## Coordinated local development and same-server rollout

Once the user moves Helix Bot beside this repository, keep the two repositories
separate and coordinate contract changes with their callers in the same work
session. Do not copy credentials or generated files between them. Update the
[handoff](../plans/2026-10-15-helix-bot-workspace-handoff.md) whenever a tool, scope,
event or approval contract changes.

Before deploying both applications together, run the collaboration checks through
Bot's actual connector: request/approve an account, exchange human/bot and bot/bot
chats and internal mail, upload/scanned-download/share files, change roles, revoke
access, and verify private resources remain inaccessible. Workspace endpoint tests
alone do not certify Bot's orchestration or reconnect behavior.

Then deploy both services on one private network using the addresses below.
Keep the trusted installation credential separate from per-bot keys. Exercise the
same checks on that server, plus restart/reconnect, event delivery, credential
revocation and external-mail human approval. The development stack and seed login
are not a production deployment template.

## Docker Compose: private HTTP

Use **two addresses**:

- Helix's browser/OAuth origin: e.g. `https://workspace.example.com`.
- Bot's service connection: `http://helix:3000`, where `helix` is the Compose
  service name on their shared private network.

Keep `HELIX_PUBLIC_URL` and `BETTER_AUTH_URL` set to the browser/OAuth origin on
Helix. Set `HOST=0.0.0.0` inside the API container so its private network interface
can accept connections. Set the Bot connector/CLI's `HELIX_BASE_URL` to
`http://helix:3000` and supply its setup key through a secret. The MCP endpoint is
`http://helix:3000/v1/mcp`. No API container host-port publication is needed for
communication on that network.

API-key REST, MCP and event streams support HTTP service addresses. They do not
require changing the OAuth issuer to an internal hostname. OAuth browser flows
continue through the public origin. For an entirely local development stack,
`http://localhost:5173` is a valid browser origin; arbitrary plain-HTTP non-loopback
OAuth issuers are intentionally rejected.

The `HELIX_*` client variables are supported by Workspace's CLI. Helix Bot's
adapter must map its connection settings to the same base URL and bearer key;
this document does not assume it already consumes those environment variables.

Plain HTTP leaves tokens and content readable on that network. Use it within a
controlled private network, restrict which workloads may join, and use TLS or
mesh mTLS where the infrastructure/network is shared with untrusted workloads.
Do not expose the API port directly to the public Internet.

## Kubernetes: the same contract through a ClusterIP Service

With the existing Helm chart, the default Service port is **80**, targeting the
API container's port **3000**. For release/fullname `helix` in namespace `workspace`:

```text
REST/client base: http://helix.workspace.svc.cluster.local
MCP endpoint:    http://helix.workspace.svc.cluster.local/v1/mcp
```

Use the actual rendered Service name/port if you override them. Keep the public
HTTPS ingress for humans and OAuth. Inject the installation key from a Kubernetes
Secret into the Bot backend, using a secret reference rather than a literal value
in a Deployment or Helm values file. For the Workspace CLI, the Pod fragment is:

```yaml
env:
  - name: HELIX_BASE_URL
    value: http://helix.workspace.svc.cluster.local
  - name: HELIX_API_KEY
    valueFrom:
      secretKeyRef:
        name: helix-workspace-installation
        key: api-key
```

The existing Workspace chart denies application ingress by default. Add this
entry to `networkPolicy.application.ingress`, preserving existing entries:

```yaml
networkPolicy:
  application:
    ingress:
      - namespace: bots
        serviceAccount: helix-bot
        podLabels:
          app.kubernetes.io/name: helix-bot
```

Bot Pods must use service account `helix-bot` and labels
`helix.io/service-account: helix-bot` and `app.kubernetes.io/name: helix-bot` in
namespace `bots`, matching that rule. Restrict who can create workloads in that
namespace. If Bot also has an egress-deny policy, allow DNS and TCP 3000 to the
Workspace API Pods (the Service maps port 80 to 3000), plus its required model
providers. Apply these rules with a NetworkPolicy-capable CNI. Do not substitute
an allow-all policy or disable authentication to make discovery work.

Configure long-lived HTTP/SSE connections and reconnect cursors for live events;
do not buffer the event stream in a proxy. Bot can initiate its connections to
Workspace, so a callback port on Bot is not required for the pull/live protocol.

Drive transfer URLs are a separate reachability concern: `RUSTFS_PUBLIC_ENDPOINT`
must produce presigned URLs reachable by their consumers, including browsers and
Bot. Do not rewrite signed URL hosts. An internal API address alone does not make
a loopback storage URL reachable from another Pod or container.

### Verification boundary

Local tests exercised credential issuance, account approval, tenant/observer
separation, current MCP discovery/calls, REST/CLI access and private-HTTP hostname
handling from a container. The container hostname test used a host-network alias;
it is not evidence of a real Kubernetes installation, CNI policy or ingress test.
Use the Helm/network settings above when deploying and repeat the connection and
negative-permission checks in that target cluster before enabling real mail.

The October 16 follow-up did qualify the rendered CNPG database/migration resources
on an isolated three-node Kubernetes cluster: fresh migrations, tenant/RLS checks,
allowed/denied network traffic, Barman backup, WAL recovery to a named point, and
primary failover. Bot's own chart was booted separately in that cluster. The full
Workspace Kubernetes application and cross-pod connector still need a joint run.

In Bot's chart, put the setup credential in the existing credentials Secret (for example
key `workspace-installation.key`). Configure the connection using the application's
ordinary settings; do not put the credential itself in Helm values:

```yaml
configuration:
  helix_workspace:
    installations:
      - id: organization-workspace
        name: Organization Workspace
        origin: http://helix.workspace.svc.cluster.local
        browser_origin: https://workspace.example.com
        allow_private_http: true
        storage_origins:
          - https://files.example.com
        setup:
          tenant_id: REPLACE_WITH_BOT_TENANT_ID
          credential_file: /run/helix/private/workspace-installation.key
networkPolicy:
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: workspace
          podSelector:
            matchLabels:
              app.kubernetes.io/name: helix
              app.kubernetes.io/instance: helix
              helix.io/service-account: helix
      ports:
        - protocol: TCP
          port: 3000
```

Replace namespaces, release labels, URLs and the Bot tenant ID with the actual deployment.
Allow private object-store endpoints separately when used. Public storage uses the chart's
public HTTPS rule. The setup credential maps this connection to one Workspace organization;
each enrolled bot still needs human approval, its own credential and explicit resource grants.
For different hosts/clusters, use reachable HTTPS origins and trusted certificates instead
of copying a `.svc` name or granting direct database access.
