import { resolveLastN } from "../jobs/resolveRange";
import { TelegramClient } from "../telegram/client";
import { toResult } from "../telegram/errors";
import {
  findDuplicateTask,
  getBotWithSecrets,
  getTask,
  insertSavedTask,
  insertTask,
  updateTaskConfig,
} from "../db/queries";
import type { BackfillStatus, ErrorReason, TaskScope, TaskSummary } from "../shared/rpcTypes";

/** Evidence-based default from diagnostics testing (channel destination,
 * copyMessages): 40 and 60 messages/call completed cleanly (~590ms/message
 * sustained), 80 and 100 both hit a 429 after ~47s. 60 is the largest
 * confirmed-clean value and is what both the web console and the bot use. */
export const DEFAULT_PACING_BATCH_SIZE = 60;

export interface CreateTaskInput {
  sourceChatId: string;
  sourceChatTitle?: string | null;
  destChatId: string;
  destChatTitle?: string | null;
  scope: TaskScope;
  backfillMode?: "range" | "lastN";
  startId?: number | null;
  endId?: number | null;
  n?: number;
  pacingBatchSize?: number;
  label?: string;
  allowDuplicate?: boolean;
  saveTemplate?: boolean;
  filterMediaTypes?: string | null;
  filterMinSizeBytes?: number | null;
  filterMaxSizeBytes?: number | null;
}

export type CreateTaskResult =
  | { ok: true; data: TaskSummary | null }
  | {
      ok: false;
      errorCode: number;
      description: string;
      reason: ErrorReason;
      retryAfter?: number;
      duplicateTaskId?: string;
    };

export async function createTask(env: Env, botId: string, input: CreateTaskInput): Promise<CreateTaskResult> {
  const bot = await getBotWithSecrets(env.DB, botId);
  if (!bot) {
    return { ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" };
  }

  const duplicate = await findDuplicateTask(env.DB, botId, input.sourceChatId, input.destChatId);
  if (duplicate && !input.allowDuplicate) {
    return {
      ok: false,
      errorCode: 409,
      description: "a task with this source and destination already exists",
      reason: "invalid_request",
      duplicateTaskId: duplicate.id,
    };
  }

  const wantsBackfill = input.scope === "live_and_backfill" || input.scope === "backfill_only";
  const wantsLive = input.scope === "live" || input.scope === "live_and_backfill";

  const client = new TelegramClient(bot.token);

  return toResult(async () => {
    let startId = input.startId ?? null;
    let endId = input.endId ?? null;

    if (wantsBackfill && input.backfillMode === "lastN") {
      const resolved = await resolveLastN(client, input.sourceChatId, input.n ?? 1);
      startId = resolved.startId;
      endId = resolved.endId;
    }

    const id = crypto.randomUUID();
    const label =
      input.label ?? `${input.sourceChatTitle ?? input.sourceChatId} → ${input.destChatTitle ?? input.destChatId}`;
    const pacingBatchSize = input.pacingBatchSize ?? DEFAULT_PACING_BATCH_SIZE;

    await insertTask(env.DB, {
      id,
      bot_id: botId,
      label,
      source_chat_id: input.sourceChatId,
      source_chat_title: input.sourceChatTitle ?? null,
      dest_chat_id: input.destChatId,
      dest_chat_title: input.destChatTitle ?? null,
      scope: input.scope,
      live_enabled: wantsLive,
      backfill_mode: wantsBackfill ? (input.backfillMode ?? "range") : null,
      start_id: startId,
      end_id: endId,
      cursor: wantsBackfill ? startId : null,
      total: wantsBackfill && startId !== null && endId !== null ? endId - startId + 1 : null,
      backfill_status: wantsBackfill ? "running" : "not_applicable",
      pacing_batch_size: pacingBatchSize,
      filter_media_types: input.filterMediaTypes ?? null,
      filter_min_size_bytes: input.filterMinSizeBytes ?? null,
      filter_max_size_bytes: input.filterMaxSizeBytes ?? null,
    });

    if (input.saveTemplate) {
      // Best-effort: a saved-template write failure must not fail an
      // otherwise-successful task creation (no shared transaction here).
      try {
        await insertSavedTask(env.DB, {
          id: crypto.randomUUID(),
          task_id: id,
          bot_token: bot.token,
          bot_label: bot.label,
          bot_username: bot.bot_username,
          source_chat_id: input.sourceChatId,
          source_chat_title: input.sourceChatTitle ?? null,
          dest_chat_id: input.destChatId,
          dest_chat_title: input.destChatTitle ?? null,
          scope: input.scope,
          backfill_mode: wantsBackfill ? (input.backfillMode ?? "range") : null,
          start_id: startId,
          end_id: endId,
          n: wantsBackfill && input.backfillMode === "lastN" ? (input.n ?? null) : null,
          pacing_batch_size: pacingBatchSize,
          filter_media_types: input.filterMediaTypes ?? null,
          filter_min_size_bytes: input.filterMinSizeBytes ?? null,
          filter_max_size_bytes: input.filterMaxSizeBytes ?? null,
        });
      } catch (e) {
        console.error("saved_tasks write failed", e);
      }
    }

    return await getTask(env.DB, id);
  });
}

export interface TaskPatch {
  label?: string;
  scope?: TaskScope;
  liveEnabled?: boolean;
  backfillStatus?: BackfillStatus;
  startId?: number | null;
  endId?: number | null;
  cursor?: number | null;
  resetProgress?: boolean;
  filterMediaTypes?: string | null;
  filterMinSizeBytes?: number | null;
  filterMaxSizeBytes?: number | null;
}

export type TaskPatchResult =
  | { ok: true; data: TaskSummary | null }
  | { ok: false; errorCode: number; description: string; reason: ErrorReason };

export async function applyTaskPatch(env: Env, taskId: string, patch: TaskPatch): Promise<TaskPatchResult> {
  const currentTask = await getTask(env.DB, taskId);
  if (!currentTask) {
    return { ok: false, errorCode: 404, description: "task not found", reason: "invalid_request" };
  }

  // Resolve target scope and enablement
  const targetScope = patch.scope ?? currentTask.scope;
  let liveEnabled = patch.liveEnabled;
  let backfillStatus = patch.backfillStatus;

  if (patch.scope !== undefined) {
    if (patch.scope === "live") {
      liveEnabled = liveEnabled !== undefined ? liveEnabled : true;
      backfillStatus = "not_applicable";
    } else if (patch.scope === "backfill_only") {
      liveEnabled = false;
      if (!backfillStatus) {
        backfillStatus = currentTask.backfill_status === "not_applicable" ? "running" : currentTask.backfill_status;
      }
    } else if (patch.scope === "live_and_backfill") {
      liveEnabled = liveEnabled !== undefined ? liveEnabled : true;
      if (!backfillStatus) {
        backfillStatus = currentTask.backfill_status === "not_applicable" ? "running" : currentTask.backfill_status;
      }
    }
  }

  // Backfill bounds calculation
  let startId = patch.startId !== undefined ? patch.startId : currentTask.start_id;
  let endId = patch.endId !== undefined ? patch.endId : currentTask.end_id;
  let cursor = patch.cursor !== undefined ? patch.cursor : currentTask.cursor;
  let total = currentTask.total;

  if (targetScope !== "live") {
    if (startId !== null && endId !== null) {
      if (startId > endId) {
        return { ok: false, errorCode: 400, description: "startId cannot be greater than endId", reason: "invalid_request" };
      }
      total = endId - startId + 1;

      if (patch.resetProgress) {
        cursor = startId;
        backfillStatus = "running";
      } else {
        // If startId increased past current cursor, bump cursor to startId
        if (cursor === null || cursor < startId) {
          cursor = startId;
        }
        // If endId increased past current cursor and task was complete, resume it
        if (cursor <= endId && (currentTask.backfill_status === "complete" || backfillStatus === "complete")) {
          backfillStatus = "running";
        }
      }
    }
  }

  // Filter configuration
  let filterMediaTypes = patch.filterMediaTypes !== undefined ? patch.filterMediaTypes : currentTask.filter_media_types;
  let filterMinSizeBytes =
    patch.filterMinSizeBytes !== undefined ? patch.filterMinSizeBytes : currentTask.filter_min_size_bytes;
  let filterMaxSizeBytes =
    patch.filterMaxSizeBytes !== undefined ? patch.filterMaxSizeBytes : currentTask.filter_max_size_bytes;

  // Backfill only scope does not use filters
  if (targetScope === "backfill_only") {
    filterMediaTypes = null;
    filterMinSizeBytes = null;
    filterMaxSizeBytes = null;
  }

  await updateTaskConfig(env.DB, taskId, {
    label: patch.label,
    scope: targetScope,
    live_enabled: liveEnabled,
    backfill_status: backfillStatus,
    start_id: startId,
    end_id: endId,
    cursor,
    total,
    reset_progress: patch.resetProgress,
    filter_media_types: filterMediaTypes,
    filter_min_size_bytes: filterMinSizeBytes,
    filter_max_size_bytes: filterMaxSizeBytes,
  });

  return { ok: true, data: await getTask(env.DB, taskId) };
}
