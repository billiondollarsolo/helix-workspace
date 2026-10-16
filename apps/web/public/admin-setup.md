# Set up Helix

Use the origin of this page as your workspace URL. For example, if you opened
`https://workspace.example.com/admin-setup.md`, your workspace domain is
`workspace.example.com`. Keep this checklist open while working in Admin.

## 1. Sign in as the administrator

Your server operator provides a single-use owner invitation. Open it, choose a
password and select **Join workspace**. The invitation creates your sign-in;
publishing a DNS record does not create an administrator account.

In **Settings → Security**, you can add a passkey, scan an authenticator QR code,
or verify an external email address and enable email codes. Email codes require
working outbound mail. Workspace MFA requirements are controlled separately in
**Admin → Security → Policies**.

## 2. Verify your workspace domain

Open **Admin → Domains**, add the workspace domain and copy the exact TXT
challenge Helix gives you. Add it at your DNS provider, then select Verify.
Enable the domain's identity and mail capabilities after it is verified.

For Cloudflare, first confirm the registrar uses the nameservers Cloudflare
assigned to your zone. Records in an inactive zone will not work publicly.

| Record                 | Value                                           | Cloudflare proxy                                     |
| ---------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| Workspace A            | Your web server's public IPv4 address           | Proxied when the server is configured for Cloudflare |
| Mail-host A            | Your incoming mail server's public IPv4 address | DNS only                                             |
| Helix verification TXT | Exact name and challenge shown in Admin         | DNS only                                             |

Check public DNS as well as the provider's dashboard. The web URL must have a
trusted HTTPS certificate, and API, databases and private service ports must
remain protected.

## 3. Configure outgoing mail

Choose an SMTP provider. For Amazon SES:

1. Select the AWS region you will use for sending.
2. Create a domain identity for your workspace domain.
3. Copy every Easy DKIM CNAME from SES into your DNS provider. Wait for SES to
   confirm the identity and DKIM configuration.
4. Create SMTP credentials. SES supports its Mail Manager credential flow and
   its IAM SMTP credential flow; use the exact endpoint and credentials shown
   by the flow you chose. Credentials are region-specific.
5. Give the server operator the credentials through a secure secret store.
   Configure SMTP port 587 with required STARTTLS and certificate verification.
6. Send a message from Helix to an external inbox. Check both delivery and
   Gmail's **Show original** authentication results. SMTP acceptance alone
   does not prove inbox delivery.

Provider API credentials and SMTP credentials serve different purposes. Do not
enter an AWS console password or an AWS access key as an SMTP password.
If SES is still in its sandbox, the external test recipient must be verified
or the account must have production sending access.

Publish `_dmarc.<workspace-domain>` TXT `v=DMARC1; p=none` while checking
authentication. A valid, aligned DKIM signature can satisfy DMARC. A custom SES
MAIL FROM such as `bounce.<workspace-domain>` is optional for DKIM alignment;
if you enable it, copy the region-specific MX and SPF records SES supplies.
That bounce MX is separate from the inbox MX.

## 4. Configure incoming mail separately

Outgoing SMTP setup does not make replies arrive. Your server operator must
first deploy the incoming Postfix/Rspamd edge with a trusted certificate,
recipient checks, relay rejection, scanners, queue/retry handling and public
TCP port 25. Helix's private receiver stays behind that edge.

After the edge passes its deployment checks, publish:

| Record                           | Value                                                      |
| -------------------------------- | ---------------------------------------------------------- |
| Workspace-domain MX, priority 10 | Your mail host, for example `mail.workspace.example.com`   |
| Mail-host A                      | The incoming mail server's address, DNS only in Cloudflare |

The operator also verifies PTR, SPF, DKIM, DMARC, MTA-STS and TLS reporting for
the deployment. Do not publish an MX to a web proxy or to an unready receiver.
Reply from an external inbox and confirm the message appears in your Helix
Inbox or its quarantine. Include this incoming test before declaring mail ready.

## 5. Connect an AI agent

In **Admin → Agents**, create an agent identity. Give it an expiring credential
with only the Mail, Drive or Chat scopes its task needs. Assign its mailbox and
resource permissions separately. Store the credential in the agent runner's
secret store.

- MCP endpoint: `<workspace-url>/v1/mcp`
- Transport: Streamable HTTP
- Authentication: `Authorization: Bearer <agent-credential>`
- CLI base URL: `<workspace-url>`
- Instructions to give the agent: `<workspace-url>/agent-setup.md`

The agent can request access to resources and queue actions for approval. The
admin reviews those requests. Connecting to MCP does not create an identity,
credential or mailbox; general first-time agent self-enrollment is not available.

## 6. Verify readiness

- The administrator can sign in and open Admin.
- Domain verification and public HTTPS work.
- A Helix message reaches an external inbox with the expected authentication.
- A reply reaches Helix through the incoming edge.
- A scoped agent can discover its allowed tools, save a draft, upload/read a
  scanned file and send a Chat message with the required approvals.
- An unauthorized agent cannot read private data or approve its own requests.
- Revoking a credential stops API/MCP access, including previously issued OAuth
  tokens for a revoked client.
- Production storage, backup, restore and dependency gates are satisfied before
  production activation. A development test environment does not attest them.

## Provider connections

Automated AWS/Cloudflare setup is a proposed feature, not a connection offered
by this checklist. For now, an authorized operator applies provider changes.
Helix should show exactly what will change, obtain approval and verify the result
when provider automation is introduced.

## Official provider references

- [Cloudflare domain nameservers](https://developers.cloudflare.com/dns/nameservers/update-nameservers/)
- [SES identity and DKIM setup](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)
- [SES Mail Manager SMTP credentials](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials-mail-manager.html)
- [SES IAM SMTP credentials](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html)
- [SES DMARC alignment](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html)
