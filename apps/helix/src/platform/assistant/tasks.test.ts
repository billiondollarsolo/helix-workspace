import { describe, expect, it } from "vitest";
import { createTasks, tasksFromMetadata, updateTask } from "./tasks.js";

describe("conversation tasks", () => {
  it("creates and updates a conversation checklist", () => {
    const created = createTasks({}, ["Search forecast", "Fetch weather.gov"]);
    expect(created.tasks).toHaveLength(2);
    expect(tasksFromMetadata(created.metadata)).toHaveLength(2);
    const first = created.tasks[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const updated = updateTask(created.metadata, first.id, "completed");
    expect(updated.tasks[0]?.status).toBe("completed");
    expect(updated.tasks[1]?.status).toBe("pending");
  });
});
