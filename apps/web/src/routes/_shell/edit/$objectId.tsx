/* /edit/:objectId — mounts the OnlyOffice DocumentServer editor.
 *
 * Flow:
 *   1. Route loader fetches `/api/onlyoffice/config/<objectId>` from the
 *      Helix backend. That returns a fully-signed iframe config.
 *   2. We dynamically inject `<script src="<DS>/web-apps/apps/api/documents/api.js">`
 *      once per session. The script exposes `window.DocsAPI`.
 *   3. We call `new DocsAPI.DocEditor("placeholder", config)` to mount
 *      the editor into a placeholder div.
 *   4. DS does the rest — file fetch, edit UI, co-author cursors, save
 *      callbacks — without further help from Helix beyond the JWT-signed
 *      file/callback URLs in the config.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { authenticatedFetch } from "@/lib/auth";

export const Route = createFileRoute("/_shell/edit/$objectId")({
  component: EditRoute,
});

/** DS editor server URL. In dev the SPA runs on :5180 and DS is on :28430.
 *  Override with `VITE_HELIX_ONLYOFFICE_URL` in production. */
const ONLYOFFICE_PUBLIC_URL =
  (import.meta.env.VITE_HELIX_ONLYOFFICE_URL as string | undefined) ??
  "http://localhost:28430";

const ONLYOFFICE_API_JS_PATH = "/web-apps/apps/api/documents/api.js";

interface OnlyOfficeConfig {
  readonly document: { readonly title: string; readonly fileType: string };
  readonly documentType: "word" | "cell" | "slide";
  readonly editorConfig: { readonly mode: "edit" | "view" };
  readonly token: string;
}

declare global {
  interface Window {
    DocsAPI?: {
      readonly DocEditor: new (
        placeholderId: string,
        config: Record<string, unknown>,
      ) => unknown;
    };
  }
}

function EditRoute() {
  const { objectId } = Route.useParams();
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState<string>("Loading…");

  useEffect(() => {
    let cancelled = false;
    let editor: unknown = null;

    async function bootEditor(): Promise<void> {
      const response = await authenticatedFetch(`/api/onlyoffice/config/${objectId}`);
      if (!response.ok) {
        const message = await safeErrorMessage(response);
        if (!cancelled) setError(message);
        return;
      }
      const config = (await response.json()) as OnlyOfficeConfig;
      if (cancelled) return;
      setTitle(config.document.title);

      await ensureDocsApiLoaded();
      if (cancelled) return;
      if (!window.DocsAPI || !placeholderRef.current) {
        setError("OnlyOffice editor script failed to load.");
        return;
      }

      // Give the placeholder an id so DS can mount into it. Wrapping
      // in a fresh div per mount prevents DS from re-using state across
      // route changes.
      const placeholderId = `onlyoffice-editor-${objectId}`;
      placeholderRef.current.id = placeholderId;

      try {
        editor = new window.DocsAPI.DocEditor(placeholderId, {
          ...config,
          width: "100%",
          height: "100%",
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    void bootEditor();

    return () => {
      cancelled = true;
      // OnlyOffice exposes destroyEditor() — call it so the editor
      // releases its WebSocket / autosave timers when the user
      // navigates away.
      const editorInstance = editor as { destroyEditor?: () => void } | null;
      editorInstance?.destroyEditor?.();
    };
  }, [objectId]);

  if (error !== null) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ fontSize: "var(--text-body)", fontWeight: 500, marginBottom: 8 }}>
          Couldn't open this file in the editor.
        </div>
        <div style={{ fontSize: "var(--text-body-sm)", color: "var(--text-3)", marginBottom: 16 }}>
          {error}
        </div>
        <Link to="/drive" className="btn sm">
          Back to Drive
        </Link>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "8px 16px",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      >
        <Link to="/drive" className="btn sm" style={{ marginRight: 12 }}>
          ← Drive
        </Link>
        <span className="truncate" style={{ fontSize: "var(--text-body-sm)", fontWeight: 500 }}>
          {title}
        </span>
      </div>
      <div ref={placeholderRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}

/** Inject the DocumentServer editor script tag once per session. */
let docsApiPromise: Promise<void> | null = null;
function ensureDocsApiLoaded(): Promise<void> {
  if (docsApiPromise) return docsApiPromise;
  docsApiPromise = new Promise((resolve, reject) => {
    if (window.DocsAPI) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = `${ONLYOFFICE_PUBLIC_URL}${ONLYOFFICE_API_JS_PATH}`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error(`Failed to load OnlyOffice script from ${script.src}`));
    document.head.appendChild(script);
  });
  return docsApiPromise;
}

async function safeErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { readonly error?: unknown };
    if (typeof body.error === "string") return body.error;
    if (body.error && typeof body.error === "object" && "message" in body.error) {
      return String(body.error.message);
    }
  } catch {
    // fall through
  }
  return `HTTP ${String(response.status)}`;
}
