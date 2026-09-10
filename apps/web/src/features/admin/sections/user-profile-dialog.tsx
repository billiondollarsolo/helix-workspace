import { ProfileForm } from "@/components/profile-form";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/helix-dialog";
import {
  QueryFailureBanner,
  StateBanner,
  useQueryFailure,
} from "@/features/admin/console/primitives";
import { profileQueryKeys, profileQueryOptions, updateProfile } from "@/lib/profile";
import { sessionQueryKeys } from "@/lib/auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export function AdminUserProfileDialog({
  actorId,
  name,
  onClose,
}: {
  readonly actorId: string;
  readonly name: string;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const profileQuery = useQuery(profileQueryOptions(actorId));
  const failure = useQueryFailure(profileQuery, () => {
    void queryClient.invalidateQueries({ queryKey: profileQueryKeys.byActor(actorId) });
  });

  return (
    <Dialog
      title={`Edit profile for ${name}`}
      onClose={onClose}
      footer={
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      {failure ? (
        <QueryFailureBanner
          summary="The profile is unavailable"
          subject="this profile"
          error={failure.error}
          isRetrying={failure.isRetrying}
          onRetry={failure.retry}
        />
      ) : profileQuery.data ? (
        <ProfileForm
          profile={profileQuery.data}
          onSave={(input) => updateProfile(input, actorId)}
          onSaved={(profile) => {
            queryClient.setQueryData(profileQueryKeys.byActor(actorId), profile);
            void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
            void queryClient.invalidateQueries({ queryKey: ["people", "directory"] });
            void queryClient.invalidateQueries({ queryKey: profileQueryKeys.current });
            void queryClient.invalidateQueries({ queryKey: sessionQueryKeys.current });
            onClose();
          }}
        />
      ) : (
        <StateBanner kind="loading">Loading profile…</StateBanner>
      )}
    </Dialog>
  );
}
