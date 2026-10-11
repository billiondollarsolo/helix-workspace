/* Mail settings, filters and labels: the public surface for other packages.

   Dialogs (rendered by `MailDialogsHost`, which the app shell mounts once):
   - openFilterDialog(prefill?: MailFilterPrefill): void
       Two-step "Create a filter" dialog. `prefill` fills the criteria:
       { from?, to?, subject?, hasWords?, hasAttachment? }. For "Filter
       messages like these" pass the sender: openFilterDialog({ from }).
   - openLabelDialog(request: MailLabelDialogRequest): void
       { mode: "create", parentId? } opens New label (nested under
       `parentId` when given); { mode: "edit", labelId } opens Edit label.
   - openRemoveLabelDialog(labelId: string): void
       Asks to confirm removing a label and the labels nested under it.

   Components:
   - <LabelColorMenu label={MailLabelSummary} />
       "Label color ▸" submenu for a label's ⋮ menu; place inside a
       <MenuContent>. Renders nothing for shared (org-wide) labels.
   - <ManageLabelsPage />
       The label list with Create / Edit / Remove (Settings → Mail → Labels).
   - <MailSettingsSection tab onTabChange />
       The Settings → Mail section, registered in the settings overlay.

   Deep links: `?settings=mail` (General), `?settings=mail/general`,
   `?settings=mail/labels`, `?settings=mail/filters`. From code:
   useShellOverlays().openSettings("mail/filters"). */

export {
  openFilterDialog,
  openLabelDialog,
  openRemoveLabelDialog,
  type MailFilterPrefill,
  type MailLabelDialogRequest,
} from "./dialog-store";
export { LabelColorMenu } from "./label-color-menu";
export { MailDialogsHost } from "./mail-dialogs-host";
export { MailSettingsSection, type MailSettingsTab } from "./mail-settings";
export { ManageLabelsPage } from "./manage-labels-page";
