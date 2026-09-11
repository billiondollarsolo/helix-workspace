# Domains, user addresses, and email groups

One Helix user has one mailbox and a primary mail address. Additional addresses
deliver into that same mailbox; each can independently allow receiving and sending.
Adding an address does not create another user, inbox, or subscription.

## Domain choices

In **Admin → Domains**, add and verify each domain, then enable its mail and
identity capabilities. Enable aliases where additional addresses are needed.
Public mail also requires the receiving binding and DNS/MX setup shown in Admin.
Domain capability changes follow the workspace's configured sensitive-action MFA
and second-administrator approval requirements. Operators can choose these in
[Admin → Policies](account-offboarding-and-admin-safeguards.md#choose-administrator-safeguards),
including optional MFA and no second-party approval for a solo workspace. A
pending approval does not apply the requested change; domain permissions and
verification checks still apply when those safeguards are off.

- **Secondary domain:** assign primary addresses or individual aliases to selected
  users. Use this when only some users need addresses on another domain.
- **Alias domain:** point it at a verified secondary domain to automatically give
  that domain's users and mailing groups matching local-part addresses. It applies
  to the domain's identities, rather than a selected subset of users.

This matches Google's distinction between
[secondary and user alias domains](https://knowledge.workspace.google.com/admin/domains/add-a-user-alias-domain-or-secondary-domain).
Google also supports [individual aliases across account domains](https://developers.google.com/workspace/admin/directory/v1/guides/manage-user-aliases).

## User addresses

In **Admin → Users**, open a user's email addresses. Add addresses on eligible
verified domains, change their Receive / Send as settings, remove an alias, or
choose a new **Primary mail address**. Changing the primary preserves the old
primary as an additional address. Addresses cannot collide with another user,
alias, or group in the shared namespace.

The **Login email** remains the person's global authentication identity. Changing
a workspace mailbox address does not rename that login or replace the account.
This is a Helix distinction: one global login can belong to multiple workspaces.

Mail Compose and Reply offer a **From** selector containing currently authorized
sending addresses. Drafts preserve the selected address. If sending is revoked,
the user must choose an available address before sending that draft.

When [offboarding a user or agent](account-offboarding-and-admin-safeguards.md),
the administrator can hand owned resources to a successor and separately choose
whether to retain the listed old addresses as receive-only aliases. This never
grants Send as permission. Without that choice, future mail to the retired
addresses stops.

## Mailing groups

In **Admin → Groups**, create or edit a mailing group, assign its email address,
and add members. A post expands to its current active workspace members, with
duplicate recipients removed. Groups have no separate login or mailbox.

- **Organization only** is the default: authenticated senders in the same
  workspace may post, including senders on its other domains.
- **Anyone** also permits incoming external email.

An SMTP message does not become internal merely because its From address names
one of the workspace's domains. External forwarding retains external provenance.
Normal spam, scanning, quotas, and recipient authorization still apply.

Posting permission is separate from membership. Google's
[Groups Settings API](https://developers.google.com/workspace/admin/groups-settings/v1/reference/groups)
also separates who may post from whether external members may join. Helix's
groups currently contain workspace actors; external member addresses, nested
groups, and moderation queues are not implemented.

## Local development

The seeded `helix.local` domain is a synthetic local delivery fixture, not a
public DNS claim. Its existing operator settings are preserved. If aliases are
off, they must be enabled through the protected domain-capability workflow
before adding individual aliases or mailing-group addresses. Automated integration
tests use separate verified synthetic-domain fixtures in an isolated database;
they do not change the live domain's authentication or approval policy. The local
workspace's operator explicitly selected optional administrator MFA and disabled
sensitive-action MFA and second-admin approval on 2026-09-10; those saved choices
do not enable domain capabilities automatically or change other installations.
