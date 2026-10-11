/* The formatting bar above the compose bottom bar: a WAI-ARIA toolbar
   (arrow keys move between controls). Controls keep the editor's selection
   by not taking focus on mouse down. */

import {
  TextAlignCenter,
  TextAlignStart,
  TextAlignEnd,
  Bold,
  ChevronDown,
  ListIndentDecrease,
  ListIndentIncrease,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Palette,
  RemoveFormatting,
  TextQuote,
  Type,
  Underline,
} from "lucide-react";
import { Toolbar } from "radix-ui";
import type { ReactNode, RefObject } from "react";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  FONT_SIZES,
  TEXT_COLORS,
  runCommand,
  setFontSize,
  setTextColor,
  toggleQuote,
  type EditorCommand,
} from "./editor-commands";

interface ComposeToolbarProps {
  readonly editorRef: RefObject<HTMLDivElement | null>;
  /** The editor's last selection, restored before each command. */
  readonly selectionRef: RefObject<Range | null>;
  readonly onInsertLink: () => void;
}

const keepSelection = (event: { preventDefault: () => void }) => {
  event.preventDefault();
};

function ToolButton({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Toolbar.Button
      type="button"
      className="compose-tool"
      aria-label={label}
      title={label}
      onMouseDown={keepSelection}
      onClick={onClick}
    >
      {children}
    </Toolbar.Button>
  );
}

export function ComposeToolbar({ editorRef, selectionRef, onInsertLink }: ComposeToolbarProps) {
  const run = (command: EditorCommand) => () => {
    runCommand(editorRef.current, command, selectionRef.current);
  };

  return (
    <Toolbar.Root className="compose-toolbar" aria-label="Formatting options">
      <Menu>
        <MenuTrigger asChild>
          <Toolbar.Button
            type="button"
            className="compose-tool compose-tool-wide"
            aria-label="Font size"
            title="Font size"
            onMouseDown={keepSelection}
          >
            <Type aria-hidden="true" size={16} />
            <ChevronDown aria-hidden="true" size={12} />
          </Toolbar.Button>
        </MenuTrigger>
        <MenuContent align="start">
          {FONT_SIZES.map((size) => (
            <MenuItem
              key={size.value}
              onSelect={() => {
                setFontSize(editorRef.current, size.value, selectionRef.current);
              }}
            >
              {size.label}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      <Toolbar.Separator className="compose-tool-separator" />
      <ToolButton label="Bold" onClick={run("bold")}>
        <Bold aria-hidden="true" size={16} />
      </ToolButton>
      <ToolButton label="Italic" onClick={run("italic")}>
        <Italic aria-hidden="true" size={16} />
      </ToolButton>
      <ToolButton label="Underline" onClick={run("underline")}>
        <Underline aria-hidden="true" size={16} />
      </ToolButton>
      <Popover>
        <PopoverTrigger asChild>
          <Toolbar.Button
            type="button"
            className="compose-tool compose-tool-wide"
            aria-label="Text color"
            title="Text color"
            onMouseDown={keepSelection}
          >
            <Palette aria-hidden="true" size={16} />
            <ChevronDown aria-hidden="true" size={12} />
          </Toolbar.Button>
        </PopoverTrigger>
        <PopoverContent aria-label="Text color" className="w-auto">
          <div className="compose-swatches">
            {TEXT_COLORS.map((color) => (
              <button
                key={color.name}
                type="button"
                className="compose-swatch focus-ring"
                aria-label={color.name}
                title={color.name}
                style={{ background: color.value }}
                onClick={() => {
                  setTextColor(editorRef.current, color.value, selectionRef.current);
                }}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <Toolbar.Separator className="compose-tool-separator" />
      <Menu>
        <MenuTrigger asChild>
          <Toolbar.Button
            type="button"
            className="compose-tool compose-tool-wide"
            aria-label="Align"
            title="Align"
            onMouseDown={keepSelection}
          >
            <TextAlignStart aria-hidden="true" size={16} />
            <ChevronDown aria-hidden="true" size={12} />
          </Toolbar.Button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuItem
            icon={<TextAlignStart size={16} />}
            onSelect={() => {
              runCommand(editorRef.current, "justifyLeft", selectionRef.current);
            }}
          >
            Align left
          </MenuItem>
          <MenuItem
            icon={<TextAlignCenter size={16} />}
            onSelect={() => {
              runCommand(editorRef.current, "justifyCenter", selectionRef.current);
            }}
          >
            Center
          </MenuItem>
          <MenuItem
            icon={<TextAlignEnd size={16} />}
            onSelect={() => {
              runCommand(editorRef.current, "justifyRight", selectionRef.current);
            }}
          >
            Align right
          </MenuItem>
        </MenuContent>
      </Menu>
      <ToolButton label="Numbered list" onClick={run("insertOrderedList")}>
        <ListOrdered aria-hidden="true" size={16} />
      </ToolButton>
      <ToolButton label="Bulleted list" onClick={run("insertUnorderedList")}>
        <List aria-hidden="true" size={16} />
      </ToolButton>
      <ToolButton label="Indent less" onClick={run("outdent")}>
        <ListIndentDecrease aria-hidden="true" size={16} />
      </ToolButton>
      <ToolButton label="Indent more" onClick={run("indent")}>
        <ListIndentIncrease aria-hidden="true" size={16} />
      </ToolButton>
      <ToolButton
        label="Quote"
        onClick={() => {
          toggleQuote(editorRef.current, selectionRef.current);
        }}
      >
        <TextQuote aria-hidden="true" size={16} />
      </ToolButton>
      <Toolbar.Separator className="compose-tool-separator" />
      <ToolButton label="Link" onClick={onInsertLink}>
        <LinkIcon aria-hidden="true" size={16} />
      </ToolButton>
      <ToolButton label="Remove formatting" onClick={run("removeFormat")}>
        <RemoveFormatting aria-hidden="true" size={16} />
      </ToolButton>
    </Toolbar.Root>
  );
}
