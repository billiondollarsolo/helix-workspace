# Account offboarding and administrator safeguards

Offboarding removes an account's access to this workspace and can hand its owned
resources to another user or agent. It is not permanent deletion of the person's
identity or historical records. Administrator MFA and second-administrator
approval are separate operator choices under **Admin → Policies**.

## Preview and hand over an account

1. In **Admin → Users**, open the user or agent's details and select **Offboard
   account**. The operator needs account-management permission (`admin.users`).
2. Search for and select a different active user or agent in the same workspace
   as **New owner**. A successor is required if the source owns any transferable
   resources. With no resources, you may leave the successor empty.
3. Decide whether to **Keep receiving mail at the old addresses**. This is off by
   default. See the address behavior below before selecting it.
4. Select **Review handoff**. Check the source, successor, addresses, blockers,
   and the current counts of Drive files, Drive folders, mail messages, mail
   drafts, calendars, contacts, address books, Assistant conversations, and
   Assistant memories.
5. Resolve every blocker, review again if anything changed, and select
   **Offboard account** to apply the handoff.

Preview does not offboard the account. The final operation rechecks eligibility
and the preview token in the same database transaction as the handoff, access
retirement, audit record, and search-reindex request. If the UI reports that data
or eligibility changed (`409`), select **Review handoff** again; do not reuse the
old token. Changing the successor or address choice also requires a new preview.

The API exposes `POST /v1/api/admin/users/:actorId/offboard/preview` with optional
`successorActorId` and `preserveReceivingAddresses` fields. Execution uses
`POST /v1/api/admin/users/:actorId/offboard` with the same choices and the returned
`confirmationToken`. Both routes enforce workspace authorization.

### Blockers and recovery

| Blocker                                                               | Operator action                                                                                                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source is the current administrator                                   | Sign in as a different authorized administrator. Self-offboarding is blocked.                                                                       |
| Source is the last active workspace account administrator             | Add another active human administrator with account-management access first. An agent successor does not replace this requirement.                  |
| Source is a system account                                            | Use the account's supported lifecycle; system accounts cannot use this handoff.                                                                     |
| Successor is inactive, belongs to another workspace, or is the source | Choose a different active user or agent in this workspace.                                                                                          |
| Owned resources exist without a successor                             | Choose who should receive them. Admin does not silently archive or delete them.                                                                     |
| Mail delivery is in progress                                          | Wait for the sending operation to settle, then review again. Queued deliveries are cancelled during successful offboarding.                         |
| Receiving-address domain or namespace is ineligible                   | Enable the required verified domain capabilities or resolve the address collision, then review again; alternatively leave address preservation off. |

### Mail and retained history

Keeping addresses hands the listed primary and additional receiving addresses to
the successor as **receive-only** aliases. It never grants Send as permission.
Every retained address needs a verified domain with Mail and aliases enabled.
Automatic alias-domain addresses are included in the preview. If preservation is
off, future mail to the retired addresses stops; it is not forwarded silently.

Transferred mailbox data retains Inbox/Sent provenance and original senders.
Drafts move to the successor with their old From selection cleared, so the
successor must use an address they are currently authorized to send from.

The source actor remains disabled for this workspace. Group memberships and
access grants are removed; app passwords, agent credentials, and workspace OAuth
access are revoked. Pending Assistant actions and queued outgoing mail are
cancelled. Existing message authorship and audit history remain intact. The
global login and sessions for other workspaces are preserved; a zero
`sessionsRevoked` count does not mean this workspace's access remains enabled.
Search repair runs asynchronously, while canonical access checks reject stale
results immediately.

Legacy SCIM deprovisioning without a successor has different semantics: it
disables the account and retains its ownership as an archive. Admin handoff
requires a successor when data exists; it does not offer that archive shortcut.

## Choose administrator safeguards

In **Admin → Policies → Multi-factor authentication**, open the policy and use
**Administrator safeguards**. The effective values on the policy card show what
the server currently enforces.

| Control                                              | Effect                                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Administrator MFA                                    | Follow the workspace tier, explicitly require MFA, or make administrator MFA optional. Existing policies without an explicit choice retain their legacy required setting. |
| Require recent MFA for sensitive actions             | Independently controls MFA step-up for protected operations such as domain changes, credential issuance, and restore mutations.                                           |
| Require a second administrator for sensitive actions | Independently controls second-party approval for protected operations.                                                                                                    |

The last two controls apply independently of the general **Policy enabled** and
**Enforcement** fields. Disabling that general switch does not disable them. A
solo operator can select **Optional** administrator MFA and clear both sensitive
action requirements. This changes authentication and approval requirements;
ordinary permissions, tenant isolation, and audit records still apply.

Save from a real human session authenticated within the last ten minutes. If
prompted, sign in again and retry the retained draft. Enabling required MFA needs
an enrolled, verified factor. Enabling second-admin approval needs another
active human security administrator. Previously explicit MFA or approval
protection also protects subsequent policy changes; inherited defaults allow an
initial operator choice after fresh login.

When second-party approval is required, `202 crown_jewel_approval_required`
means the change has **not** been applied. Another authorized administrator must
approve the returned request through
`POST /v1/api/admin/crown-jewel-approvals/:id/approve`; the requester then repeats
the identical action with `x-helix-crown-jewel-approval: <id>`. Approvals expire,
cannot be self-approved, and are bound to that action and payload. The current
form shows the approval requirement and request ID rather than a success notice.

Recent administrator sign-in is a separate session policy
(`reauthForAdminActions` / `reauthIntervalMinutes`). Making MFA optional does not
disable that policy. Authenticated administrators retain access to the MFA and
session policy recovery endpoints, but saves still require recent login and any
previously explicit safeguards.

New [restore jobs](backup-restore-jobs.md) record zero required approvals when
second-admin approval is off, or one other administrator when it is on. Existing
jobs retain their creation-time approval count, including older two-approval
jobs; changing policy does not release those jobs automatically.

The local development workspace was explicitly saved and read back on
2026-09-10 with administrator MFA optional, sensitive-action MFA off, and
second-admin approval off. This is that workspace's operator choice, not a
change to the defaults for other installations.
