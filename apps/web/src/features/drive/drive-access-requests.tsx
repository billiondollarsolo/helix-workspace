import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { decideDriveAccess } from "./drive-collaboration-api";
import { driveAccessRequestsQueryOptions, driveQueryKeys } from "./queries";

export function DriveAccessRequests() {
  const queryClient = useQueryClient();
  const requestsQuery = useQuery(driveAccessRequestsQueryOptions());
  const decideMutation = useMutation({
    mutationFn: (input: { readonly requestId: string; readonly approve: boolean }) =>
      decideDriveAccess(input.requestId, input.approve),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
    },
  });
  const requests = requestsQuery.data ?? [];
  if (requests.length === 0) return null;
  return (
    <section
      aria-label="Access requests"
      className="[margin:16px_24px_0] [padding:10px_12px] rounded-md [border:1px_solid_var(--border)] bg-card"
    >
      <div className="[font-size:var(--text-caption)] font-semibold mb-2">Access requests</div>
      <ul className="grid gap-2 [padding:0] [list-style:none] m-0">
        {requests.map((request) => {
          const who = request.requesterDisplayName ?? request.requesterEmail ?? "Someone";
          return (
            <li key={request.id} className="flex items-center gap-2 min-w-0">
              <div className="flex-1 min-w-0 [font-size:var(--text-caption)]">
                <span className="font-medium">{who}</span>
                {` wants access to ${request.objectName}`}
              </div>
              <button
                type="button"
                className="btn sm primary"
                disabled={decideMutation.isPending}
                onClick={() => decideMutation.mutate({ requestId: request.id, approve: true })}
              >
                Approve
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={decideMutation.isPending}
                onClick={() => decideMutation.mutate({ requestId: request.id, approve: false })}
              >
                Decline
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
