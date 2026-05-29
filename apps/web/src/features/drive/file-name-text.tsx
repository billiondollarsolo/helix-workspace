import type { CSSProperties } from "react";

interface FileNameTextProps {
  readonly name: string;
  readonly className?: string;
  readonly style?: CSSProperties;
}

const EXTENSION_PATTERN = /^(.+?)(\.[A-Za-z0-9]{1,8})$/u;

/** Renders a filename so the base can truncate while the extension stays visible. */
export function FileNameText({ name, className, style }: FileNameTextProps) {
  const parsed = EXTENSION_PATTERN.exec(name.trim());
  const base = parsed?.[1] ?? name;
  const extension = parsed?.[2] ?? "";

  if (extension.length === 0) {
    return (
      <span
        className={className}
        title={name}
        style={{
          display: "block",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          ...style,
        }}
      >
        {name}
      </span>
    );
  }

  return (
    <span
      className={className}
      title={name}
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        minWidth: 0,
        maxWidth: "100%",
        overflow: "hidden",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {base}
      </span>
      <span style={{ flex: "0 0 auto" }}>{extension}</span>
    </span>
  );
}
