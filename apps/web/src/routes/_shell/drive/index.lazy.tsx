import { createLazyFileRoute, useNavigate } from "@tanstack/react-router";
import { CoreAppGate } from "@/components/core-app-gate";
import { DriveShell, type DriveShellRouteState } from "@/features/drive/drive-shell";

export const Route = createLazyFileRoute("/_shell/drive/")({
  component: DriveRoute,
});

function DriveRoute() {
  const navigate = useNavigate();
  const search = Route.useSearch();

  const updateRouteState = (nextState: DriveShellRouteState) => {
    void navigate({
      to: "/drive",
      search: {
        file: nextState.fileId ?? undefined,
        folder: nextState.folderId ?? undefined,
        includeTrashed: nextState.includeTrashed ? true : undefined,
        q: nextState.query.length > 0 ? nextState.query : undefined,
        scope:
          nextState.scope === undefined || nextState.scope === "my-drive"
            ? undefined
            : nextState.scope,
      },
    });
  };

  return (
    <CoreAppGate app="drive">
      <DriveShell
        initialFileId={search.file}
        onRouteStateChange={updateRouteState}
        routeState={{
          folderId: search.includeTrashed === true ? null : (search.folder ?? null),
          includeTrashed: search.includeTrashed === true,
          query: search.q ?? "",
          scope: search.scope,
        }}
      />
    </CoreAppGate>
  );
}
