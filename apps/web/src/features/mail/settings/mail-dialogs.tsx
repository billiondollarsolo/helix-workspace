/* The dialog for the current request; loaded on first use. */

import { closeMailDialog, type MailDialogRequest } from "./dialog-store";
import { FilterDialog } from "./filter-dialog";
import { FilterRemoveDialog } from "./filter-remove-dialog";
import { LabelDialog } from "./label-dialog";
import { LabelRemoveDialog } from "./label-remove-dialog";

export default function MailDialogs({ request }: { readonly request: MailDialogRequest }) {
  switch (request.kind) {
    case "filter":
      return <FilterDialog prefill={request.prefill} onClose={closeMailDialog} />;
    case "filter-edit":
      return <FilterDialog filter={request.filter} onClose={closeMailDialog} />;
    case "filter-remove":
      return <FilterRemoveDialog filter={request.filter} onClose={closeMailDialog} />;
    case "label":
      return <LabelDialog request={request.request} onClose={closeMailDialog} />;
    case "label-remove":
      return <LabelRemoveDialog labelId={request.labelId} onClose={closeMailDialog} />;
  }
}
