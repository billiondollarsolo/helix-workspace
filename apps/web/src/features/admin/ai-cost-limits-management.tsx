import { RelativeTime } from "@/features/admin/console/widgets";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { BadgeDollarSign, Save, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeading, ErrorNotice, LoadingState } from "@/features/admin/console/primitives";
import { EmptyState } from "@/components/ui/empty-state";
import { PeoplePicker } from "@/components/people/people-picker";
import type { PersonRef } from "@/features/people/person-ref";
import { adminUsersQueryOptions, type AdminUsersQueryInput } from "./admin-users";
import {
  aiCostLimitsQueryKeys,
  aiCostLimitsQueryOptions,
  clearAICostLimit,
  setAICostLimit,
  type AICostLimit,
  type AICostTierDefault,
} from "./ai-cost-limits-api";

interface AICostLimitsRouteQueryClient {
  ensureQueryData(options: ReturnType<typeof aiCostLimitsQueryOptions>): Promise<unknown>;
}

export async function prefetchAdminAICostLimitsQuery(queryClient: AICostLimitsRouteQueryClient) {
  await queryClient.ensureQueryData(aiCostLimitsQueryOptions()).catch(() => undefined);
}

interface AICostLimitFormState {
  readonly actorId: string;
  readonly actorDailyUsd: string;
  readonly featureDailyUsd: string;
}

const defaultFormValues: AICostLimitFormState = {
  actorId: "",
  actorDailyUsd: "",
  featureDailyUsd: "",
};

/* Overrides are stored by account, so the list looks names up in the
   directory, including suspended accounts whose override is still in force. */
const DIRECTORY_LOOKUP_INPUT = {
  includeDisabled: true,
  limit: 250,
} as const satisfies AdminUsersQueryInput;

/**
 * Admin UI to view and set per-user AI cost limits (P0-7 / TASK-217).
 *
 * Empty inputs mean "use the tier default" for that dimension. The form
 * upserts an override; the table lists existing overrides and clears them.
 */
export function AICostLimitsManagement() {
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const [person, setPerson] = useState<PersonRef | null>(null);
  const limitsQuery = useQuery(aiCostLimitsQueryOptions());
  const directoryQuery = useQuery(adminUsersQueryOptions(DIRECTORY_LOOKUP_INPUT));
  const directory = useMemo(
    () => new Map((directoryQuery.data?.users ?? []).map((user) => [user.id, user])),
    [directoryQuery.data],
  );

  const upsertMutation = useMutation({
    mutationFn: (input: Parameters<typeof setAICostLimit>[0]) => setAICostLimit(input),
    onMutate: () => {
      setFormError(null);
    },
    onError: () => undefined,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: aiCostLimitsQueryKeys.list() });
    },
  });

  const clearMutation = useMutation({
    mutationFn: (actorId: string) => clearAICostLimit(actorId),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: aiCostLimitsQueryKeys.list() });
    },
  });

  const limits = limitsQuery.data?.limits ?? [];
  const tierDefault = limitsQuery.data?.tierDefault;
  const tableData = useMemo(() => [...limits], [limits]);

  const columns = useMemo<ColumnDef<AICostLimit>[]>(
    () => [
      {
        accessorKey: "actorId",
        header: "Person",
        cell: ({ row }) => {
          const user = directory.get(row.original.actorId);
          return (
            <span className="block max-w-[18rem] truncate">
              {personName(user)}
              {user?.email ? <span className="admin-row-detail">{user.email}</span> : null}
            </span>
          );
        },
      },
      {
        id: "actorDaily",
        header: "Daily budget",
        cell: ({ row }) => formatUsd(row.original.actorDailyUsd),
      },
      {
        id: "featureDaily",
        header: "Daily budget per feature",
        cell: ({ row }) => formatUsd(row.original.featureDailyUsd),
      },
      {
        accessorKey: "updatedAt",
        header: "Updated",
        cell: ({ row }) => <RelativeTime value={row.original.updatedAt} />,
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          // Outline, not destructive: clearing an override restores the tier
          // default rather than deleting anything, and a filled button per row
          // would out-shout the panel's own Save action.
          <Button
            aria-label={`Clear AI cost limit for ${personName(directory.get(row.original.actorId))}`}
            disabled={clearMutation.isPending}
            onClick={() => clearMutation.mutate(row.original.actorId)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Trash2 />
            Clear
          </Button>
        ),
      },
    ],
    [clearMutation, directory],
  );

  const table = useReactTable({
    data: tableData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.actorId,
  });

  const limitForm = useForm({
    defaultValues: defaultFormValues,
    onSubmit: async ({ value }) => {
      const normalized = normalizeFormInput(value);
      if (typeof normalized === "string") {
        setFormError(normalized);
        return;
      }
      setFormError(null);
      await upsertMutation.mutateAsync(normalized);
      limitForm.reset();
      setPerson(null);
    },
  });

  const hasOverrides = limits.length > 0;
  // Only claim "nobody has an override" once the list has actually loaded.
  const showEmptyState = !hasOverrides && !limitsQuery.isPending && !limitsQuery.isError;

  return (
    // `ai-costs` is registered through `withPageScroll` in admin-console.tsx,
    // so the scroll container, page padding, and 1280px cap already wrap this.
    <section className="grid gap-4">
      <PageHeading title="AI costs" subtitle={tierDefaultSubtitle(tierDefault)} />

      <section
        aria-labelledby="ai-cost-limits-form-heading"
        className="grid gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
      >
        <h2
          className="flex items-center gap-2 text-sm font-semibold"
          id="ai-cost-limits-form-heading"
        >
          <BadgeDollarSign aria-hidden="true" size={16} />
          Give one person a different budget
        </h2>

        <form
          className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void limitForm.handleSubmit();
          }}
        >
          <limitForm.Field name="actorId">
            {(field) => (
              <PeoplePicker
                label="Person"
                max={1}
                placeholder="Search by name or email"
                stacked
                value={person === null ? [] : [person]}
                onChange={(next) => {
                  const chosen = next[0] ?? null;
                  setPerson(chosen);
                  field.handleChange(chosen?.actorId ?? "");
                }}
              />
            )}
          </limitForm.Field>
          <limitForm.Field name="actorDailyUsd">
            {(field) => (
              <label className="grid gap-1 text-xs">
                <span className="font-medium">Daily budget (USD)</span>
                <Input
                  aria-label="Daily budget for this person in USD"
                  inputMode="decimal"
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="tier default"
                  value={field.state.value}
                />
              </label>
            )}
          </limitForm.Field>
          <limitForm.Field name="featureDailyUsd">
            {(field) => (
              <label className="grid gap-1 text-xs">
                <span className="font-medium">Per feature, daily (USD)</span>
                <Input
                  aria-label="Daily budget per feature in USD"
                  inputMode="decimal"
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="tier default"
                  value={field.state.value}
                />
              </label>
            )}
          </limitForm.Field>
          <Button disabled={upsertMutation.isPending} size="sm" type="submit">
            <Save />
            Save limit
          </Button>
        </form>

        {formError === null ? null : <ErrorNotice>{formError}</ErrorNotice>}
        {upsertMutation.isError ? (
          <ErrorNotice>
            {upsertMutation.error instanceof Error
              ? upsertMutation.error.message
              : "Failed to save AI cost limit."}
          </ErrorNotice>
        ) : null}
      </section>

      <section aria-labelledby="ai-cost-limits-overrides-heading" className="grid gap-2">
        <h2 className="text-sm font-semibold" id="ai-cost-limits-overrides-heading">
          Active overrides
        </h2>

        {limitsQuery.isPending ? <LoadingState label="Loading cost limits…" /> : null}
        {limitsQuery.isError ? (
          <ErrorNotice>
            Cost limits could not be loaded. You may not have permission to manage AI costs.
          </ErrorNotice>
        ) : null}
        {clearMutation.isError ? (
          <ErrorNotice>
            {clearMutation.error instanceof Error
              ? clearMutation.error.message
              : "Failed to clear AI cost limit."}
          </ErrorNotice>
        ) : null}

        {showEmptyState ? (
          <EmptyState
            icon={<BadgeDollarSign aria-hidden="true" />}
            title="No per-user overrides"
            size="inline"
            body={
              <>
                Every user is billed against the{" "}
                {tierDefault === undefined ? "tier" : tierDefault.tier} tier default. Save an
                override above to give one user a different daily AI budget.
              </>
            }
          />
        ) : null}

        {hasOverrides ? (
          <Table aria-label="Per-user AI cost limits" role="table">
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} role="row">
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id} role="columnheader">
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} role="row">
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} role="cell">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </section>
    </section>
  );
}

/** A name for an account, also when it is no longer in the directory. */
function personName(
  user: { readonly displayName: string; readonly email: string | null } | undefined,
): string {
  return user === undefined
    ? "Removed account"
    : user.displayName || user.email || "Unnamed account";
}

function tierDefaultSubtitle(tierDefault: AICostTierDefault | undefined): string {
  const lead = "Daily AI budgets. People without an override use the";
  if (tierDefault === undefined) {
    return `${lead} tier default.`;
  }
  return `${lead} ${tierDefault.tier} tier default: ${formatTierBudget(
    tierDefault.actorDailyUsd,
  )} per person, ${formatTierBudget(tierDefault.featureDailyUsd)} per feature.`;
}

/* A null budget means different things on either side of this screen: on a
 * tier default it is "no cap at this dimension", on a per-user override it is
 * "inherit the tier default". Rendering both as "tier default" made the tier
 * row claim it inherited from itself. */
function formatTierBudget(value: number | null): string {
  return value === null ? "Unlimited" : formatUsd(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Validates and normalizes the form into the upsert payload, or an error. */
export function normalizeFormInput(value: AICostLimitFormState):
  | {
      readonly actorId: string;
      readonly actorDailyUsd: number | null;
      readonly featureDailyUsd: number | null;
    }
  | string {
  const actorId = value.actorId.trim();
  if (!UUID_PATTERN.test(actorId)) {
    return "Choose the person this budget is for.";
  }
  const actorDailyUsd = parseOptionalUsd(value.actorDailyUsd);
  if (actorDailyUsd === "invalid") {
    return "Enter the daily budget as an amount of zero or more, or leave it empty.";
  }
  const featureDailyUsd = parseOptionalUsd(value.featureDailyUsd);
  if (featureDailyUsd === "invalid") {
    return "Enter the per-feature budget as an amount of zero or more, or leave it empty.";
  }
  return { actorId, actorDailyUsd, featureDailyUsd };
}

function parseOptionalUsd(raw: string): number | null | "invalid" {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return "invalid";
  }
  return parsed;
}

/* Built once: `Intl.NumberFormat` resolves its locale data on construction, and
   every budget on this page is the same two-decimal USD amount. */
const usdFormat = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency",
});

function formatUsd(value: number | null): string {
  if (value === null) {
    return "tier default";
  }
  return usdFormat.format(value);
}
