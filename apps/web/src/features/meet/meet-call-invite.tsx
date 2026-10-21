/* Invite a guest (someone outside the organization) from the call: the host
   enters an email address, guests are allowed for the meeting, and a signed
   invitation link is created. The token goes in the link's fragment
   (`/meet/guest#<token>`) so it never reaches servers or their logs. */

import { Dialog } from "@/components/ui/helix-dialog";
import { Input } from "@/components/ui/input";
import { useMutation } from "@tanstack/react-query";
import { Copy as CopyIcon } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { createMeetGuestInvite, setMeetGuestsAllowed } from "./api";
import { meetGuestLink } from "./meet-guest-api";
import { copyMeetingLink } from "./meet-join";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function InviteGuestDialog({
  roomId,
  onClose,
}: {
  readonly roomId: string;
  readonly onClose: () => void;
}) {
  const emailId = useId();
  const linkId = useId();
  const [email, setEmail] = useState("");
  const [invalid, setInvalid] = useState(false);

  const invite = useMutation({
    mutationFn: async (address: string) => {
      // Meetings start with guests blocked, and invitations fail until allowed.
      await setMeetGuestsAllowed(roomId, true);
      const created = await createMeetGuestInvite({ roomId, email: address });
      return { email: address, link: meetGuestLink(created.token) };
    },
    onMutate: () => undefined,
    onError: () => undefined,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (!EMAIL_PATTERN.test(address)) {
      setInvalid(true);
      return;
    }
    if (!invite.isPending) invite.mutate(address);
  };

  const created = invite.data;

  return (
    <Dialog
      modal={false}
      title={<h2 className="type-h3 m-0">Invite a guest</h2>}
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          {created === undefined ? "Cancel" : "Done"}
        </button>
      }
    >
      {created === undefined ? (
        <form className="grid gap-3" onSubmit={submit} noValidate>
          <div className="grid gap-1">
            <label htmlFor={emailId} className="type-body-sm font-medium">
              Guest email
            </label>
            <Input
              id={emailId}
              type="email"
              autoComplete="off"
              value={email}
              aria-invalid={invalid}
              aria-describedby={invalid ? `${emailId}-error` : undefined}
              onChange={(event) => {
                setEmail(event.target.value);
                setInvalid(false);
              }}
            />
            {invalid ? (
              <p id={`${emailId}-error`} role="alert" className="m-0 type-meta text-destructive">
                Enter an email address.
              </p>
            ) : null}
          </div>
          <p className="m-0 type-meta text-muted-foreground">
            This lets guests join this meeting. The link works only for this email address.
          </p>
          {invite.isError ? (
            <p role="alert" className="m-0 type-meta text-destructive">
              {invite.error instanceof Error && invite.error.message.length > 0
                ? invite.error.message
                : "Couldn’t create the link. Try again."}
            </p>
          ) : null}
          <div>
            <button type="submit" className="btn primary" disabled={invite.isPending}>
              {invite.isPending ? "Creating link…" : "Create link"}
            </button>
          </div>
        </form>
      ) : (
        <div className="grid gap-3">
          <label htmlFor={linkId} className="type-body-sm font-medium">
            Guest link
          </label>
          <div className="flex items-center gap-2">
            <Input
              id={linkId}
              readOnly
              value={created.link}
              onFocus={(event) => {
                event.target.select();
              }}
            />
            <button
              type="button"
              className="btn"
              onClick={() => {
                void copyMeetingLink(created.link);
              }}
            >
              <CopyIcon size={16} aria-hidden="true" /> Copy
            </button>
          </div>
          <p className="m-0 type-meta text-muted-foreground">
            Only {created.email} can use this link. It expires in 24 hours.
          </p>
        </div>
      )}
    </Dialog>
  );
}
