/* The remedy for `assistant_tool_limit_exceeded`: each selected tool group,
   largest first, as a one-click "turn off and retry". */

import { InlineError } from "@/components/ui/inline-error";
import { toolLimitSummary, type AssistantToolLimit } from "./tool-limit";

export function ToolLimitError({
  limit,
  disabled,
  onTurnOff,
}: {
  readonly limit: AssistantToolLimit;
  readonly disabled: boolean;
  /** Turns the group off and sends the message again. */
  readonly onTurnOff: (groupId: string) => void;
}) {
  return (
    <InlineError
      variant="compact"
      className="my-2"
      title="Couldn't send with these tools"
      message={`${toolLimitSummary(limit)} Turn one off and Helix AI tries again.`}
      actions={limit.groups.map((group) => (
        <button
          key={group.id}
          type="button"
          className="btn sm"
          disabled={disabled}
          onClick={() => {
            onTurnOff(group.id);
          }}
        >
          Turn off {group.label} ({group.count})
        </button>
      ))}
    />
  );
}
