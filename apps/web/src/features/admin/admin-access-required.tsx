/* What a non-admin sees at `/admin/*`: the console needs admin scopes, so say
   so and point somewhere useful instead of rendering sections that would each
   fail with "forbidden". */

import { Shield as ShieldIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { SurfaceFrame } from "@/components/shell";
import { EmptyState } from "@/components/ui/empty-state";

export function AdminAccessRequired() {
  return (
    <SurfaceFrame title="Admin console" icon={<ShieldIcon size={16} />}>
      <div role="status" className="flex-1">
        <EmptyState
          icon={<ShieldIcon />}
          title="You need admin access"
          body="The Admin console is for workspace administrators. Ask an administrator to grant you an admin role if you need to manage users, apps or policies."
          action={
            <Link className="btn" to="/">
              Back to Helix
            </Link>
          }
        />
      </div>
    </SurfaceFrame>
  );
}
