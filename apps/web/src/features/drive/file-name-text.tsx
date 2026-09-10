import { cn } from "@/lib/utils";

interface FileNameTextProps {
  readonly name: string;
  readonly className?: string;
}

const EXTENSION_PATTERN = /^(.+?)(\.[A-Za-z0-9]{1,8})$/u;

/** Renders a filename so the base can truncate while the extension stays visible. */
export function FileNameText({ name, className }: FileNameTextProps) {
  const parsed = EXTENSION_PATTERN.exec(name.trim());
  const base = parsed?.[1] ?? name;
  const extension = parsed?.[2] ?? "";

  if (extension.length === 0) {
    return (
      <span
        className={cn(className, "block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap")}
        title={name}
      >
        {name}
      </span>
    );
  }

  return (
    <span
      className={cn(
        className,
        "inline-flex [align-items:baseline] min-w-0 [max-width:100%] overflow-hidden whitespace-nowrap",
      )}
      title={name}
    >
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{base}</span>
      <span className="[flex:0_0_auto]">{extension}</span>
    </span>
  );
}
