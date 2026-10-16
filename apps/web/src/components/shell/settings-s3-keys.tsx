import { Plus } from "lucide-react";
import { AdminTable, type AdminColumn } from "@/features/admin/console/table";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  awsCliExample,
  createS3AccessKey,
  listS3AccessKeys,
  rcloneExample,
  revokeS3AccessKey,
  s3EndpointUrl,
  type S3AccessKey,
  type S3AccessKeyCreated,
  type S3KeyScope,
} from "./s3-keys-api";
import { SettingsCard, SettingsField, SettingsHeader } from "./settings-controls";

const SCOPE_LABELS: Record<S3KeyScope, string> = {
  "drive.read": "Read (list and download)",
  "drive.write": "Write (upload and copy)",
  "drive.delete": "Delete (move to trash)",
};

function formatDate(value: string | null): string {
  return value === null ? "Never" : new Date(value).toLocaleString();
}

/* ---------- S3 access keys ---------- */

export function S3KeysSection() {
  const [keys, setKeys] = useState<readonly S3AccessKey[]>([]);
  const [grantable, setGrantable] = useState<readonly S3KeyScope[] | null>(null);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<readonly S3KeyScope[]>([]);
  const [created, setCreated] = useState<S3AccessKeyCreated | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const secretRef = useRef<HTMLDivElement | null>(null);
  const labelId = useId();
  const endpoint = s3EndpointUrl(window.location.origin, created?.endpointPath);

  const load = useCallback((): void => {
    void listS3AccessKeys()
      .then((list) => {
        setKeys(list.accessKeys);
        setGrantable(list.grantableScopes);
        // A new key starts with every Drive scope the person holds, never more.
        setScopes(list.grantableScopes);
      })
      .catch((caught: unknown) => {
        setError(
          `Could not load your S3 access keys. ${caught instanceof Error ? caught.message : "Try again."}`,
        );
      });
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    if (created !== null) secretRef.current?.focus();
  }, [created]);

  async function run(operation: () => Promise<void>): Promise<void> {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await operation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The S3 key update failed.");
    } finally {
      setBusy(false);
    }
  }

  function onCreate(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void run(async () => {
      const result = await createS3AccessKey({ label: label.trim(), scopes });
      setCreated(result);
      setLabel("");
      setKeys((await listS3AccessKeys()).accessKeys);
    });
  }

  function toggleScope(scope: S3KeyScope, checked: boolean): void {
    setScopes((current) =>
      checked ? [...new Set([...current, scope])] : current.filter((entry) => entry !== scope),
    );
  }

  const columns: AdminColumn<S3AccessKey>[] = [
    { id: "name", header: "Name", sortValue: (key) => key.label, cell: (key) => key.label },
    {
      id: "id",
      header: "Access key ID",
      sortValue: (key) => key.accessKeyId,
      cell: (key) => <code>{key.accessKeyId}</code>,
    },
    {
      id: "scopes",
      header: "Scopes",
      sortValue: (key) => key.scopes.join(", "),
      cell: (key) => key.scopes.join(", "),
    },
    {
      id: "used",
      header: "Last used",
      sortValue: (key) => (key.lastUsedAt === null ? null : new Date(key.lastUsedAt).getTime()),
      cell: (key) => formatDate(key.lastUsedAt),
    },
    {
      id: "actions",
      header: "Actions",
      headerHidden: true,
      cell: (key) => (
        <button
          className="btn sm"
          type="button"
          disabled={busy}
          aria-label={`Revoke S3 access key ${key.label}`}
          onClick={() =>
            void run(async () => {
              await revokeS3AccessKey(key.id);
              setKeys((await listS3AccessKeys()).accessKeys);
              setMessage(`Revoked ${key.label}.`);
            })
          }
        >
          Revoke
        </button>
      ),
    },
  ];

  return (
    <>
      <SettingsHeader
        title="S3 access keys"
        description="Use Drive from aws, rclone, boto3, and other S3 clients. Keys act as you, limited to the scopes you choose; uploads are malware-scanned like any Drive upload."
      />
      <SettingsCard title="Access keys">
        <SettingsField label="Endpoint" hint="Path-style addressing; region us-east-1">
          <code className="block break-all">{endpoint}</code>
          <div className="type-caption text-muted-foreground mt-1">
            Buckets: <code>my-drive</code> (your files) and <code>shared-with-me</code>.
          </div>
        </SettingsField>
        <SettingsField label="New key" controlId={labelId} hint="Name it after the device or tool">
          <form onSubmit={onCreate} className="grid gap-2">
            <input
              id={labelId}
              name="label"
              className="input"
              value={label}
              maxLength={120}
              required
              onChange={(event) => setLabel(event.target.value)}
            />
            <fieldset className="grid gap-1 border-0 p-0 m-0">
              <legend className="type-body-sm font-medium mb-1">Scopes</legend>
              {grantable !== null && grantable.length === 0 ? (
                <p className="type-body-sm text-muted-foreground m-0">
                  You have no Drive access an S3 key can use. Ask an administrator for Drive access.
                </p>
              ) : null}
              {(grantable ?? []).map((scope) => (
                <label key={scope} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="scopes"
                    value={scope}
                    checked={scopes.includes(scope)}
                    onChange={(event) => toggleScope(scope, event.target.checked)}
                  />
                  {SCOPE_LABELS[scope]}
                </label>
              ))}
            </fieldset>
            <div>
              <button
                className="btn sm primary"
                type="submit"
                disabled={busy || label.trim().length === 0 || scopes.length === 0}
              >
                <Plus size={14} aria-hidden="true" /> Add access key
              </button>
            </div>
          </form>
        </SettingsField>
        {created === null ? null : (
          <div
            ref={secretRef}
            tabIndex={-1}
            role="region"
            aria-label="New S3 access key"
            className="[border:1px_solid_var(--border)] rounded-md p-3 my-3 grid gap-2"
          >
            <strong>Copy the secret now — it is not shown again.</strong>
            <div>
              Access key ID: <code>{created.accessKey.accessKeyId}</code>
            </div>
            <div>
              Secret access key: <code className="break-all">{created.secretAccessKey}</code>
            </div>
            <label className="grid gap-1">
              aws CLI
              <textarea
                className="input font-mono"
                readOnly
                rows={3}
                value={awsCliExample(endpoint)}
              />
            </label>
            <label className="grid gap-1">
              rclone.conf
              <textarea
                className="input font-mono"
                readOnly
                rows={8}
                value={rcloneExample(endpoint, created.accessKey.accessKeyId)}
              />
            </label>
            <div>
              <button className="btn sm" type="button" onClick={() => setCreated(null)}>
                I saved the secret
              </button>
            </div>
          </div>
        )}
        <SettingsField label="Your keys" hint="Revoking a key stops it immediately">
          {keys.length === 0 ? (
            <div className="text-muted-foreground">No S3 access keys yet.</div>
          ) : (
            <AdminTable
              label="Your S3 access keys"
              columns={columns}
              rows={keys}
              rowKey={(key) => key.id}
              searchText={(key) => [key.label, key.accessKeyId, key.scopes.join(" ")].join(" ")}
            />
          )}
        </SettingsField>
      </SettingsCard>
      {message === null ? null : <div role="status">{message}</div>}
      {error === null ? null : <div role="alert">{error}</div>}
    </>
  );
}
