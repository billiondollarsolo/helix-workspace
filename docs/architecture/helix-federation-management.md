# Helix federation management standard

Agreed product direction: 2026-10-19. Requirements below define the target;
the delivery stages distinguish it from currently shipped behavior.

Helix Workspace governs a federation of Helix applications. Workspace is required
to federate apps; each app may also operate independently. Workspace owns shared
organization controls, while each app owns its tools, data and execution. Bot is
the first federated app. Additional apps follow the same management conventions.

## Authority and permissions

Each setting has one authoritative home. Federated apps show the effective value
and its source for Workspace-managed settings, with an authorized link to manage
them in Workspace. They do not offer a competing editor or silently fall back to
local authority during an outage.

| Area                                                                 | Authoritative home                                          |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| Organization identity, managed people and groups, app assignments    | Workspace                                                   |
| Shared policies, federation approvals and correlated activity        | Workspace, with capability-specific enforcement in each app |
| Agents, models, projects, tool connections and execution permissions | Bot                                                         |
| Other app features and their resource permissions                    | The app that owns those resources                           |
| Personal appearance, accessibility and app preferences               | Personal settings in the relevant app                       |
| Independent recovery owner, service credentials and recovery tools   | The app and its operator                                    |

App assignment grants entry to the assigned app. Federating Bot does not give
every bot access to Workspace Mail, Chat or Drive. Individual bot accounts, resource
grants, private Work ownership, malware scanning and external-mail approvals remain
separate. Workspace policy cannot bypass an app's resource authorization.

Bindings remain scoped to an app tenancy and one governing Workspace organization.
The first management experience shows that governing Workspace clearly. Existing
tenant isolation, immutable subject identifiers and separate recovery ownership
remain enforced. Matching email addresses never merge accounts. Preserve Bot's
existing viewer/member/admin mappings; Workspace administration does not implicitly
grant Bot ownership or access to private work.

## Shared management experience

Use **Personal settings** and **Administration** as consistent entry points.
Administration identifies the app, current organization and governing Workspace.
Provide an app switcher containing only authorized destinations. Returning from
Administration preserves the user's work and drafts.

The common management structure is Overview, People and access, app-specific
settings, Federation, Activity and Operations. Workspace additionally provides
Federated apps and shared policy management. Navigation exposes only authorized,
supported sections; this structure does not require empty placeholder screens.
Keep Workspace's Mail, Drive and other built-in modules distinct from connected
application installations. Within Activity, preserve the explicit Audit log label.

Use the same typography, spacing, semantic colors, icon conventions, page headings,
form layout, table patterns and status language. Reuse each repository's existing
controls and tokens; a common frontend framework is not required. Loading, empty,
error, permission-denied and disconnected states must be distinguishable. Preserve
keyboard access, visible focus, responsive layouts, light/dark themes and drafts.
Creation uses labelled Add actions and inline or dedicated forms; confirmations
review concrete consequential actions. Save behavior and validation are consistent.

Show **Managed by Workspace** for inherited values and **Manage in Workspace** for
their editor link. Show the source and effective value when a policy constrains an
app setting. Recovery-owner controls are explicitly identified and separately
authorized. Never enable a restricted operation merely because its control is visible.

## Administration design contract

Use a 24px page gutter and compact 36px default controls, with semantic theme tokens
for spacing, focus, text and status. A page has one heading and one administration
search. Keep actions beside their section heading; refresh actions are secondary.
Use labelled + Add / + Invite controls, never an unexplained plus icon.

People and application directories use the existing TanStack table components.
Provide sorting, explicit empty/error states, accessible row actions and a compact
caption/value layout on small screens. Sorting a loaded subset must say so.
Creation and editing use nonmodal panels or dedicated routes; blocking dialogs
are reserved for confirmation. Retain drafts through errors and section changes.

A federated application has a linkable detail view with Overview, People and
Operations sections. Keep connection failures visible outside disclosures; place
technical identifiers, ownership reference information and recovery operations
behind an explicit detail choice. Use dividers and whitespace for ordinary settings,
reserving cards and status treatments for information that needs grouping or attention.

## Setting ownership inventory

The current integration inherits the fields below. It does not yet propagate a
general Workspace policy object into Bot. Shared policy enforcement must be
advertised and qualified per capability before an app describes a field as inherited.

| Fields / controls                                                                       | Standalone Bot                          | Federated Bot                                                                      | Authoritative editor                                                                          |
| --------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Managed person's name, email, active assignment and groups                              | Bot or its configured identity provider | Workspace directory; read-only in Bot                                              | Workspace Users / Groups; app access in Federated apps                                        |
| Assigned person's Bot role                                                              | Bot or its configured identity provider | Workspace assignment: Viewer, Member or Admin; never ownership                     | Workspace Federated apps → assigned people                                                    |
| App sign-in provider, installation OIDC credentials and directory provisioning          | Bot Single sign-on / operator           | Workspace connection and credential lifecycle; effective values shown in Bot       | Workspace Federated apps; local recovery owner approves pairing/disconnect in Bot             |
| Local accounts and ownership                                                            | Bot                                     | Bot, independent of managed identities                                             | Bot Members / account security; existing owner restrictions apply                             |
| Bot MFA enrolment and required-MFA flag                                                 | Bot password accounts                   | Bot password accounts; Workspace owns verification for Workspace SSO               | Bot Security / Personal settings for local MFA; Workspace identity controls for Workspace SSO |
| Models, provider credentials, bot instructions and model selections                     | Bot                                     | Bot                                                                                | Bot Models / Bunnies                                                                          |
| Tool connections, secrets, per-bot grants, project/Work access, spending and publishing | Bot                                     | Bot; federation assignment grants no resource access                               | Corresponding Bot controls                                                                    |
| Appearance, accessibility, notifications and app preferences                            | Personal settings                       | Personal settings                                                                  | Personal settings in the owning app                                                           |
| Optional federated backup policy and recovery operations                                | Independent operator                    | Workspace policy plus separately enrolled worker capabilities and operator consent | Workspace Federated backups / independent recovery operator                                   |

Bot administrator roles do not grant Workspace administration. Management links
open the governing Workspace's existing editors, which enforce that person's own
Workspace session and scopes. Member-only Bot views identify the source without
presenting an administrator editor link. No cross-app permission is inferred from
a matching email or a local owner role. Unavailable connection information never
enables a local replacement editor for a managed field.

## Requirements for additional apps

Every federated app must provide:

- A stable app/installation identity, organization binding, version and a declared,
  versioned capability list. Pairing verifies control of both participating sides.
- Managed identity and explicit app-role mapping, bounded authority freshness,
  revocation enforcement and independent local recovery.
- Authorized management links, connection and synchronization status, an observation
  time and actionable safe errors. Unsupported and unavailable are distinct states.
- Auditable operations attributed to the initiating actor, organization, app and
  operation. Workspace receives only authorized metadata; audit federation does not
  copy private app content or secrets into a shared dashboard.
- The shared management experience above, including a Federation page that explains
  which controls Workspace manages and which remain local.

Backup management, restore, usage reporting, maintenance and other privileged
operations are separately advertised and authorized capabilities. Joining alone
enables none of them. Retain existing recovery workers, policy acknowledgements,
operation IDs and independent key custody rather than adding another orchestrator.
Disconnect reviews the affected capabilities and managed access; it preserves app
data and independent recovery. Stale directory authority cannot restore revoked access.

## Terminology and cutover

Use **federation**, **federated apps**, **Connect to Workspace** and **Federation
settings** in product copy. Use **Federated backups** and **Federation recovery set**
for the optional recovery capability. Retire “family” as the product grouping name.

Federation is the canonical name in routes, configuration, database schema, worker
protocols, code and documentation. This is a greenfield product used by its owners;
provide no old-name aliases, redirects, dual configuration keys or compatibility
layers. Existing development data is converted once during a coordinated cutover.
Keep historical recovery evidence intact and label the source revision needed to
restore it. New backups and fresh installations use federation names exclusively.

## Delivery stages for Workspace and Bot

Stage 1 was implemented and deployed on 2026-10-19, including the coordinated
technical rename without aliases. See the [cutover receipt](../runbooks/2026-10-17-hosted-federation-operations.md#greenfield-terminology-cutover--2026-10-19)
for validation and recovery limits. Stage 2 is implemented: both apps use
Administration and Personal settings, app/organization context and the common
navigation groups. Workspace distinguishes built-in Workspace apps from Federated
apps. Bot has a dedicated Federation destination and a mobile section drawer;
its existing controls, routes and independent recovery-owner boundary are retained.
Stage 3 is implemented and deployed: Bot identifies setting sources, shows effective
managed sign-in values and links to the existing Workspace editors. Workspace's
app card identifies its assignment authority and the controls Bot retains. SSO-only
accounts use their provider's password, recovery and verification controls; Bot's
local recovery owner remains independent. See the [ownership qualification](../runbooks/2026-10-17-hosted-federation-operations.md#setting-ownership-qualification--2026-10-19).
Stage 4 is implemented for the current Bot integration: Workspace exposes the
connection binding, directory observations, complete assigned-person labels and
the separately enrolled backup capability's health, acknowledged policy and pending
delivery. Details load on request through the existing scoped APIs. See the
[app management qualification](../runbooks/2026-10-17-hosted-federation-operations.md#federated-app-management-qualification--2026-10-19).
Assignment saves now require the directory revision originally loaded by the editor;
conflicting saves retain the draft and require an explicit current-state reload.
See the [conflict and recovery follow-up](../runbooks/2026-10-17-hosted-federation-operations.md#federation-review-and-assignment-conflicts--2026-10-20).
Additional app types still require their own contract implementation and
qualification. General Workspace policy propagation is not implemented.

1. **Terminology and baseline:** replace current management headings, navigation,
   recovery copy and active guide terminology. Rename the integration in code, routes,
   schema, configuration and worker protocols through one coordinated cutover.
2. **Management structure:** align the administration entry points, organization
   context, navigation patterns and common form/table behavior. Give Bot a clear
   Federation destination instead of embedding its connection within Single sign-on.
3. **Setting ownership:** inventory inherited and local fields; make their sources
   visible and link to their authoritative editor. Preserve scoped-admin access and
   the separate local recovery owner.
4. **Workspace app management:** expose authorized app details, assignments, effective
   policies, synchronization and capability-specific health through existing APIs.
   Replace Bot-specific assumptions only as additional app support is implemented.

Relevant existing surfaces are Workspace's admin navigation, application-pairing
and backup sections, and Bot's settings shell, member management and Workspace
connection view. Continue the [Bot integration ledger](../../../helix-bot/docs/plans/helix-bot-workspace-integration.md)
for dated qualification; the earlier [management plan](../../../helix-bot/docs/plans/2026-10-17-app-federation-management.md)
retains recovery implementation history.

Each stage qualifies standalone and federated behavior, existing deep links,
authorized and denied roles, recovery-owner access, desktop/mobile accessibility,
retained drafts and failure/retry states relevant to its changes. Interface changes
do not count as new permission or backend capability acceptance.
