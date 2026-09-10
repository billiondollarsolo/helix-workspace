import { authenticatedFetch } from "@/lib/auth";
import { responseError } from "@/lib/tool-call";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";

const profileSchema = z.object({
  actorId: z.string(),
  orgId: z.string(),
  email: z.string().nullable(),
  displayName: z.string(),
  pronouns: z.string(),
  jobTitle: z.string(),
  about: z.string(),
});

export type UserProfile = z.infer<typeof profileSchema>;
export type ProfileInput = Pick<UserProfile, "displayName" | "pronouns" | "jobTitle" | "about">;

export const profileQueryKeys = {
  current: ["profile", "current"] as const,
  byActor: (actorId: string) => ["profile", "users", actorId] as const,
};

export function profileQueryOptions(actorId?: string) {
  return queryOptions({
    queryKey: actorId === undefined ? profileQueryKeys.current : profileQueryKeys.byActor(actorId),
    queryFn: () => requestProfile(actorId),
    staleTime: 30_000,
    throwOnError: false,
  });
}

export function updateProfile(input: ProfileInput, actorId?: string): Promise<UserProfile> {
  return requestProfile(actorId, input);
}

async function requestProfile(actorId?: string, input?: ProfileInput): Promise<UserProfile> {
  const path =
    actorId === undefined
      ? "/api/profile"
      : `/api/admin/users/${encodeURIComponent(actorId)}/profile`;
  const response = await authenticatedFetch(path, {
    method: input === undefined ? "GET" : "PATCH",
    ...(input === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
  });
  const output: unknown = await response.json().catch(() => null);
  if (!response.ok) throw responseError(response, output, "Profile request");
  const parsed = z.object({ profile: profileSchema }).safeParse(output);
  if (!parsed.success) throw new Error("The server returned an incomplete profile. Try again.");
  return parsed.data.profile;
}
