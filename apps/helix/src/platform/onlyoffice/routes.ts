/* OnlyOffice DocumentServer integration routes.
 *
 * Three endpoints, all mounted under /api/onlyoffice/:
 *
 *   GET  /api/onlyoffice/config/:objectId
 *        Returns a signed iframe config the SPA hands to
 *        `new DocsAPI.DocEditor(...)`. Configures file URL, callback URL,
 *        permissions, and the JWT-signed envelope DS verifies. Session-
 *        cookie auth — the user must have read access on the object.
 *
 *   GET  /api/onlyoffice/file/:token
 *        Streams the file content to DS. Token-authenticated: DS isn't
 *        logged in, so it carries a JWT that we issued in the config
 *        step. Token embeds the actorId so the ACL check is identical
 *        to a normal cookie-authed read.
 *
 *   POST /api/onlyoffice/callback/:token
 *        Receives DS save events (status 2 = "saved", status 6/7 =
 *        "force-saved mid-edit"). Same token auth as the file route.
 *        On save we fetch the URL DS provides, base64-encode the bytes
 *        into objects.metadata.inlineBody (matching the dev seed
 *        affordance), and bump sha256 / byte_size.
 *
 * Spec ref: https://api.onlyoffice.com/editors/callback
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import type { Actor } from "@helix/sdk-types";
import type { WebDavDriveStore } from "../drive/routes.js";
import {
  signOnlyOfficeJwt,
  verifyOnlyOfficeJwt,
  verifyOnlyOfficeSignatureOnly,
} from "./jwt.js";

export interface OnlyOfficeRouteOptions {
  readonly store: WebDavDriveStore;
  readonly sql: postgres.Sql;
  /** HS256 secret shared with DocumentServer (env ONLYOFFICE_JWT_SECRET). */
  readonly jwtSecret: string;
  /** URL DS uses to fetch files / post callbacks. Must be reachable from
   *  inside the DS container — typically `http://helix:3000` when DS and
   *  Helix share a docker network, or `http://host.docker.internal:3000`
   *  in dev when Helix runs on the host. */
  readonly helixInternalUrl: string;
  /** Resolves the request actor via session cookies, used by /config. */
  readonly resolveActor: (request: FastifyRequest) => Promise<Actor>;
}

/** DS save event payload (subset we care about). Full schema:
 *  https://api.onlyoffice.com/editors/callback */
interface OnlyOfficeCallback {
  /** 0=editing, 1=ready, 2=saved, 3=save-error, 4=closed-without-change, 6=force-saved, 7=force-save-error. */
  readonly status: number;
  /** URL where the new file content can be downloaded from DS. Only
   *  present for status 2/6/7. */
  readonly url?: string;
  /** Per-edit-session token DS uses to namespace changes. */
  readonly key?: string;
  /** Token signed with our secret — DS sends it back so we can verify
   *  the callback originated from a session we issued. */
  readonly token?: string;
}

export async function registerOnlyOfficeRoutes(
  app: FastifyInstance,
  options: OnlyOfficeRouteOptions,
): Promise<void> {
  // --------------------------------------------------------------
  // GET /api/onlyoffice/config/:objectId — session-authed
  // --------------------------------------------------------------
  app.get<{ Params: { objectId: string } }>(
    "/api/onlyoffice/config/:objectId",
    async (request, reply) => {
      const actor = await options.resolveActor(request);
      if (actor.id === "anonymous") {
        return reply.code(401).send({ error: "Authentication required." });
      }
      const file = await options.store.readFile({
        orgId: actor.orgId,
        actorId: actor.id,
        objectId: request.params.objectId,
      });
      if (file === null) {
        return reply.code(404).send({ error: "File not found." });
      }
      const filename = file.entry.name ?? `${request.params.objectId}.docx`;
      const documentType = documentTypeForName(filename);
      if (documentType === null) {
        return reply.code(400).send({
          error:
            "OnlyOffice doesn't natively render this file type. Use the inline /preview endpoint instead.",
        });
      }

      // Token covers BOTH the file-fetch URL and the callback. Same actor,
      // same object — DS calls them in close succession during a session.
      const now = Math.floor(Date.now() / 1000);
      const exp = now + 60 * 60; // 1 hour — matches typical doc-session window
      const fileToken = signOnlyOfficeJwt(
        {
          objectId: request.params.objectId,
          actorId: actor.id,
          orgId: actor.orgId,
          userDisplayName: actor.displayName ?? actor.email ?? "Helix user",
          iat: now,
          exp,
        },
        options.jwtSecret,
      );

      // DS requires `document.key` to be alphanumeric / hyphen / underscore,
      // ≤128 chars. Date strings from postgres come back with spaces,
      // colons, commas, and parens that silently break the editor (it
      // opens the iframe shell but never loads the document). Strip to a
      // safe charset; the timestamp is just to invalidate cache when the
      // file changes, so a sanitized form preserves the semantic.
      const updatedAtRaw = String(file.entry.updatedAt ?? file.entry.createdAt ?? "");
      const updatedAtSafe = updatedAtRaw.replace(/[^A-Za-z0-9]/g, "").slice(0, 64);
      const documentKey = `${request.params.objectId}-${updatedAtSafe}`.slice(0, 128);
      const documentUrl = `${options.helixInternalUrl}/api/onlyoffice/file/${fileToken}`;
      const callbackUrl = `${options.helixInternalUrl}/api/onlyoffice/callback/${fileToken}`;

      // Project the Helix permission grant into the OnlyOffice
      // permissions schema. Four cases:
      //   owner / editor → edit mode + full write/comment/review
      //   commenter      → edit mode but write disabled; comment+review on
      //                    (matches Google Docs "Can comment" UX)
      //   viewer (or no grant beyond folder visibility) → view mode
      const accessRole = await resolveAccessRole(options.sql, request.params.objectId, actor.id);
      const writePermission = accessRole === "owner" || accessRole === "editor";
      const commentPermission = writePermission || accessRole === "commenter";
      const mode: "edit" | "view" =
        accessRole === "owner" || accessRole === "editor" || accessRole === "commenter"
          ? "edit"
          : "view";

      // The OnlyOffice config IS the JWT payload in the iframe contract —
      // DS verifies the top-level `token` field matches the body it
      // signs the same way. We re-sign with the same secret.
      const editorPayload = {
        document: {
          fileType: extensionForName(filename),
          key: documentKey,
          title: filename,
          url: documentUrl,
          permissions: {
            comment: commentPermission,
            download: true,
            edit: writePermission,
            print: true,
            review: commentPermission,
          },
        },
        documentType,
        editorConfig: {
          callbackUrl,
          lang: "en",
          mode,
          user: {
            id: actor.id,
            name: actor.displayName ?? actor.email ?? "Helix user",
          },
          customization: { autosave: true, forcesave: true },
        },
      } as const;

      const editorToken = signOnlyOfficeJwt(
        // DS expects the JWT to wrap the same shape as the body. Pad
        // with iat/exp/objectId/actorId so verifyOnlyOfficeJwt is happy
        // when the same token arrives back on the callback.
        {
          ...editorPayload,
          objectId: request.params.objectId,
          actorId: actor.id,
          orgId: actor.orgId,
          userDisplayName: actor.displayName ?? actor.email ?? "Helix user",
          iat: now,
          exp,
        },
        options.jwtSecret,
      );

      return reply.send({ ...editorPayload, token: editorToken });
    },
  );

  // --------------------------------------------------------------
  // GET /api/onlyoffice/file/:token — DS streams content from here
  // --------------------------------------------------------------
  app.get<{ Params: { token: string } }>(
    "/api/onlyoffice/file/:token",
    async (request, reply) => {
      const verified = verifyOnlyOfficeJwt(request.params.token, options.jwtSecret);
      if (!verified.ok) {
        return reply.code(401).send({ error: `Invalid token: ${verified.reason}` });
      }
      const { payload } = verified;
      const file = await options.store.readFile({
        orgId: payload.orgId,
        actorId: payload.actorId,
        objectId: payload.objectId,
      });
      if (file === null) {
        return reply.code(404).send({ error: "File not found." });
      }
      const bytes =
        file.content !== null
          ? Buffer.from(file.content)
          : extractInlineBody(file.entry.metadata);
      if (bytes === null) {
        return reply.code(404).send({ error: "File content unavailable." });
      }
      return reply
        .header(
          "content-disposition",
          `inline; filename*=UTF-8''${encodeURIComponent(file.entry.name ?? payload.objectId)}`,
        )
        .header("content-length", String(bytes.byteLength))
        .type(file.entry.mimeType ?? "application/octet-stream")
        .send(bytes);
    },
  );

  // --------------------------------------------------------------
  // POST /api/onlyoffice/callback/:token — DS posts save events
  // --------------------------------------------------------------
  app.post<{ Params: { token: string }; Body: OnlyOfficeCallback }>(
    "/api/onlyoffice/callback/:token",
    async (request, reply) => {
      const verified = verifyOnlyOfficeJwt(request.params.token, options.jwtSecret);
      if (!verified.ok) {
        return reply.code(401).send({ error: `Invalid token: ${verified.reason}` });
      }
      const { payload } = verified;
      const body = request.body ?? ({ status: 0 } as OnlyOfficeCallback);

      // DS signs its callback body in `body.token`. The body JWT has a
      // DS-specific payload shape (`{ key, status, users, actions }`) —
      // it does NOT carry Helix's objectId/actorId/orgId. So we use the
      // signature-only verifier here: a valid signature proves the body
      // came from a party that knows the shared secret, which is the
      // security property we need. (Original verifyOnlyOfficeJwt is
      // strict-by-design for our URL tokens.)
      if (typeof body.token === "string" && body.token.length > 0) {
        const innerCheck = verifyOnlyOfficeSignatureOnly(body.token, options.jwtSecret);
        if (!innerCheck.ok) {
          return reply.code(401).send({ error: `Body token invalid: ${innerCheck.reason}` });
        }
      }

      // Only persist on terminal save statuses.
      const isSave = body.status === 2 || body.status === 6;
      if (!isSave || typeof body.url !== "string") {
        // Status 1 (ready), 4 (closed-no-change), etc — acknowledge.
        return reply.send({ error: 0 });
      }

      const fetched = await fetch(body.url);
      if (!fetched.ok) {
        request.log.error(
          { ds_status: body.status, status: fetched.status },
          "OnlyOffice save fetch failed",
        );
        return reply.send({ error: 1 });
      }
      const buf = Buffer.from(await fetched.arrayBuffer());

      // Persist back into objects. We update mime + sha256 + byte_size +
      // metadata.inlineBody (so the read path keeps working in dev where
      // RustFS is bypassed; in prod we'd also write the new blob to
      // RustFS via the storage client).
      const { createHash } = await import("node:crypto");
      const sha = createHash("sha256").update(buf).digest("hex");
      await options.sql`
        update objects
        set byte_size = ${buf.byteLength},
            sha256 = ${sha},
            metadata = metadata || ${options.sql.json({
              inlineBody: buf.toString("base64"),
            })},
            updated_at = now()
        where id = ${payload.objectId} and org_id = ${payload.orgId}
      `;
      request.log.info(
        { objectId: payload.objectId, bytes: buf.byteLength, sha: sha.slice(0, 12) },
        "OnlyOffice save persisted",
      );
      return reply.send({ error: 0 });
    },
  );
}

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

/** OnlyOffice classifies docs into three "documentType" buckets. Map
 *  from a filename or extension to the right bucket; return null when
 *  the file isn't natively supported (PDF, ZIP, image, etc.). */
function documentTypeForName(name: string): "word" | "cell" | "slide" | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".docx") || lower.endsWith(".doc") || lower.endsWith(".odt") || lower.endsWith(".rtf") || lower.endsWith(".txt")) {
    return "word";
  }
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".ods") || lower.endsWith(".csv")) {
    return "cell";
  }
  if (lower.endsWith(".pptx") || lower.endsWith(".ppt") || lower.endsWith(".odp")) {
    return "slide";
  }
  return null;
}

function extensionForName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "docx" : name.slice(dot + 1).toLowerCase();
}

function extractInlineBody(metadata: unknown): Buffer | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const inline = (metadata as { inlineBody?: unknown }).inlineBody;
  if (typeof inline !== "string") return null;
  return Buffer.from(inline, "base64");
}

type AccessRole = "owner" | "editor" | "commenter" | "viewer" | "none";

/** Resolve the actor's effective access role on this object.
 *
 *  Priority:
 *   1. `objects.owner_actor_id = actor.id` → "owner". Direct ownership
 *      always wins (and is the only signal the workspace-seed sets for
 *      legacy doc/sheet/deck creation, which doesn't write an
 *      `object`-type grant in the permissions table).
 *   2. Explicit grant in `permissions(resource_type='object', resource_id, actor)`
 *      — role is taken as-is. Corpus seed and `drive.share` use this path
 *      and now emit owner/editor/commenter/viewer with full variety.
 *   3. No grant → "none". */
async function resolveAccessRole(
  sql: postgres.Sql,
  objectId: string,
  actorId: string,
): Promise<AccessRole> {
  const ownerRows = (await sql`
    select 1 from objects
    where id = ${objectId} and owner_actor_id = ${actorId}
    limit 1
  `) as unknown as readonly unknown[];
  if (ownerRows.length > 0) return "owner";

  const permissionRows = (await sql`
    select role from permissions
    where resource_type = 'object'
      and resource_id = ${objectId}
      and actor_id = ${actorId}
    limit 1
  `) as unknown as readonly { readonly role: string }[];
  if (permissionRows.length === 0) return "none";
  const role = permissionRows[0]!.role;
  if (role === "owner" || role === "editor" || role === "commenter" || role === "viewer") {
    return role;
  }
  // Unknown roles (e.g. "member") default to viewer — better to err on
  // the side of read-only than silently grant write.
  return "viewer";
}
