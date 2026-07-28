/* /open/:objectId — universal open intermediary for raw Drive files.
 *
 * Importable document/spreadsheet/presentation formats must not silently mint
 * native Helix copies. This route parses enough to know what the file is, then
 * asks the user whether to create an editable copy, preview the original, or
 * download it. The original upload always stays untouched in Drive.
 */

import { createFileRoute, useRouter } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { CORE_WORKSPACE_STORAGE_ONLY } from "@/components/apps";
import { fetchDriveBlob } from "@/features/_open/drive-fetcher";
import type { LoaderResult } from "@/features/_open/universal-loader";
import type { ConvertedTarget } from "@/features/_open/converters";
import {
  canCreateEditableCopy,
  editableCopyUnavailableMessage,
} from "@/features/_open/conversion-capabilities";
import type { ImportedDeck, ImportedDoc, ImportedSheet } from "@/features/_open/parsers/types";
import { UnsupportedFormatPlaceholder } from "@/features/_open/ui/UnsupportedFormatPlaceholder";

const LazyImportedDeckRenderer = lazy(() =>
  import("@/features/_open/ui/ImportedDeckRenderer").then((module) => ({
    default: module.ImportedDeckRenderer,
  })),
);
const LazyImportedDocumentRenderer = lazy(() =>
  import("@/features/_open/ui/ImportedDocumentRenderer").then((module) => ({
    default: module.ImportedDocumentRenderer,
  })),
);
const LazyImportedSheetRenderer = lazy(() =>
  import("@/features/_open/ui/ImportedSheetRenderer").then((module) => ({
    default: module.ImportedSheetRenderer,
  })),
);

export const Route = createFileRoute("/_shell/open/$objectId")({
  component: OpenRoute,
});

type OpenRouteRouter = Pick<ReturnType<typeof useRouter>, "navigate">;
type ImportedParsed = Extract<LoaderResult, { readonly kind: "imported" }>["parsed"];
type EditableParsed = ImportedDoc | ImportedSheet | ImportedDeck;
type OpenDecision = "ask" | "preview" | "import";

function OpenRoute() {
  const { objectId } = Route.useParams();
  const router = useRouter();
  return <OpenObjectRouteContent objectId={objectId} router={router} />;
}

export function OpenObjectRouteContent({
  objectId,
  router,
}: {
  readonly objectId: string;
  readonly router: OpenRouteRouter;
}) {
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [decision, setDecision] = useState<OpenDecision>("ask");

  // First: detect the format and parse the blob enough to know which
  // importer to invoke. A 30s overall timeout protects against parser hangs
  // (e.g. SheetJS on password-protected XLSX) so the user gets a real error
  // page instead of an infinite "Preparing file…" spinner.
  const loadQuery = useQuery(openObjectQueryOptions(objectId));

  // Then: run the matching server-side importer and resolve to a fresh
  // native helix entity that we can route to.
  const importMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: async (): Promise<ConvertedTarget> => {
      const result = loadQuery.data;
      if (result === undefined || result.kind !== "imported") {
        throw new Error("Drive blob is not importable into a native helix editor.");
      }
      const [
        blob,
        { convertImportedDeckToNative, convertImportedDocToNative, convertImportedSheetToNative },
      ] = await Promise.all([fetchDriveBlob(objectId), import("@/features/_open/converters")]);
      const { parsed } = result;
      if (parsed.kind === "doc") {
        return convertImportedDocToNative(blob, parsed, objectId);
      }
      if (parsed.kind === "sheet") {
        return convertImportedSheetToNative(blob, parsed, objectId);
      }
      if (parsed.kind === "deck") {
        return convertImportedDeckToNative(blob, parsed, objectId);
      }
      throw new Error(`No native editor for parsed kind: ${parsed.kind}`);
    },
  });

  // Once the load resolves, only read-only formats auto-route to dedicated
  // viewers. Editable foreign formats render the explicit copy/preview choice.
  useEffect(() => {
    const result = loadQuery.data;
    if (result === undefined) return;
    if (result.kind === "not-found") {
      setTerminalError("This file no longer exists in Drive.");
      return;
    }
    if (result.kind === "unsupported") return;
    const { parsed } = result;
    if (parsed.kind === "doc" || parsed.kind === "sheet" || parsed.kind === "deck") {
      return;
    }
    // Read-only formats — bounce to the matching native viewer route.
    if (parsed.kind === "pdf") {
      void router.navigate({ to: "/pdf/$objectId", params: { objectId }, replace: true });
      return;
    }
    // Image / audio / video / ebook don't have dedicated SPA viewer routes yet;
    // surface them through the raw preview endpoint so the browser renders
    // them inline.
    window.location.replace(`/api/drive/objects/${objectId}/preview`);
  }, [loadQuery.data, objectId, router]);

  // Navigate to the freshly-imported native helix entity.
  useEffect(() => {
    const target = importMutation.data;
    if (target === undefined) return;
    switch (target.surface) {
      case "docs":
        void router.navigate({
          to: "/docs/$documentId",
          params: { documentId: target.id },
          replace: true,
        });
        break;
      case "sheets":
        void router.navigate({ to: "/sheets", search: { sheet: target.id }, replace: true });
        break;
      case "slides":
        void router.navigate({ to: "/slides", search: { deck: target.id }, replace: true });
        break;
    }
  }, [importMutation.data, router]);

  if (terminalError !== null) {
    return <CenteredMessage isError>{terminalError}</CenteredMessage>;
  }
  if (loadQuery.isError) {
    return (
      <CenteredMessage isError>Failed to load file: {loadQuery.error.message}</CenteredMessage>
    );
  }
  if (importMutation.isError) {
    const err = importMutation.error;
    const message = isConverterNotAvailableError(err)
      ? `${err.message} Preview or download the original instead.`
      : `Failed to import file into helix: ${err.message}`;
    return <CenteredMessage isError>{message}</CenteredMessage>;
  }

  const result = loadQuery.data;
  if (result?.kind === "unsupported") {
    return (
      <UnsupportedFormatPlaceholder
        result={result.result}
        objectId={objectId}
        fileName={result.blob.name}
        byteSize={result.blob.byteLength}
      />
    );
  }
  if (result?.kind === "imported" && isEditableParsed(result.parsed)) {
    if (decision === "preview") {
      return renderEditablePreview(result.parsed, objectId, result.blob.name);
    }
    if (decision === "import" || importMutation.isPending || importMutation.data !== undefined) {
      return (
        <CenteredMessage>
          Importing {result.parsed.format.label} into {surfaceProductLabel(result.parsed)}…
        </CenteredMessage>
      );
    }
    return (
      <OpenConversionChoice
        parsed={result.parsed}
        fileName={result.blob.name}
        objectId={objectId}
        onPreviewOnly={() => {
          setDecision("preview");
        }}
        onCreateCopy={() => {
          setDecision("import");
          importMutation.mutate();
        }}
      />
    );
  }

  return <CenteredMessage>Preparing file…</CenteredMessage>;
}

function openObjectQueryOptions(objectId: string) {
  return queryOptions({
    queryKey: ["open-route", objectId],
    queryFn: async () => {
      const timeout = AbortSignal.timeout(30_000);
      const loaderPromise = import("@/features/_open/universal-loader").then(
        ({ loadDriveObjectForEditor }) => loadDriveObjectForEditor(objectId),
      );
      return Promise.race([
        loaderPromise,
        new Promise<never>((_resolve, reject) => {
          timeout.addEventListener(
            "abort",
            () => {
              reject(
                new Error(
                  "Format detection / parse timed out after 30s. The file may be password-protected, corrupt, or an unsupported variant.",
                ),
              );
            },
            { once: true },
          );
        }),
      ]);
    },
    throwOnError: false,
  });
}

function isEditableParsed(parsed: ImportedParsed): parsed is EditableParsed {
  return parsed.kind === "doc" || parsed.kind === "sheet" || parsed.kind === "deck";
}

function renderEditablePreview(
  parsed: EditableParsed,
  objectId: string,
  fileName: string,
): ReactNode {
  switch (parsed.kind) {
    case "doc":
      return withPreviewFallback(
        <LazyImportedDocumentRenderer doc={parsed} objectId={objectId} fileName={fileName} />,
      );
    case "sheet":
      return withPreviewFallback(
        <LazyImportedSheetRenderer sheet={parsed} objectId={objectId} fileName={fileName} />,
      );
    case "deck":
      return withPreviewFallback(
        <LazyImportedDeckRenderer deck={parsed} objectId={objectId} fileName={fileName} />,
      );
  }
}

function surfaceProductLabel(parsed: EditableParsed): string {
  switch (parsed.kind) {
    case "doc":
      return "Docs";
    case "sheet":
      return "Sheets";
    case "deck":
      return "Slides";
  }
}

function surfaceNoun(parsed: EditableParsed): string {
  switch (parsed.kind) {
    case "doc":
      return "document";
    case "sheet":
      return "spreadsheet";
    case "deck":
      return "presentation";
  }
}

function OpenConversionChoice({
  parsed,
  fileName,
  objectId,
  onPreviewOnly,
  onCreateCopy,
}: {
  readonly parsed: EditableParsed;
  readonly fileName: string;
  readonly objectId: string;
  readonly onPreviewOnly: () => void;
  readonly onCreateCopy: () => void;
}) {
  const canCreateCopy = !CORE_WORKSPACE_STORAGE_ONLY && canCreateEditableCopy(parsed);
  return (
    <div
      style={{
        minHeight: 420,
        display: "grid",
        placeItems: "center",
        padding: 32,
      }}
    >
      <section
        role="dialog"
        aria-modal="false"
        aria-labelledby="open-conversion-title"
        style={{
          width: "min(520px, 100%)",
          border: "1px solid var(--border)",
          background: "var(--surface)",
          borderRadius: 8,
          boxShadow: "var(--shadow-sm)",
          padding: 20,
        }}
      >
        <h1
          id="open-conversion-title"
          style={{ margin: 0, fontSize: "var(--text-h2)", fontWeight: 650 }}
        >
          {canCreateCopy ? "Create editable copy?" : "Preview/download only"}
        </h1>
        <p
          style={{
            margin: "10px 0 0",
            color: "var(--text-2)",
            fontSize: "var(--text-body-sm)",
            lineHeight: 1.5,
          }}
        >
          {canCreateCopy ? (
            <>
              Helix can create an editable {surfaceProductLabel(parsed)} {surfaceNoun(parsed)} from{" "}
              <strong>{fileName}</strong>. The original {parsed.format.label} stays unchanged in
              Drive.
            </>
          ) : (
            <>
              Helix can preview <strong>{fileName}</strong>, but{" "}
              {editableCopyUnavailableMessage(parsed.format)} The original file stays unchanged in
              Drive.
            </>
          )}
        </p>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            flexWrap: "wrap",
            gap: 8,
            marginTop: 18,
            paddingTop: 14,
            borderTop: "1px solid var(--border)",
          }}
        >
          <a
            className="btn sm"
            href={`/api/drive/objects/${objectId}/content?download=1`}
            download={fileName}
          >
            Download original
          </a>
          <button type="button" className="btn sm" onClick={onPreviewOnly}>
            Preview only
          </button>
          {canCreateCopy ? (
            <button type="button" className="btn sm primary" onClick={onCreateCopy}>
              Create copy
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function CenteredMessage({
  children,
  isError = false,
}: {
  readonly children: React.ReactNode;
  readonly isError?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 320,
        padding: 32,
        color: isError ? "var(--danger)" : "var(--text-2)",
        fontSize: "var(--text-body)",
      }}
    >
      {children}
    </div>
  );
}

function withPreviewFallback(content: ReactNode): ReactNode {
  return (
    <Suspense fallback={<CenteredMessage>Loading preview…</CenteredMessage>}>{content}</Suspense>
  );
}

function isConverterNotAvailableError(error: Error): boolean {
  return error.name === "ConverterNotAvailableError";
}
