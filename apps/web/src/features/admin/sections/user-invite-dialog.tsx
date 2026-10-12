/* Invite one person by email. They receive a link to choose a password and
 * join; until then they appear in Users as Invited. */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/helix-dialog";
import { notify } from "@/components/ui/toast";
import { inviteAdminUser, type AdminInviteRole } from "@/features/admin/admin-users";
import { AdminField, AdminInput, AdminSelect } from "@/features/admin/console/controls";

export function UserInviteDialog({ onClose }: { readonly onClose: () => void }) {
  const formId = useId();
  const errorId = useId();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<AdminInviteRole>("member");
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () =>
      inviteAdminUser({
        email: email.trim(),
        ...(displayName.trim().length === 0 ? {} : { displayName: displayName.trim() }),
        role,
      }),
    onMutate: () => undefined,
    onSuccess: (invitation) => {
      notify({
        message: `Invitation sent to ${invitation.email}`,
        description: "The link expires in 7 days.",
      });
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      onClose();
    },
    onError: (caught: Error) => setError(caught.message),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.trim())) {
      setError("Enter the email address to send the invitation to.");
      return;
    }
    setError(null);
    mutation.mutate();
  };

  return (
    <Dialog
      title="Invite people"
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={mutation.isPending}
            aria-busy={mutation.isPending}
          >
            {mutation.isPending ? "Sending…" : "Send invitation"}
          </Button>
        </>
      }
    >
      <form id={formId} className="grid gap-3" noValidate onSubmit={submit}>
        <p className="type-body-sm text-[var(--text-2)]">
          They get an email with a link to choose a password. The link expires in 7 days.
        </p>
        <AdminField label="Email">
          <AdminInput
            type="email"
            name="email"
            autoComplete="off"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={error === null ? undefined : true}
            aria-describedby={error === null ? undefined : errorId}
          />
        </AdminField>
        <AdminField label="Name (optional)">
          <AdminInput
            name="displayName"
            autoComplete="off"
            maxLength={200}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </AdminField>
        <AdminField label="Role">
          <AdminSelect
            name="role"
            value={role}
            onChange={(event) => setRole(event.target.value === "admin" ? "admin" : "member")}
          >
            <option value="member">Member</option>
            <option value="admin">Administrator</option>
          </AdminSelect>
        </AdminField>
        {error === null ? null : (
          <p id={errorId} className="type-body-sm text-[var(--danger)]" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
