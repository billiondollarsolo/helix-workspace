/* Universal router that every editor route mounts as its top-level component.
 *
 * Pipeline:
 *   1. Try to fetch the native editor session (docs.get / sheets.get / etc.)
 *      via the supplied `nativeQueryOptions`.
 *   2. If the native fetch succeeds → render `renderNative()`.
 *   3. If the native fetch 404s / returns null → call the universal loader,
 *      which fetches the Drive blob, detects format, and parses it.
 *   4. Dispatch the parse result to the matching Imported*Renderer.
 *   5. Unsupported / unknown formats → UnsupportedFormatPlaceholder.
 *
 * This is the single entry point that flips the "default is native helix-
 * editors" guarantee from "best effort" to "structurally enforced."
 */

import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { docsDocumentQueryOptions } from "@/features/docs/queries";
import type { EditorSurface } from "../format-detection.js";
import { loadDriveObjectForEditor } from "../universal-loader.js";
import {
  convertImportedDeckToNative,
  convertImportedDocToNative,
  convertImportedSheetToNative,
  ConverterNotAvailableError,
  type ConvertedTarget,
} from "../converters.js";
import {
  canCreateEditableCopy,
  editableCopyUnavailableMessage,
} from "../conversion-capabilities.js";
import { fetchDriveBlob } from "../drive-fetcher.js";
import { ImportedAudioRenderer } from "./ImportedAudioRenderer.js";
import { ImportedDeckRenderer } from "./ImportedDeckRenderer.js";
import { ImportedDocumentRenderer } from "./ImportedDocumentRenderer.js";
import { ImportedEbookRenderer } from "./ImportedEbookRenderer.js";
import { ImportedImageRenderer } from "./ImportedImageRenderer.js";
import { ImportedPdfRenderer } from "./ImportedPdfRenderer.js";
import { ImportedSheetRenderer } from "./ImportedSheetRenderer.js";
import { ImportedVideoRenderer } from "./ImportedVideoRenderer.js";
import { UnsupportedFormatPlaceholder } from "./UnsupportedFormatPlaceholder.js";

/** The native-fetch query handle the router needs — caller-owned via useQuery. */
export interface NativeFetchHandle<TNative> {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly isSuccess: boolean;
  readonly data: TNative | null | undefined;
}

export interface UniversalEditorRouterProps<TNative> {
  readonly objectId: string;
  readonly surface: EditorSurface;
  readonly nativeEditingEnabled?: boolean;
  /** Pre-fetched native session query handle. Caller invokes useQuery with
   *  its strongly-typed query options and passes the result here. */
  readonly nativeFetch: NativeFetchHandle<TNative>;
  /** Renders the native editor with the resolved native session. */
  readonly renderNative: (session: TNative) => ReactNode;
}

type OpenDecision = "ask" | "preview" | "import";
const IN_FLIGHT_IMPORTS_KEY = "__helixUniversalEditorInFlightImports";
const inFlightImports = universalEditorInFlightImports();

export function UniversalEditorRouter<TNative>({
  objectId,
  surface,
  nativeEditingEnabled = true,
  nativeFetch,
  renderNative,
}: UniversalEditorRouterProps<TNative>) {
  const nativeQuery = nativeFetch;
  const nativeDisabled = !nativeEditingEnabled;

  // Always try universal in parallel — cheap once the native succeeds because
  // we short-circuit via `enabled`. When the native errors with 404 or returns
  // null, we already have the universal load underway.
  const nativeMissing =
    nativeDisabled ||
    nativeQuery.isError ||
    (nativeQuery.isSuccess && (nativeQuery.data === null || nativeQuery.data === undefined));

  const universalQuery = useQuery({
    queryKey: ["universal-open", objectId, surface],
    queryFn: () => loadDriveObjectForEditor(objectId, { expectedSurface: surface }),
    enabled: nativeMissing,
    throwOnError: false,
  });

  if (!nativeDisabled && nativeQuery.isLoading) {
    return <CenteredMessage>Loading…</CenteredMessage>;
  }

  if (
    !nativeDisabled &&
    nativeQuery.isSuccess &&
    nativeQuery.data !== null &&
    nativeQuery.data !== undefined
  ) {
    return <>{renderNative(nativeQuery.data)}</>;
  }

  // Native fetch failed → universal loader.
  if (universalQuery.isLoading) {
    return <CenteredMessage>Preparing file…</CenteredMessage>;
  }
  if (universalQuery.isError) {
    if (nativeDisabled) {
      return <EditorsDisabledStorageOnly objectId={objectId} />;
    }
    return (
      <CenteredMessage isError>
        Failed to load file: {universalQuery.error.message}
      </CenteredMessage>
    );
  }

  const result = universalQuery.data;
  if (result === undefined) {
    return <CenteredMessage>Preparing file…</CenteredMessage>;
  }

  if (result.kind === "not-found") {
    return <CenteredMessage>This file no longer exists in Drive.</CenteredMessage>;
  }

  if (result.kind === "unsupported") {
    return (
      <UnsupportedFormatPlaceholder
        result={result.result}
        objectId={objectId}
        fileName={result.blob.name}
        byteSize={result.blob.byteLength}
      />
    );
  }

  // Imported — for doc/sheet/deck, ask before creating an editable native
  // copy so raw Drive uploads are never silently mutated into new native
  // files. PDF and image stay in their dedicated read-only viewers.
  const { parsed } = result;
  switch (parsed.kind) {
    case "doc":
    case "sheet":
    case "deck":
      return (
        <ImportDecision
          parsed={parsed}
          objectId={objectId}
          fileName={result.blob.name}
          nativeEditingEnabled={nativeEditingEnabled}
        />
      );
    case "pdf":
      return <ImportedPdfRenderer pdf={parsed} objectId={objectId} />;
    case "image":
      return <ImportedImageRenderer image={parsed} objectId={objectId} />;
    case "audio":
      return <ImportedAudioRenderer audio={parsed} objectId={objectId} />;
    case "video":
      return <ImportedVideoRenderer video={parsed} objectId={objectId} />;
    case "ebook":
      return <ImportedEbookRenderer ebook={parsed} objectId={objectId} />;
    case "unsupported":
      return <UnsupportedFormatPlaceholder result={parsed} objectId={objectId} />;
  }
}

/** Fires the matching server import tool, then router.navigate()s to the
 *  freshly-created native helix entity. The user briefly sees "Importing
 *  into helix-docs…" then lands in the full native editor. */
function ConvertAndRedirect({
  parsed,
  objectId,
}: {
  readonly parsed:
    | import("../parsers/types.js").ImportedDoc
    | import("../parsers/types.js").ImportedSheet
    | import("../parsers/types.js").ImportedDeck;
  readonly objectId: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [importError, setImportError] = useState<Error | null>(null);

  // Kick off the import on first render. The mutation will resolve to a new
  // native helix entity id; we navigate there.
  useEffect(() => {
    let cancelled = false;
    const promise = getOrStartImport(importKey(objectId, parsed), async () => {
      // Re-fetch the blob to ensure the converter has the original bytes (the
      // parsed result holds bytes for pdf/image but not necessarily for doc /
      // sheet / deck shapes).
      const blob = await fetchDriveBlob(objectId);
      if (parsed.kind === "doc") {
        return convertImportedDocToNative(blob, parsed, objectId);
      }
      if (parsed.kind === "sheet") {
        return convertImportedSheetToNative(blob, parsed, objectId);
      }
      return convertImportedDeckToNative(blob, parsed, objectId);
    });

    void promise
      .then((target) => {
        if (cancelled) return;
        // Pre-warm the destination route's existence-check cache so when the
        // editor route mounts with the new id, it doesn't race-fall-through
        // to the universal loader before the docs.get / sheets.get / slides.get
        // fetch completes. We seed with a sentinel truthy value; the editor
        // route's own internal fetches replace it with real data shortly after.
        const sentinel = { id: target.id, __freshlyImported: true } as never;
        if (target.surface === "docs") {
          queryClient.setQueryData(docsDocumentQueryOptions(target.id).queryKey, sentinel);
        }
        switch (target.surface) {
          case "docs":
            void router.navigate({ to: "/docs/$documentId", params: { documentId: target.id } });
            break;
          case "sheets":
            void router.navigate({ to: "/sheets", search: { sheet: target.id } });
            break;
          case "slides":
            void router.navigate({ to: "/slides", search: { deck: target.id } });
            break;
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setImportError(err instanceof Error ? err : new Error(String(err)));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [objectId, parsed, queryClient, router]);

  if (importError !== null) {
    const err = importError;
    if (err instanceof ConverterNotAvailableError) {
      // Fall back to the read-only viewer for formats whose server-side
      // import tool isn't built yet (e.g. ODP today).
      switch (parsed.kind) {
        case "doc":
          return <ImportedDocumentRenderer doc={parsed} objectId={objectId} />;
        case "sheet":
          return <ImportedSheetRenderer sheet={parsed} objectId={objectId} />;
        case "deck":
          return <ImportedDeckRenderer deck={parsed} objectId={objectId} />;
      }
    }
    return (
      <CenteredMessage isError>
        Failed to import file into helix: {err.message ?? String(err)}
      </CenteredMessage>
    );
  }

  const surfaceLabel =
    parsed.kind === "doc"
      ? "helix-docs"
      : parsed.kind === "sheet"
        ? "helix-sheets"
        : "helix-slides";
  return (
    <CenteredMessage>
      Importing {parsed.format.label} into {surfaceLabel}…
    </CenteredMessage>
  );
}

function importKey(
  objectId: string,
  parsed:
    | import("../parsers/types.js").ImportedDoc
    | import("../parsers/types.js").ImportedSheet
    | import("../parsers/types.js").ImportedDeck,
): string {
  return `${objectId}:${parsed.kind}:${parsed.format.id}`;
}

function getOrStartImport(
  key: string,
  start: () => Promise<ConvertedTarget>,
): Promise<ConvertedTarget> {
  const current = inFlightImports.get(key);
  if (current !== undefined) {
    return current;
  }
  const next = start().finally(() => {
    window.setTimeout(() => {
      if (inFlightImports.get(key) === next) {
        inFlightImports.delete(key);
      }
    }, 5_000);
  });
  inFlightImports.set(key, next);
  return next;
}

function universalEditorInFlightImports(): Map<string, Promise<ConvertedTarget>> {
  const registry = globalThis as typeof globalThis & {
    [IN_FLIGHT_IMPORTS_KEY]?: Map<string, Promise<ConvertedTarget>>;
  };
  registry[IN_FLIGHT_IMPORTS_KEY] ??= new Map<string, Promise<ConvertedTarget>>();
  return registry[IN_FLIGHT_IMPORTS_KEY];
}

function ImportDecision({
  parsed,
  objectId,
  fileName,
  nativeEditingEnabled,
}: {
  readonly parsed:
    | import("../parsers/types.js").ImportedDoc
    | import("../parsers/types.js").ImportedSheet
    | import("../parsers/types.js").ImportedDeck;
  readonly objectId: string;
  readonly fileName: string;
  readonly nativeEditingEnabled: boolean;
}) {
  const [decision, setDecision] = useState<OpenDecision>("ask");
  const canCreateCopy = nativeEditingEnabled && canCreateEditableCopy(parsed);

  if (decision === "preview") {
    switch (parsed.kind) {
      case "doc":
        return <ImportedDocumentRenderer doc={parsed} objectId={objectId} fileName={fileName} />;
      case "sheet":
        return <ImportedSheetRenderer sheet={parsed} objectId={objectId} fileName={fileName} />;
      case "deck":
        return <ImportedDeckRenderer deck={parsed} objectId={objectId} fileName={fileName} />;
    }
  }

  if (decision === "import") {
    return <ConvertAndRedirect parsed={parsed} objectId={objectId} />;
  }

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
        aria-labelledby="universal-import-title"
        style={{
          width: "min(520px, 100%)",
          border: "1px solid var(--border)",
          background: "var(--surface)",
          borderRadius: 8,
          padding: 24,
          boxShadow: "0 14px 40px rgba(15, 23, 42, 0.12)",
        }}
      >
        <div
          style={{
            color: "var(--text-caption)",
            fontSize: "var(--text-caption)",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: ".08em",
            marginBottom: 8,
          }}
        >
          {parsed.format.label}
        </div>
        <h1
          id="universal-import-title"
          style={{ margin: 0, fontSize: "var(--text-h2)", fontWeight: 650 }}
        >
          {canCreateCopy ? "Create editable copy?" : "Preview/download only"}
        </h1>
        <p style={{ color: "var(--text-2)", lineHeight: 1.55, marginTop: 12 }}>
          {canCreateCopy ? (
            <>
              Helix can create an editable {surfaceNoun(parsed)} copy of <strong>{fileName}</strong>
              . The original upload stays unchanged in Drive.
            </>
          ) : nativeEditingEnabled ? (
            <>
              Helix can preview <strong>{fileName}</strong>, but{" "}
              {editableCopyUnavailableMessage(parsed.format)} The original upload stays unchanged in
              Drive.
            </>
          ) : (
            <>
              Editors alpha is disabled. Helix can preview <strong>{fileName}</strong> and download
              the original, but it will not create editable native copies until an admin enables
              Editors.
            </>
          )}
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 24 }}>
          <a
            className="btn"
            href={`/api/drive/objects/${objectId}/content?download=1`}
            download={fileName}
          >
            Download original
          </a>
          <button type="button" className="btn" onClick={() => setDecision("preview")}>
            Preview only
          </button>
          {canCreateCopy ? (
            <button type="button" className="btn primary" onClick={() => setDecision("import")}>
              Create copy
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function EditorsDisabledStorageOnly({ objectId }: { readonly objectId: string }) {
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
        role="status"
        style={{
          width: "min(520px, 100%)",
          border: "1px solid var(--border)",
          background: "var(--surface)",
          borderRadius: 8,
          padding: 24,
          boxShadow: "0 14px 40px rgba(15, 23, 42, 0.12)",
        }}
      >
        <div
          style={{
            display: "inline-flex",
            border: "1px solid var(--warning, #f59e0b)",
            borderRadius: 4,
            color: "var(--warning, #f59e0b)",
            fontSize: "var(--text-caption)",
            fontWeight: 700,
            lineHeight: 1,
            padding: "3px 6px",
            textTransform: "uppercase",
            marginBottom: 8,
          }}
        >
          Editors alpha disabled
        </div>
        <h1 style={{ margin: 0, fontSize: "var(--text-h2)", fontWeight: 650 }}>
          Stored in Drive
        </h1>
        <p style={{ color: "var(--text-2)", lineHeight: 1.55, marginTop: 12 }}>
          Native editing is turned off for this organization. The file remains available through
          Drive storage and sharing; admins can enable Editors alpha from Admin &gt; Core apps.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 24 }}>
          <a className="btn" href={`/api/drive/objects/${objectId}/content?download=1`}>
            Download original
          </a>
        </div>
      </section>
    </div>
  );
}

function surfaceNoun(
  parsed:
    | import("../parsers/types.js").ImportedDoc
    | import("../parsers/types.js").ImportedSheet
    | import("../parsers/types.js").ImportedDeck,
): string {
  switch (parsed.kind) {
    case "doc":
      return "document";
    case "sheet":
      return "spreadsheet";
    case "deck":
      return "presentation";
  }
}

function CenteredMessage({
  children,
  isError = false,
}: {
  readonly children: ReactNode;
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
