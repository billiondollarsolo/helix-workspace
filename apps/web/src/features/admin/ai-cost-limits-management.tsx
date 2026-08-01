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
import { EmptyState, PageHeading, StateBanner } from "@/features/admin/console/primitives";
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

/**
 * Admin UI to view and set per-user AI cost limits (P0-7 / TASK-217).
 *
 * Empty inputs mean "use the tier default" for that dimension. The form
 * upserts an override; the table lists existing overrides and clears them.
 */
export function AICostLimitsManagement() {
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const limitsQuery = useQuery(aiCostLimitsQueryOptions());

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
        header: "Actor",
        cell: ({ row }) => (
          <code className="block max-w-[18rem] truncate text-[0.6875rem] text-muted-foreground">
            {row.original.actorId}
          </code>
        ),
      },
      {
        id: "actorDaily",
        header: "Actor daily budget",
        cell: ({ row }) => formatUsd(row.original.actorDailyUsd),
      },
      {
        id: "featureDaily",
        header: "Feature daily budget",
        cell: ({ row }) => formatUsd(row.original.featureDailyUsd),
      },
      {
        accessorKey: "updatedAt",
        header: "Updated",
        cell: ({ row }) => new Date(row.original.updatedAt).toLocaleString(),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          // Outline, not destructive: clearing an override restores the tier
          // default rather than deleting anything, and a filled button per row
          // would out-shout the panel's own Save action.
          <Button
            aria-label={`Clear AI cost limit for ${row.original.actorId}`}
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
    [clearMutation],
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
    },
  });

  const hasOverrides = limits.length > 0;
  // Only claim "nobody has an override" once the list has actually loaded.
  const showEmptyState = !hasOverrides && !limitsQuery.isPending && !limitsQuery.isError;

  return (
    // `ai-costs` is registered through `withPageScroll` in admin-console.tsx,
    // so the scroll container, page padding, and 1280px cap already wrap this.
    <section className="grid gap-4">
      <PageHeading title="AI cost limits" subtitle={tierDefaultSubtitle(tierDefault)} />

      <section
        aria-labelledby="ai-cost-limits-form-heading"
        className="grid gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
      >
        <h2
          className="flex items-center gap-2 text-sm font-semibold"
          id="ai-cost-limits-form-heading"
        >
          <BadgeDollarSign aria-hidden="true" size={16} />
          Set a per-user override
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
              <label className="grid gap-1 text-xs">
                <span className="font-medium">Actor ID</span>
                <Input
                  aria-label="Actor ID"
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  value={field.state.value}
                />
              </label>
            )}
          </limitForm.Field>
          <limitForm.Field name="actorDailyUsd">
            {(field) => (
              <label className="grid gap-1 text-xs">
                <span className="font-medium">Actor daily (USD)</span>
                <Input
                  aria-label="Actor daily budget in USD"
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
                <span className="font-medium">Feature daily (USD)</span>
                <Input
                  aria-label="Feature daily budget in USD"
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

        {formError === null ? null : <StateBanner kind="error">{formError}</StateBanner>}
        {upsertMutation.isError ? (
          <StateBanner kind="error">
            {upsertMutation.error instanceof Error
              ? upsertMutation.error.message
              : "Failed to save AI cost limit."}
          </StateBanner>
        ) : null}
      </section>

      <section aria-labelledby="ai-cost-limits-overrides-heading" className="grid gap-2">
        <h2 className="text-sm font-semibold" id="ai-cost-limits-overrides-heading">
          Active overrides
        </h2>

        {limitsQuery.isPending ? (
          <StateBanner kind="loading">Loading AI cost limits…</StateBanner>
        ) : null}
        {limitsQuery.isError ? (
          <StateBanner kind="error">
            AI cost limits are unavailable or admin AI scope is missing.
          </StateBanner>
        ) : null}
        {clearMutation.isError ? (
          <StateBanner kind="error">
            {clearMutation.error instanceof Error
              ? clearMutation.error.message
              : "Failed to clear AI cost limit."}
          </StateBanner>
        ) : null}

        {showEmptyState ? (
          <EmptyState icon={<BadgeDollarSign aria-hidden="true" />} title="No per-user overrides">
            Every user is billed against the {tierDefault === undefined ? "tier" : tierDefault.tier}{" "}
            tier default. Save an override above to give one user a different daily AI budget.
          </EmptyState>
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

function tierDefaultSubtitle(tierDefault: AICostTierDefault | undefined): string {
  const lead =
    "Override the daily AI spend budget for an individual user. A blank field falls back to the";
  if (tierDefault === undefined) {
    return `${lead} tier default.`;
  }
  return `${lead} ${tierDefault.tier} tier default (actor ${formatTierBudget(
    tierDefault.actorDailyUsd,
  )}, feature ${formatTierBudget(tierDefault.featureDailyUsd)}).`;
}

/* A null budget means different things on either side of this screen: on a
 * tier default it is "no cap at this dimension", on a per-user override it is
 * "inherit the tier default". Rendering both as "tier default" made the tier
 * row claim it inherited from itself. */
function formatTierBudget(value: number | null): string {
  return value === null ? "no cap" : formatUsd(value);
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
    return "Actor ID must be a valid UUID.";
  }
  const actorDailyUsd = parseOptionalUsd(value.actorDailyUsd);
  if (actorDailyUsd === "invalid") {
    return "Actor daily budget must be a non-negative number.";
  }
  const featureDailyUsd = parseOptionalUsd(value.featureDailyUsd);
  if (featureDailyUsd === "invalid") {
    return "Feature daily budget must be a non-negative number.";
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

function formatUsd(value: number | null): string {
  if (value === null) {
    return "tier default";
  }
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}
