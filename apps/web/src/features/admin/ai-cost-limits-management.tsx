import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { BadgeDollarSign, RotateCcw, Save, Trash2 } from "lucide-react";
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
import {
  aiCostLimitsQueryKeys,
  aiCostLimitsQueryOptions,
  clearAICostLimit,
  setAICostLimit,
  type AICostLimit,
} from "./ai-cost-limits-api";

interface AICostLimitsRouteQueryClient {
  ensureQueryData(options: ReturnType<typeof aiCostLimitsQueryOptions>): Promise<unknown>;
}

export async function prefetchAdminAICostLimitsQuery(
  queryClient: AICostLimitsRouteQueryClient,
) {
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
          <Button
            aria-label={`Clear AI cost limit for ${row.original.actorId}`}
            disabled={clearMutation.isPending}
            onClick={() => clearMutation.mutate(row.original.actorId)}
            size="sm"
            type="button"
            variant="destructive"
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

  return (
    <section
      aria-labelledby="ai-cost-limits-title"
      className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-4 sm:px-6 lg:px-8"
    >
      <header className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 text-card-foreground">
        <div className="flex items-center gap-2">
          <BadgeDollarSign aria-hidden="true" size={18} />
          <h3 id="ai-cost-limits-title" className="text-sm font-semibold">
            Per-user AI cost limits
          </h3>
        </div>
        <p className="text-xs text-muted-foreground">
          Override the daily AI spend budget for an individual user. Leave a field blank to use
          the {tierDefault === undefined ? "tier" : `${tierDefault.tier} tier`} default
          {tierDefault === undefined
            ? "."
            : ` (actor ${formatUsd(tierDefault.actorDailyUsd)}, feature ${formatUsd(
                tierDefault.featureDailyUsd,
              )}).`}
        </p>
      </header>

      <form
        className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end"
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

      {formError === null ? null : (
        <p className="text-xs text-destructive" role="alert">
          {formError}
        </p>
      )}
      {upsertMutation.isError ? (
        <p className="text-xs text-destructive" role="alert">
          {upsertMutation.error instanceof Error
            ? upsertMutation.error.message
            : "Failed to save AI cost limit."}
        </p>
      ) : null}
      {clearMutation.isError ? (
        <p className="text-xs text-destructive" role="alert">
          {clearMutation.error instanceof Error
            ? clearMutation.error.message
            : "Failed to clear AI cost limit."}
        </p>
      ) : null}
      {limitsQuery.isError ? (
        <p className="text-xs text-destructive" role="alert">
          AI cost limits are unavailable or admin AI scope is missing.
        </p>
      ) : null}
      {limitsQuery.isPending ? (
        <p className="text-xs text-muted-foreground" role="status">
          <RotateCcw aria-hidden="true" className="mr-1 inline size-3 animate-spin" />
          Loading AI cost limits
        </p>
      ) : null}

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
          {table.getRowModel().rows.length === 0 ? (
            <TableRow role="row">
              <TableCell colSpan={columns.length} role="cell">
                <span className="text-xs text-muted-foreground">
                  No per-user overrides. All users follow the tier default.
                </span>
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id} role="row">
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} role="cell">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  );
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Validates and normalizes the form into the upsert payload, or an error. */
export function normalizeFormInput(
  value: AICostLimitFormState,
):
  | { readonly actorId: string; readonly actorDailyUsd: number | null; readonly featureDailyUsd: number | null }
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
