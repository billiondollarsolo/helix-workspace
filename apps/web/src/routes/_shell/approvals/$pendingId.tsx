import { createFileRoute } from "@tanstack/react-router";
import { PendingActionReview } from "@/features/approvals/pending-action-review";

export const Route = createFileRoute("/_shell/approvals/$pendingId")({
  component: ReviewRoute,
});

function ReviewRoute() {
  const { pendingId } = Route.useParams();
  return <PendingActionReview key={pendingId} pendingId={pendingId} />;
}
