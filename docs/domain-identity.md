# Domain and identity model

Helix has one domain aggregate: `admin_domains`. A domain claim is global, while
all access to the claim remains tenant-scoped. Mail, login, aliases, SSO
discovery, and custom-host routing consume this record; there is no separate
mail-domain registry.

## Ownership lifecycle

| State         | Meaning                                        | Capabilities                                        |
| ------------- | ---------------------------------------------- | --------------------------------------------------- |
| `pending`     | DNS ownership has not been proved.             | All off.                                            |
| `verified`    | The server-owned DNS challenge passed.         | Explicitly enabled per domain.                      |
| `quarantined` | Ownership was lost or an operator stopped use. | All off immediately.                                |
| `released`    | The workspace relinquished the claim.          | All off; claim retained as history during cooldown. |

A normalized domain can have only one active claim across all workspaces.
Pending, verified, and quarantined claims therefore block every other
workspace. Release is allowed only after users, aliases, groups, and domain
aliases have moved away. A released name remains reserved to its former owner
for seven days, after which another workspace may claim it.

Verification is the prerequisite for every capability:

- `identity_enabled` permits member identities and login discovery.
- `mail_enabled` permits inbound and outbound mail.
- `aliases_enabled` permits explicit addresses and domain aliases.
- `custom_host_enabled` permits exact-host tenant routing.
- `federation_enabled` permits SAML/OIDC discovery for the domain.

Verification leaves every capability off. Enabling the first secondary identity
domain also makes it primary in the same audited transaction.

Capabilities cannot contradict lifecycle or dependencies. In particular,
custom-host and federation require identity, a mail provider requires mail, and
an active user, group, alias, IdP, or domain alias prevents disabling the
capability it consumes.

## Secondary domains and domain aliases

A **secondary domain** is an independent identity namespace. For example,
`alex@north.example` and `alex@south.example` may be different users.

A **domain alias** maps every local part to one verified secondary domain. If
`old.example` aliases `new.example`, login and inbound delivery for
`alex@old.example` resolve to the identity `alex@new.example`. A domain alias
does not create a second user, group, permission principal, mailbox, or sharing
identity.

Only a verified identity domain may be an alias target. The source and target
must belong to the same workspace, and quarantining the target quarantines its
domain aliases. Explicit mail aliases remain available for mappings whose local
parts differ, such as `help@old.example` to a support mailbox.

## Login, mail, groups, and sharing

Pre-auth discovery accepts an email address and returns only the active
workspace slug, canonical address, and eligible primary SAML/OIDC protocol. It
does not expose internal tenant identifiers. Pending, quarantined, released,
disabled, or suspended workspaces fail closed.

Password/session lookup canonicalizes a domain-alias login before resolving the
actor. Inbound SMTP applies the same mapping, then requires a verified domain
with identity and mail capabilities plus an active actor membership. Outbound
mail permits the actor's canonical address, an explicit enabled alias, or the
corresponding local-part address on a domain alias; every route is tenant-bound.

User, explicit-alias, and group addresses share one canonical namespace.
Concurrent writes are serialized and collisions are rejected, including
collisions that appear only after domain-alias canonicalization. Group addresses
require alias and mail capabilities. Permissions and shares reference actor or
group IDs, so changing an address or primary domain does not rewrite grants.
Deprovisioning a membership immediately removes login and mail routing without
destroying historical permissions or messages.

## Primary transitions and renames

Each workspace with at least one verified secondary identity domain has exactly
one primary. A promotion is a single database transaction under a tenant lock,
accepts only a verified secondary identity domain, refuses to drop capabilities
provided by the old primary, and writes an immutable transition record. A
workspace may promote once per hour. The latest transition can be rolled back
for 24 hours if its old domain remains verified and still satisfies the same
dependencies. Concurrent requests converge on one primary.

Changing the primary does **not** rename users. This keeps SSO, mail, sharing,
and saved login identifiers stable. For an intentional address migration:

1. Verify the destination secondary domain and enable the capabilities used by
   the source domain.
2. Rename users through SCIM (or an equivalent transactional directory update),
   which updates the actor and linked global identity subject together.
3. Move explicit aliases and group addresses, resolving any canonical collision.
4. Convert the old secondary domain to a domain alias of the destination to
   preserve old login and mail addresses.
5. Promote the destination. Observe the one-hour cooldown and keep the old
   domain verified through the 24-hour rollback window.
6. Release the old domain only when no directory, mail, group, or alias
   dependency remains.

If verification later fails, Helix quarantines that domain and its aliases,
turns off every capability, and promotes a deterministic verified replacement
when one exists. Operators must repair DNS and reverify before restoring
capabilities.
