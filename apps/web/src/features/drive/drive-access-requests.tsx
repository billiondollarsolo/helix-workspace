/* Requests for access to items the signed-in person owns, shown above their
   Drive until each is answered. Approving gives the person view access. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { InlineError } from "@/components/ui/inline-error";
import { decideDriveAccess } from "./drive-collaboration-api";
import { driveAccessRequestsQueryOptions, driveQueryKeys } from "./queries";

export function DriveAccessRequests() {
  const queryClient = useQueryClient();
  const requestsQuery = useQuery(driveAccessRequestsQueryOptions());
  const decide = useMutation({
    mutationFn: (input: { readonly requestId: string; readonly approve: boolean }) =>
      decideDriveAccess(input.requestId, input.approve),
    // The failure is shown under the list; nothing is changed optimistically.
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
    },
  });
  const requests = requestsQuery.data ?? [];
  if (requests.length === 0) return null;
  return (
    <section aria-labelledby="drive-access-requests-heading" className="drive-access-requests">
      <h2 id="drive-access-requests-heading" className="type-body-sm font-semibold m-0">
        People asking for access
      </h2>
      <ul className="m-0 grid list-none gap-2 p-0">
        {requests.map((request) => {
          const who = request.requesterDisplayName ?? request.requesterEmail ?? "Someone";
          return (
            <li key={request.id} className="flex flex-wrap items-center gap-2">
              <p className="m-0 min-w-0 flex-1 type-body-sm">
                <span className="font-medium">{who}</span> asked for access to{" "}
                <span className="font-medium">{request.objectName}</span>
                {request.message === null ? null : (
                  <span className="block text-muted-foreground">“{request.message}”</span>
                )}
              </p>
              <button
                type="button"
                className="btn sm primary"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ requestId: request.id, approve: true })}
              >
                Give access
                <span className="sr-only">
                  {" "}
                  to {who} for {request.objectName}
                </span>
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ requestId: request.id, approve: false })}
              >
                Decline
                <span className="sr-only">
                  {" "}
                  {who}’s request for {request.objectName}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {decide.error === null ? null : (
        <InlineError
          variant="compact"
          title="The request wasn’t answered"
          message={decide.error.message}
        />
      )}
    </section>
  );
}
