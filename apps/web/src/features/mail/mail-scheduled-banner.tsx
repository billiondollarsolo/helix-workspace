/* In the Scheduled folder, an open conversation says when its message will
   go out and offers Reschedule (date and time picker) and Cancel send, which
   returns the message to Drafts. */

import { Button } from "@/components/ui/button";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { notify } from "@/components/ui/toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SendHorizontal } from "lucide-react";
import { useState } from "react";
import { cancelScheduledMail, rescheduleMail } from "./api";
import { mailScheduledQueryOptions } from "./queries";
import { formatFullDate } from "./mail-view-helpers";

function useRefreshMail() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: ["mail"] });
}

function ReschedulePopover({
  outboundId,
  sendAt,
}: {
  readonly outboundId: string;
  readonly sendAt: string;
}) {
  const refresh = useRefreshMail();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<Date | null>(new Date(sendAt));
  const now = new Date();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          Reschedule
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Reschedule send" className="w-auto">
        <div className="flex flex-col gap-3">
          <DateTimePicker value={value} onChange={setValue} min={now} label="Send at" />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={value === null || value <= now}
              onClick={() => {
                if (value === null) return;
                setOpen(false);
                rescheduleMail({ outboundId, sendAt: value.toISOString() }).then(
                  () => {
                    refresh();
                    notify({
                      message: `Send rescheduled for ${formatFullDate(value.toISOString())}`,
                    });
                  },
                  () => notify({ message: "Couldn't reschedule the send.", tone: "error" }),
                );
              }}
            >
              Schedule send
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function MailScheduledBanner({ threadId }: { readonly threadId: string }) {
  const refresh = useRefreshMail();
  const scheduled = useQuery(mailScheduledQueryOptions());
  const sends = (scheduled.data?.scheduled ?? []).filter((entry) => entry.threadId === threadId);
  if (sends.length === 0) return null;
  return (
    <>
      {sends.map((send) => (
        <div key={send.outboundId} role="status" className="mail-banner">
          <SendHorizontal aria-hidden="true" className="size-4 shrink-0" />
          <span className="flex-1">Scheduled to send {formatFullDate(send.sendAt)}</span>
          <ReschedulePopover outboundId={send.outboundId} sendAt={send.sendAt} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              cancelScheduledMail(send.outboundId).then(
                () => {
                  refresh();
                  notify({ message: "Send cancelled. The message is back in Drafts." });
                },
                () => notify({ message: "Couldn't cancel the send.", tone: "error" }),
              );
            }}
          >
            Cancel send
          </Button>
        </div>
      ))}
    </>
  );
}
