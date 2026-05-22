/* Live-collaboration hook for the Docs editor.

   Owns the per-document `Y.Doc`, the {@link DocsCollabProvider} (Helix Yjs
   sync WebSocket), and the Tiptap editor bound to them. The editor renders
   remote carets/selections via the Collaboration + CollaborationCaret
   extensions, driven by the provider's awareness. Falls back to a
   non-collaborative editor seeded with offline content when the document is
   not a backend document (synthetic ids, seed rows). */

import { useEffect, useMemo, useRef, useState } from "react";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import { useEditor, type Editor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import * as Y from "yjs";
import {
  DocsCollabProvider,
  collabColorFor,
  type DocsCollabPeer,
  type DocsCollabStatus,
} from "./collab-provider";

export interface CollabUser {
  readonly id: string;
  readonly name: string;
}

export interface UseCollabDocInput {
  /** Backend document id when collaborative; `null` for offline/seed docs. */
  readonly backendDocId: string | null;
  /** The signed-in user, for awareness + caret labelling. */
  readonly user: CollabUser;
  /** Offline seed body (HTML or plain text) for non-backend documents. */
  readonly fallbackContent: string;
  /** When true, the editor renders read-only (e.g. viewer role). */
  readonly editable?: boolean;
}

export interface UseCollabDocResult {
  readonly editor: Editor | null;
  /** Connection state of the Yjs sync socket; `"offline"` for seed docs. */
  readonly status: DocsCollabStatus | "offline";
  /** Remote awareness peers currently in the document. */
  readonly peers: readonly DocsCollabPeer[];
  /** True once the collaborative document has finished its initial sync. */
  readonly synced: boolean;
}

interface CollabSession {
  readonly doc: Y.Doc;
  readonly provider: DocsCollabProvider;
}

/**
 * Builds a Tiptap editor bound to a collaborative `Y.Doc` for backend
 * documents, or a plain seeded editor for offline/seed documents.
 *
 * For backend documents the provider is created synchronously alongside the
 * `Y.Doc` so the {@link CollaborationCaret} extension can bind to its
 * awareness on the editor's first render; status/peer callbacks are attached
 * in an effect so React state updates only fire while mounted.
 */
export function useCollabDoc(input: UseCollabDocInput): UseCollabDocResult {
  const { backendDocId, fallbackContent } = input;
  const editable = input.editable ?? true;
  const userId = input.user.id;
  const userName = input.user.name;

  const [status, setStatus] = useState<DocsCollabStatus | "offline">(
    backendDocId === null ? "offline" : "connecting",
  );
  const [peers, setPeers] = useState<readonly DocsCollabPeer[]>([]);
  const [synced, setSynced] = useState(backendDocId === null);

  // One Y.Doc + provider per backend document id — recreated when the doc,
  // the signed-in user, or their display name changes.
  const session = useMemo<CollabSession | null>(() => {
    if (backendDocId === null) {
      return null;
    }
    const doc = new Y.Doc();
    const provider = new DocsCollabProvider({
      docId: backendDocId,
      doc,
      user: { name: userName, color: collabColorFor(userId) },
    });
    return { doc, provider };
  }, [backendDocId, userId, userName]);

  const sessionRef = useRef<CollabSession | null>(null);
  sessionRef.current = session;

  useEffect(() => {
    if (session === null) {
      setStatus("offline");
      setSynced(true);
      setPeers([]);
      return;
    }
    setStatus(session.provider.status);
    setSynced(session.provider.status === "connected");
    setPeers([]);

    session.provider.setHandlers({
      onStatus: (next) => {
        setStatus(next);
        if (next === "connected") {
          setSynced(true);
        }
      },
      onPeers: setPeers,
    });

    return () => {
      session.provider.destroy();
      session.doc.destroy();
    };
  }, [session]);

  const extensions = useMemo(() => {
    if (session !== null) {
      // Collaborative mode: Yjs owns history, so disable StarterKit's.
      return [
        StarterKit.configure({ undoRedo: false }),
        Collaboration.configure({ document: session.doc }),
        CollaborationCaret.configure({
          provider: session.provider,
          user: { name: userName, color: collabColorFor(userId) },
        }),
      ];
    }
    return [StarterKit];
  }, [session, userId, userName]);

  const editor = useEditor(
    {
      extensions,
      editable,
      // Avoid an SSR/first-paint render before the client mounts.
      immediatelyRender: false,
      // Collaborative editors must start empty — content comes from Yjs.
      content: session === null ? fallbackContent : undefined,
      editorProps: {
        attributes: {
          class: "docs-prose",
          "aria-label": "Document body",
        },
      },
    },
    [extensions],
  );

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  return { editor, status, peers, synced };
}
