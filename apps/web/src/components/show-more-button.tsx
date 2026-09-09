import { Icons } from "@/components/icons";

/** Centred "show more" pager used at the foot of the Docs, Sheets and Slides
 *  list surfaces, which all page the same way. */
export function ShowMoreButton({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "center", marginTop: 18 }}>
      <button type="button" className="btn" onClick={onClick}>
        <Icons.ChevronDown />
        {label}
      </button>
    </div>
  );
}
