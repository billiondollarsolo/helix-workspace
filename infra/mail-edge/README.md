# Helix Internet mail edge

This reference deployment puts maintained Postfix and Rspamd components from
Docker Mailserver in front of Helix. Port 25 is the only published port. Postfix
accepts only configured relay domains, verifies recipients against Helix during
`RCPT TO`, and forwards accepted mail to the private Node receiver on port 2525.
Rspamd owns DNSBL/reputation, greylisting, phishing, duplicate, and message-rate
decisions; Postfix owns connection, recipient, size, timeout, tarpitting, TLS,
queue, and retry behavior. Helix remains responsible for tenant routing,
mailauth policy, quarantine, idempotency, and mailbox projection.

Copy `.env.example`, create the named private backend network, mount an
operator-managed certificate/key for `HELIX_MAIL_EDGE_HOSTNAME`, replace the
example domains, and run:

```sh
docker compose --env-file /run/secrets/helix-mail-edge.env \
  -f infra/mail-edge/compose.yaml up -d
pnpm infra:mail-edge:validate
HELIX_MAIL_EDGE_SMOKE_HOST=mx1.example.com \
HELIX_MAIL_EDGE_SMOKE_DOMAIN=example.com \
HELIX_MAIL_EDGE_SMOKE_RECIPIENT=probe@example.com \
  pnpm infra:mail-edge:smoke
```

Before DNS cutover, run the fail-closed public readiness check. It resolves MX,
forward-confirmed PTR, SPF, the active DKIM selector, DMARC, MTA-STS, and TLS-RPT,
then performs a trusted SMTP STARTTLS handshake against the named edge:

```sh
HELIX_MAIL_EDGE_DNS_DOMAIN=example.com \
HELIX_MAIL_EDGE_DNS_HOST=mx1.example.com \
HELIX_MAIL_EDGE_DNS_IP=203.0.113.10 \
HELIX_MAIL_EDGE_DKIM_SELECTOR=helix-202609 \
  pnpm infra:mail-edge:validate -- --dns
```

Do not point `MAIL_SMTP_HOST` at this inbound edge. Outbound mail must use a
separate authenticated provider or MTA endpoint with its own IP pool,
credentials, DKIM keys, bounce handling, and reputation. The edge exposes no
submission port and `PERMIT_DOCKER=none`; a compromised app/container therefore
cannot use the public listener as an outbound relay.

## DNS and operations prerequisites

Before advertising the edge, require all of the following:

- `A`/`AAAA` for the edge hostname and matching forward-confirmed `PTR` for every
  public SMTP IP.
- Each tenant domain's `MX` pointing to the edge hostname, plus SPF for the
  separate outbound provider, tenant DKIM selectors, and `_dmarc` policy.
- `_mta-sts`, `mta-sts.<domain>/.well-known/mta-sts.txt`, and `_smtp._tls` TLS-RPT.
- A resolver licensed and sized for the enabled Rspamd DNSBLs; public recursive
  resolvers are not suitable for production RBL traffic.
- Firewall access to public TCP/25 only. Keep the backend network, Rspamd
  controller, Redis, logs, and Helix port 2525 private.

Ship `/var/log/mail` to the existing log pipeline. Alert on Postfix
`NOQUEUE: reject`, `reject_unverified_recipient`, `too many connections`, queue
age/depth, TLS failures, and Rspamd `greylist`, `ratelimit`, `reject`, DNSBL, and
action counts. The daily `pflogsumm` report goes to the configured postmaster;
it supplements rather than replaces centralized alerting.

Run `pnpm infra:mail-edge:validate` in every configuration change. The live
smoke verifies trusted TLS, absence of AUTH, relay denial, message-size
enforcement, a known-recipient delivery, exact retry acceptance, and connection
pressure. The application duplicate tests prove that the two accepted copies
produce one mailbox mutation.
