import type { TaskSummary } from "../shared/rpcTypes";
import { applyTaskPatch, type TaskPatch } from "./service";

export type TaskAction = "pause" | "resume" | "stop";

/** Builds the PATCH the web console applies for its pause/resume/stop
 * buttons. `null` means there is nothing left to change. */
export function taskActionPatch(task: TaskSummary, action: TaskAction): TaskPatch | null {
  const patch: TaskPatch = {};

  if (action === "pause") {
    if (task.live_enabled) patch.liveEnabled = false;
    if (task.backfill_status === "running") patch.backfillStatus = "paused";
  } else if (action === "resume") {
    if (task.scope !== "backfill_only" && !task.live_enabled) patch.liveEnabled = true;
    if (task.scope !== "live" && task.backfill_status !== "running" && task.backfill_status !== "complete") {
      patch.backfillStatus = "running";
    }
  } else {
    if (task.live_enabled) patch.liveEnabled = false;
    if (task.backfill_status === "running" || task.backfill_status === "paused") patch.backfillStatus = "cancelled";
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

export async function performTaskAction(
  env: Env,
  task: TaskSummary,
  action: TaskAction,
): Promise<{ ok: true; task: TaskSummary | null; label: string } | { ok: false; description: string }> {
  const patch = taskActionPatch(task, action);
  if (!patch) {
    return {
      ok: false,
      description: `Nothing to ${action} — the task is ${task.backfill_status.replace(/_/g, " ")}${
        task.live_enabled ? " with live forwarding on" : ""
      }.`,
    };
  }
  const result = await applyTaskPatch(env, task.id, patch);
  if (!result.ok) return { ok: false, description: result.description };
  return {
    ok: true,
    task: result.data,
    label: action === "pause" ? "Paused" : action === "resume" ? "Resumed" : "Stopped",
  };
}
