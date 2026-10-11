# Drive sharing, folders, versions, and Home: follow-up plan

Date: 2026-10-10
Scope: follow-ups to commit `9007ae1` ("feat(drive): wire share dialog, folder grants, Home,
versions, and quota").
Status: implemented; see [Validation log](#validation-log).

## 1. Background

Commit `9007ae1` moved Drive toward Google Drive parity:

1. Mounted the existing `DriveShareDialog` from the file details panel ("Share & links").
2. Let `drive.share` grant access on folders (`permissions.resource_type = 'drive_folder'`), so
   children inherit access through `helix_drive_effective_role`.
3. Let `drive.rename` rename folders as well as files.
4. Added a version history list with Restore buttons to the file details panel.
5. Added a Home scope in the sidebar.
6. Added a storage usage meter to the sidebar (`drive.quota.usage`).

A review of that commit found the defects below. This plan fixes all of them, adds the missing
tests, and records the validation evidence.

## 2. Findings being addressed

| ID  | Severity | Area    | Finding                                                                                                                                                                                                     |
| --- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Bug      | Web     | The details panel rename input keeps the previously selected file's name, because the panel is not remounted per file. Clicking Rename can rename file B to file A's name.                                  |
| F2  | Bug      | Backend | `removeAccess` and `updateAccess` only handle `resource_type = 'object'`. Folder grants created by `share` cannot be revoked or changed through any API.                                                    |
| F3  | Bug      | Web     | Folders can never be selected, so folder sharing, folder rename, and folder access listing are unreachable in the web app.                                                                                  |
| F4  | Minor    | Backend | `rename` on a missing or non-ready file falls through to the folder path and reports "Unknown Drive folder", which is a misleading error.                                                                   |
| F5  | Minor    | Backend | Tool descriptions (`drive.rename`, `drive.share`, `drive.access.*`) still describe files/objects only.                                                                                                      |
| F6  | Minor    | Web     | Home only re-sorts the current root listing; it is not a cross-folder "suggested" view. Its empty-state copy promises behaviour that does not exist. Opening a folder from Home loses the folder on reload. |
| F7  | Minor    | Web     | Version Restore has no confirmation, appears on the current version, and neither rename nor restore shows success or failure.                                                                               |
| F8  | Minor    | Web     | A doc comment in `queries.ts` sits above the wrong function; the versions and quota query keys bypass `driveQueryKeys`.                                                                                     |
| F9  | Minor    | Web     | The share dialog has no Escape-to-close and no initial focus, which `AGENTS.md` requires (keyboard focus).                                                                                                  |
| F10 | Gap      | Tests   | No backend tests cover folder share, folder access list/update/remove, or folder rename.                                                                                                                    |

## 3. Non-goals

- No change to the permission model, `helix_drive_effective_role`, or migrations. Folder grants
  already resolve through the existing SQL function.
- No public share links for folders. `drive.link.create` is object-only; the dialog hides the
  public-link section for folders instead of offering a control that fails.
- No client-side role computation. The server stays the authority for who may rename, restore, or
  share; the UI shows the server's actionable error when an action is refused.
- No editors, viewers, or converters (product boundary in `AGENTS.md`).

## 4. Design

### 4.1 Backend: folder-aware access management (F2)

`apps/helix/src/platform/drive/store/shares.ts`

Add a shared helper `findLiveFolder(sql, orgId, id)` returning `{ owner_actor_id } | null` and
reuse it in `share`, `listAccess`, `removeAccess`, and `updateAccess`.

`removeAccess` for a folder:

- Removing someone else requires `owner` on the folder (`requireFolderRole(..., "owner")`).
- Self-removal requires any access (`requireFolderAccess`).
- Delete from `permissions` where `resource_type = 'drive_folder'`, `resource_id = folderId`,
  `actor_id = target`, not the folder owner, and `source_group_grant_id is null` (group-derived
  grants are managed by the group, same as objects).
- Append activity `drive.folder.access_removed`.

`updateAccess` for a folder:

- Requires `owner` on the folder.
- Update the matching `drive_folder` grant's role / expiry / grantor, excluding the owner and
  group-derived grants, and return the grant joined with `actors`.
- Append activity `drive.folder.access_updated`.

Object behaviour is unchanged.

### 4.2 Backend: rename resolution (F4)

`apps/helix/src/platform/drive/store/entries.ts`

Resolve the target kind first:

1. If a live `drive_folders` row with that id exists, take the folder path
   (`requireFolderRole(..., "editor")`, update, `drive.folder.renamed`).
2. Otherwise take the original file path unchanged: `requireReadyObjectRole(..., "editor")`
   first, which throws the existing object not-found / not-ready errors, then update.

Folder and object ids are both UUIDs from separate tables; a folder lookup first is unambiguous
and restores the original file error messages.

### 4.3 Backend: tool descriptions (F5)

`apps/helix/src/platform/drive/tools.ts`: update descriptions for `drive.rename`, `drive.share`,
`drive.access.list`, `drive.access.remove`, `drive.access.update` to say "file or folder".
Input schemas are unchanged (they already take a UUID `objectId`).

### 4.4 Web: per-file panel state (F1)

`drive-shell.tsx`: render `<DriveDetailsPanel key={selectedFile.id} … />` so all local state
(rename text, share input, pending confirmation) resets when the selection changes.

### 4.5 Web: folder details (F3)

- `drive-file-list.tsx`: each folder card gets a sibling "Folder details" icon button
  (`aria-label="Details for <name>"`). The card itself still opens the folder. The details button
  is a sibling, not nested, so the HTML stays valid.
- `drive-shell.tsx`: new `selectedFolderId` state. Selecting a folder clears the file selection
  and vice versa. Navigating, changing scope, or opening a folder clears both.
- New `drive-folder-details-panel.tsx`: `<aside aria-label="Folder details">` with
  - name input + Rename (calls `drive.rename`, shows "Renamed." or the error),
  - Open folder,
  - "Share" button opening `DriveShareDialog` for the folder,
  - inherited-access note ("People you add get access to everything inside this folder."),
  - owner line.
- `drive-share-dialog.tsx`: new optional prop `allowPublicLinks` (default `true`). The folder
  panel passes `false`, which hides the public link section.

### 4.6 Web: share dialog keyboard support (F9)

- Escape closes the dialog.
- Focus moves to the "Add people" input when the dialog opens.

### 4.7 Web: version history (F7)

- Versions are listed newest first (server orders `version_number desc`). The first row is
  labelled "Current" and has no Restore button.
- Restore is a two-step inline confirmation: "Restore" swaps to Confirm / Cancel on that row.
- Rename and restore show a `role="status"` success message or a `role="alert"` error message.

### 4.8 Web: Home (F6)

`queries.ts`, `driveItemsQueryOptions` for `scope === "home"` at the root:

- In parallel, fetch the root listing (folders) and a cross-folder file listing
  (`acrossFolders: true`).
- `deriveDriveSuggestions` picks the 5 most recently updated folders and the 10 most recently
  updated files.

Inside a folder opened from Home, list that folder's children (same as before).
`driveItemsInputFromRouteSearch` keeps `folder` for `home` so a reload stays in the folder.
Empty-state copy becomes: "No recently updated files or folders yet." (The interaction
inventory test rejects "will appear here" style placeholder copy.)

### 4.9 Web: query hygiene (F8)

- Move the misplaced doc comment back above `driveActorQueryOptions`.
- Add `driveQueryKeys.versions(objectId)` and `driveQueryKeys.quota`; use them everywhere.
- Invalidate the quota after uploads/deletes via the existing `driveQueryKeys.all` prefix (already
  covered because both keys start with `"drive"`).

## 5. Task list

Backend

- [x] T1. `findLiveFolder` helper in `shares.ts`; reuse in `share` and `listAccess`.
- [x] T2. Folder branch in `removeAccess` (owner or self, group grants excluded, activity).
- [x] T3. Folder branch in `updateAccess` (owner only, group grants excluded, activity).
- [x] T4. `rename` resolves folder first, otherwise original file path and errors.
- [x] T5. Tool descriptions mention folders.
- [x] T6. Unit tests (`store-folder-sharing.test.ts`) with a recording fake SQL:
  - share on a folder writes `drive_folder` grants and `drive.folder.shared`,
  - share on a folder by a non-owner is forbidden,
  - listAccess on a folder queries `drive_folder` grants,
  - removeAccess on a folder by the owner deletes the `drive_folder` grant,
  - removeAccess of another actor by a non-owner is forbidden; self-removal is allowed,
  - updateAccess on a folder by the owner updates the `drive_folder` grant,
  - updateAccess on a folder by an editor is forbidden,
  - rename on a folder updates `drive_folders` and logs `drive.folder.renamed`,
  - rename on an unknown id reports an object error, not "Unknown Drive folder".

Web

- [x] T7. Key the file details panel by file id; test that switching files resets the name.
- [x] T8. Folder details button, selection state, and `DriveFolderDetailsPanel`.
- [x] T9. `allowPublicLinks` prop on `DriveShareDialog`; hidden for folders.
- [x] T10. Share dialog Escape-to-close and initial focus.
- [x] T11. Version history: current label, confirm step, success and error messages.
- [x] T12. Rename success and error messages.
- [x] T13. Home: cross-folder suggestions, folder kept on reload, new empty copy.
- [x] T14. `driveQueryKeys.versions` / `driveQueryKeys.quota`; fix misplaced comment.
- [x] T15. Web tests: folder details flow, version restore confirm, Home query, share dialog
      Escape and hidden public links.

Found during validation

- [x] T18. Fix the two Drive tests broken by `9007ae1` or by this change:
      `store-production-hardening.test.ts` (source assertion on the old `'object'` literal) and
      `store-query-shape.test.ts` (ordered fake responses now include the folder lookup).
- [x] T19. Fix the existing `exactOptionalPropertyTypes` error in the `drive.list` tool handler.
- [x] T20. Bring `drive-shell.test.tsx` (1094 > 1080) and `api.test.ts` (948 > 934) back under the
      `.file-size-baseline.json` ceilings by moving shared fixtures to `drive-shell.fixtures.ts`,
      new panel tests to `drive-shell-details.test.tsx`, and route-search tests to
      `route-search.test.ts`; lower both ceilings to the new sizes.
- [x] T21. Hide the folder details button in Trash.
- [x] T22. Playwright: folder details flow with an axe scan in `drive-feature.spec.ts`.

Docs

- [x] T16. `CHANGELOG.md` `[Unreleased]` entries.
- [x] T17. This plan, with the validation log filled in.

## 6. Validation plan

Focused while iterating:

- `pnpm --filter @helix/app exec vitest run src/platform/drive`
- `pnpm --filter @helix/web exec vitest run src/features/drive`

Full gates from `AGENTS.md`:

- `pnpm format:check`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm quality:boundaries`
- Relevant Playwright and accessibility checks for Drive (see log for what this environment could
  run).

## 7. Risks

- **Fake-SQL tests match on query text.** They prove routing, authorization order, and the
  `resource_type` used, not SQL semantics. The SQL mirrors the existing, already-tested object
  queries with the resource type swapped.
- **Two-request Home.** Home now makes two list calls. Both are capped (`limit`) and run in
  parallel.
- **Folder selection UI** adds a button per folder card; it is keyboard reachable and labelled.
  It is hidden in Trash, where the folder panel is not shown.

## Validation log

Environment: Node 24.18.0, pnpm 11.18.0, Chromium from `/opt/pw-browsers`.

| Check                                                              | Result                                                                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `vitest run src/platform/drive` (app)                              | 263 passed, 3 skipped                                                                   |
| New folder sharing tests against the pre-fix store                 | 7 of 11 fail, which shows the tests catch F2 and F4                                     |
| `vitest run src/features/drive src/interaction-inventory.test.ts`  | 101 passed                                                                              |
| Rename-reset test with the panel `key` removed                     | Fails, which shows the test catches F1                                                  |
| `playwright test tests/e2e/drive-feature.spec.ts` (mocked backend) | 2 passed, including an axe WCAG 2 A/AA scan with the folder panel and share dialog open |
| `pnpm audit:a11y` against local Vite                               | Passed: 162 route/viewport/theme audits, 0 violations                                   |
| `eslint` (web `src`, app `src/platform/drive`, e2e spec)           | Clean                                                                                   |
| `tsc --noEmit` (web, e2e)                                          | Clean                                                                                   |
| `verify-source-structure.mjs` (helpers, `--size --base HEAD`)      | Passed                                                                                  |
| `pnpm quality:boundaries`                                          | Passed                                                                                  |
| `knip`                                                             | No findings in changed files                                                            |

Issues already on the base commit and not addressed by this change (outside Drive):

- `pnpm typecheck` / `pnpm build`: 4 errors in `src/db/seed-local-team-content.ts`,
  `src/db/seed-local-team.test.ts`, `src/platform/assistant/attachment-retrieval.ts`, and
  `src/platform/assistant/titles.ts`.
- `pnpm format:check`: `seed-local-team-domain.ts`, `assistant/tasks.ts`,
  `config/ai-tool-servers-schema.ts`.
- `pnpm lint` (app): 2 `no-unnecessary-condition` errors in `seed-local-team-content.ts`.

Full-repo runs (`turbo run <task> --continue`, after building workspace packages):

| Gate                      | Result                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm test`               | Passed: app 3312 passed / 254 skipped; web 900 passed; cli 115; contracts 40; sdk 10; others pass |
| `pnpm lint`               | All packages pass except the 2 existing seed errors in `@helix/app`                               |
| `pnpm typecheck`          | All packages pass except the 4 existing seed/Assistant errors in `@helix/app`                     |
| `pnpm build`              | Web builds; `@helix/app` fails only on the same 4 existing type errors                            |
| `pnpm format:check`       | Only the 3 existing unformatted files                                                             |
| `pnpm quality:boundaries` | Passed                                                                                            |
