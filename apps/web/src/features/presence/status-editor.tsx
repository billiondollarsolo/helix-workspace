import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  presenceRecordSchema,
  presenceStatusInputSchema,
  type PresenceRecord,
  type PresenceStatusInput,
} from "@helix/contracts";
import { SettingsCard, SettingsField } from "@/components/shell/settings-controls";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { presenceQueryOptions, presenceRequest } from "./presence";
import { z } from "zod";

export function StatusEditor() {
  const query = useQuery(presenceQueryOptions());
  return (
    <SettingsCard
      title="Status and availability"
      description="Choose what people see. Your status stays set across tabs; being connected does not mean a message was read."
    >
      {query.isError ? (
        <InlineError title="Status didn’t load" message={query.error.message} />
      ) : query.data?.[0] ? (
        <StatusForm initial={query.data[0]} />
      ) : (
        <p role="status">Loading status…</p>
      )}
    </SettingsCard>
  );
}
function StatusForm({ initial }: { readonly initial: PresenceRecord }) {
  const id = useId(),
    cache = useQueryClient();
  const [availability, setAvailability] = useState<PresenceStatusInput["availability"]>(
    initial.availability,
  );
  const [text, setText] = useState(initial.text),
    [emoji, setEmoji] = useState(initial.emoji),
    [expiry, setExpiry] = useState("keep");
  const save = useMutation({
    onMutate: () => cache.cancelQueries({ queryKey: ["presence"] }),
    onError: () => cache.invalidateQueries({ queryKey: ["presence"] }),
    mutationFn: async () => {
      const expiresAt =
        expiry === "keep"
          ? initial.expiresAt
          : expiry === "never"
            ? null
            : new Date(Date.now() + Number(expiry) * 60000).toISOString();
      const input = presenceStatusInputSchema.parse({ availability, text, emoji, expiresAt });
      return z
        .object({ presence: presenceRecordSchema })
        .parse(await presenceRequest("/api/presence", "PATCH", input)).presence;
    },
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["presence"] });
    },
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <SettingsField
        label="Availability"
        controlId={`${id}-availability`}
        hint="Invisible hides your connection. Do not disturb keeps unread messages and approvals available."
      >
        <select
          className="admin-control"
          id={`${id}-availability`}
          value={availability}
          onChange={(event) =>
            setAvailability(presenceStatusInputSchema.shape.availability.parse(event.target.value))
          }
        >
          <option value="available">Available</option>
          <option value="away">Away</option>
          <option value="dnd">Do not disturb</option>
          <option value="invisible">Invisible</option>
        </select>
      </SettingsField>
      <SettingsField label="Status" controlId={`${id}-text`}>
        <Input
          id={`${id}-text`}
          maxLength={100}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="What are you working on?"
        />
      </SettingsField>
      <SettingsField label="Emoji" controlId={`${id}-emoji`}>
        <Input
          id={`${id}-emoji`}
          maxLength={16}
          value={emoji}
          onChange={(event) => setEmoji(event.target.value)}
          placeholder="Optional emoji"
        />
      </SettingsField>
      <SettingsField label="Clear status" controlId={`${id}-expiry`}>
        <select
          className="admin-control"
          id={`${id}-expiry`}
          value={expiry}
          onChange={(event) => setExpiry(event.target.value)}
        >
          <option value="keep">Keep current expiry</option>
          <option value="30">In 30 minutes</option>
          <option value="60">In an hour</option>
          <option value="240">In 4 hours</option>
          <option value="1440">In a day</option>
          <option value="never">Don’t clear</option>
        </select>
      </SettingsField>
      {save.isError ? (
        <InlineError title="Status couldn’t be saved" message={save.error.message} />
      ) : null}
      <Button type="submit" disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save status"}
      </Button>
      {save.isSuccess ? <p role="status">Status saved.</p> : null}
    </form>
  );
}
