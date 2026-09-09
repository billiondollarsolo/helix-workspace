import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createDriveWorkflow,
  transitionDriveWorkflow,
  type DriveWorkflow,
  type DriveWorkflowKind,
} from "./api";
import { driveQueryKeys, driveWorkflowsQueryOptions } from "./queries";

export function DriveWorkflows(props: {
  readonly resourceId: string;
  readonly resourceType: "object" | "folder";
}) {
  const client = useQueryClient();
  const [kind, setKind] = useState<DriveWorkflowKind>("shortcut");
  const [assignee, setAssignee] = useState("");
  const [note, setNote] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [resultObjectId, setResultObjectId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const workflows = useQuery(driveWorkflowsQueryOptions(loaded));
  const refresh = () => client.invalidateQueries({ queryKey: driveQueryKeys.workflows });
  const create = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: () =>
      createDriveWorkflow({
        kind,
        resourceType: props.resourceType,
        resourceId: props.resourceId,
        ...(assignee.trim().length === 0 ? {} : { assignedToActorRef: assignee.trim() }),
        ...(dueAt.length === 0 ? {} : { dueAt: new Date(dueAt).toISOString() }),
        payload:
          kind === "classification"
            ? { classification: note || "standard" }
            : { reason: note, name: note },
      }),
    onSuccess: () => {
      setNote("");
      setLoaded(true);
      void refresh();
    },
  });
  const transition = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (input: {
      readonly workflow: DriveWorkflow;
      readonly state: "approved" | "rejected" | "cancelled" | "completed";
    }) =>
      transitionDriveWorkflow(
        input.workflow,
        input.state,
        input.workflow.kind === "file_request" && input.state === "completed"
          ? { objectId: resultObjectId.trim() }
          : {},
      ),
    onSuccess: () => void refresh(),
  });
  const relevant = workflows.data ?? [];
  const error = create.error ?? transition.error ?? workflows.error;

  return (
    <section aria-label="Drive workflows" style={{ marginTop: 16 }}>
      <div className="section-label" style={{ padding: "0 0 6px" }}>
        Workflows
      </div>
      <label style={labelStyle}>
        Action
        <select
          className="input"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as DriveWorkflowKind);
          }}
        >
          <option value="shortcut">Create shortcut</option>
          {props.resourceType === "folder" ? (
            <option value="file_request">Request a file</option>
          ) : null}
          <option value="approval">Request approval</option>
          {props.resourceType === "object" ? (
            <option value="ownership_transfer">Transfer ownership</option>
          ) : null}
          {props.resourceType === "folder" ? (
            <option value="shared_drive">Convert to shared drive</option>
          ) : null}
          <option value="classification">Set classification</option>
          <option value="hold">Place retention hold</option>
          <option value="investigation">Open investigation</option>
        </select>
      </label>
      <label style={labelStyle}>
        Due date (optional)
        <input
          className="input"
          type="datetime-local"
          value={dueAt}
          onChange={(event) => {
            setDueAt(event.target.value);
          }}
        />
      </label>
      {relevant.some(
        (workflow) => workflow.kind === "file_request" && workflow.state === "open",
      ) ? (
        <label style={labelStyle}>
          Uploaded object ID (to complete a file request)
          <input
            className="input"
            value={resultObjectId}
            onChange={(event) => {
              setResultObjectId(event.target.value);
            }}
            autoComplete="off"
          />
        </label>
      ) : null}
      <label style={labelStyle}>
        Assignee email or name (when required)
        <input
          className="input"
          value={assignee}
          onChange={(event) => {
            setAssignee(event.target.value);
          }}
          autoComplete="off"
        />
      </label>
      <label style={labelStyle}>
        {kind === "classification" ? "Classification" : "Name or reason"}
        {kind === "classification" ? (
          <select
            className="input"
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          >
            <option value="standard">Standard</option>
            <option value="public">Public</option>
            <option value="confidential">Confidential</option>
            <option value="restricted">Restricted</option>
          </select>
        ) : (
          <input
            className="input"
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        )}
      </label>
      <button
        type="button"
        className="btn sm"
        disabled={create.isPending}
        onClick={() => {
          create.mutate();
        }}
      >
        {create.isPending ? "Creating…" : "Create workflow"}
      </button>
      <button
        type="button"
        className="btn sm"
        style={{ marginLeft: 4 }}
        disabled={workflows.isFetching}
        onClick={() => {
          setLoaded(true);
        }}
      >
        {workflows.isFetching ? "Loading…" : "Load workflows"}
      </button>
      {error instanceof Error ? (
        <p
          role="alert"
          style={{ color: "var(--danger, #dc2626)", fontSize: "var(--text-caption)" }}
        >
          {error.message}
        </p>
      ) : null}
      <ul aria-live="polite" style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
        {relevant.map((workflow) => (
          <li key={workflow.id} style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
            <div style={{ fontSize: "var(--text-meta)" }}>
              {workflow.kind.replaceAll("_", " ")} · {workflow.state}
            </div>
            <a
              className="btn sm"
              href={
                workflow.resourceType === "folder"
                  ? `/drive?folder=${encodeURIComponent(workflow.resourceId)}`
                  : `/drive?file=${encodeURIComponent(workflow.resourceId)}`
              }
              style={{ display: "inline-flex", marginTop: 4 }}
            >
              Open target
            </a>
            {workflow.state === "open" ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                {workflowActions(workflow).map((state) => (
                  <button
                    key={state}
                    type="button"
                    className="btn sm"
                    disabled={transition.isPending}
                    onClick={() => {
                      transition.mutate({ workflow, state });
                    }}
                  >
                    {state}
                  </button>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

const labelStyle = {
  display: "grid",
  gap: 4,
  marginBottom: 6,
  fontSize: "var(--text-caption)",
} as const;

function workflowActions(
  workflow: DriveWorkflow,
): readonly ("approved" | "rejected" | "cancelled" | "completed")[] {
  return workflow.kind === "approval" || workflow.kind === "ownership_transfer"
    ? ["approved", "rejected", "cancelled"]
    : ["completed", "rejected", "cancelled"];
}
