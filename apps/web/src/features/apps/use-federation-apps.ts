import { queryOptions, useQuery } from "@tanstack/react-query";
import { authenticatedFetch, sessionUserQueryOptions } from "@/lib/auth";

export function useFederationApps(open: boolean) {
  const session = useQuery(sessionUserQueryOptions());
  return useQuery(federationAppsQueryOptions(session.data?.id, open));
}

function federationAppsQueryOptions(userId: string | undefined, open: boolean) {
  return queryOptions({
    queryKey: ["federation", "apps", userId],
    enabled: open && userId !== undefined,
    staleTime: 15_000,
    retry: false,
    queryFn: async () => {
      const response = await authenticatedFetch("/api/federation/apps");
      if (response.status === 404) return [];
      if (!response.ok) throw new Error("Connected applications are temporarily unavailable.");
      const data = (await response.json()) as { applications: unknown[] };
      if (!Array.isArray(data.applications))
        throw new Error("Connected applications could not be loaded.");
      return data.applications.flatMap((value) => {
        if (
          typeof value !== "object" ||
          value === null ||
          !("id" in value) ||
          typeof value.id !== "string" ||
          !("url" in value) ||
          typeof value.url !== "string" ||
          !("label" in value) ||
          typeof value.label !== "string"
        )
          return [];
        try {
          const url = new URL(value.url);
          if (
            url.origin !== value.url ||
            (url.protocol !== "https:" &&
              !(
                url.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
              ))
          )
            return [];
          return [{ id: value.id, label: value.label, url: value.url }];
        } catch {
          return [];
        }
      });
    },
  });
}
