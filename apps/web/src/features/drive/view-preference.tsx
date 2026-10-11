import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import {
  getDriveDocumentSurfaceView,
  setDriveDocumentSurfaceView,
  type DriveDocumentSurfaceView,
} from "./api";

export type DocumentSurfaceView = DriveDocumentSurfaceView;

const documentSurfaceViewQueryKey = ["drive", "document-surface-view"] as const;

function documentSurfaceViewQueryOptions() {
  return queryOptions({
    queryKey: documentSurfaceViewQueryKey,
    queryFn: () => getDriveDocumentSurfaceView(),
    staleTime: 5 * 60_000,
    retry: false,
    throwOnError: false,
  });
}

export function useDocumentSurfaceViewPreference(
  defaultView: DocumentSurfaceView = "grid",
): readonly [DocumentSurfaceView, (view: DocumentSurfaceView) => void] {
  const queryClient = useQueryClient();
  const [optimisticView, setOptimisticView] = useState<DocumentSurfaceView | null>(null);
  const preference = useQuery(documentSurfaceViewQueryOptions());
  const { mutate } = useMutation({
    mutationFn: (view: DocumentSurfaceView) => setDriveDocumentSurfaceView(view),
    onMutate: (next) => {
      const previous = queryClient.getQueryData<DocumentSurfaceView>(documentSurfaceViewQueryKey);
      void queryClient.cancelQueries({ queryKey: documentSurfaceViewQueryKey });
      queryClient.setQueryData(documentSurfaceViewQueryKey, next);
      return { previous };
    },
    onError: (_error, _next, context) => {
      queryClient.setQueryData(documentSurfaceViewQueryKey, context?.previous ?? defaultView);
      setOptimisticView(null);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(documentSurfaceViewQueryKey, saved);
      setOptimisticView(null);
    },
  });

  const setView = useCallback(
    (next: DocumentSurfaceView) => {
      setOptimisticView(next);
      mutate(next);
    },
    [mutate],
  );

  return [optimisticView ?? preference.data ?? defaultView, setView] as const;
}
