/* "Label color ▸" submenu for a label's ⋮ menu: the 24 palette swatches as
   radio items. Place it inside a <MenuContent>. Shared (org-wide) labels
   can't be recolored, so it renders nothing for them. */

import type { MailLabelColorName } from "@helix/contracts";
import { Check, Palette } from "lucide-react";
import { DropdownMenu as MenuPrimitive } from "radix-ui";
import { MenuSub, MenuSubContent, MenuSubTrigger } from "@/components/ui/menu";
import { notify } from "@/components/ui/toast";
import type { MailLabelSummary } from "../api";
import { LABEL_COLORS, labelColorTitle, labelColorVar } from "./label-model";
import { errorText, useUpdateLabel } from "./mutations";

export function LabelColorMenu({ label }: { readonly label: MailLabelSummary }) {
  const update = useUpdateLabel();
  if (label.shared) return null;
  return (
    <MenuSub>
      <MenuSubTrigger icon={<Palette />}>Label color</MenuSubTrigger>
      <MenuSubContent className="min-w-0 p-2" aria-label={`Color for ${label.name}`}>
        <MenuPrimitive.RadioGroup
          value={label.colorName}
          onValueChange={(value) => {
            const color = value as MailLabelColorName;
            update.mutate(
              { id: label.id, color },
              {
                onError: (error) =>
                  notify({
                    tone: "error",
                    message: "Couldn't change the label color",
                    description: errorText(error, "Check your connection and try again."),
                  }),
              },
            );
          }}
          className="grid grid-cols-6 gap-1"
        >
          {LABEL_COLORS.map((color) => (
            <MenuPrimitive.RadioItem
              key={color}
              value={color}
              aria-label={labelColorTitle(color)}
              title={labelColorTitle(color)}
              className="grid size-7 cursor-default place-items-center rounded-full outline-none data-[highlighted]:[outline:var(--focus-ring-width)_solid_var(--focus-ring-color)] data-[highlighted]:[outline-offset:var(--focus-ring-offset)]"
              style={{ background: labelColorVar(color) }}
            >
              <MenuPrimitive.ItemIndicator>
                <Check aria-hidden="true" className="size-4 text-[var(--label-on)]" />
              </MenuPrimitive.ItemIndicator>
            </MenuPrimitive.RadioItem>
          ))}
        </MenuPrimitive.RadioGroup>
      </MenuSubContent>
    </MenuSub>
  );
}
