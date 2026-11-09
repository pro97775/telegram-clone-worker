import { TelegramClient } from "../../telegram/client";
import { toResult } from "../../telegram/errors";
import { resolveLastN } from "../../jobs/resolveRange";
import { createBotRecord } from "./bots";
import {
  findDuplicateTask,
  getBotWithSecrets,
  getTask,
  getTaskWithBot,
  insertSavedTask,
  insertTask,
  listActivityLog,
  listAllTasksSummary,
  listTasksByBot,
  updateTaskConfig,
  deleteTask,
  upsertSavedChannel,
} from "../../db/queries";
import type { BackfillStatus, BatchCreateTasksResult, TaskScope, TaskSummary } from "../../shared/rpcTypes";

const NEW_BOT_SENTINEL = "new";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export async function handleListAllTasks(env: Env): Promise<Response> {
  const tasks = await listAllTasksSummary(env.DB);
  return json({ ok: true, data: tasks });
}

export async function handleListTasks(env: Env, botId: string): Promise<Response> {
  const tasks = await listTasksByBot(env.DB, botId);
  return json({ ok: true, data: tasks });
}

export async function handleGetTaskById(env: Env, taskId: string): Promise<Response> {
  const task = await getTaskWithBot(env.DB, taskId);
  if (!task) return json({ ok: false, errorCode: 404, description: "task not found", reason: "invalid_request" }, 404);
  return json({ ok: true, data: task });
}

export async function handleGetTaskActivity(env: Env, taskId: string): Promise<Response> {
  const log = await listActivityLog(env.DB, taskId);
  return json({ ok: true, data: log });
}

interface CreateTaskBody {
  botToken?: string;
  botLabel?: string;
  sourceChatId: string;
  sourceChatTitle?: string;
  destChatId: string;
  destChatTitle?: string;
  destChatType?: string;
  scope: TaskScope;
  backfillMode?: "range" | "lastN";
  startId?: number;
  endId?: number;
  n?: number;
  pacingBatchSize?: number;
  label?: string;
  allowDuplicate?: boolean;
  saveTemplate?: boolean;
  filterMediaTypes?: string | null;
  filterMinSizeBytes?: number | null;
  filterMaxSizeBytes?: number | null;
}

interface CreateBatchTasksBody {
  botToken?: string;
  botLabel?: string;
  sourceChatId: string;
  sourceChatTitle?: string;
  targets: Array<{
    destChatId: string;
    destChatTitle?: string;
    destChatType?: string;
    label?: string;
  }>;
  scope: TaskScope;
  backfillMode?: "range" | "lastN";
  startId?: number;
  endId?: number;
  n?: number;
  pacingBatchSize?: number;
  allowDuplicate?: boolean;
  saveTemplate?: boolean;
  filterMediaTypes?: string | null;
  filterMinSizeBytes?: number | null;
  filterMaxSizeBytes?: number | null;
}

const DEFAULT_PACING_BATCH_SIZE = 60;

export async function handleCreateTask(request: Request, env: Env, botId: string, origin: string): Promise<Response> {
  const body = (await request.json()) as CreateTaskBody;

  if (body.sourceChatId.trim().toLowerCase() === body.destChatId.trim().toLowerCase()) {
    return json(
      { ok: false, errorCode: 400, description: "Source and destination channel cannot be the same", reason: "invalid_request" },
      400,
    );
  }

  let resolvedBotId = botId;
  if (botId === NEW_BOT_SENTINEL) {
    if (!body.botToken) {
      return json({ ok: false, errorCode: 0, description: "botToken is required", reason: "invalid_request" }, 400);
    }
    const created = await createBotRecord(env, origin, body.botToken, body.botLabel);
    if (!created.ok) return json(created, 400);
    resolvedBotId = created.data.id;
  }

  const bot = await getBotWithSecrets(env.DB, resolvedBotId);
  if (!bot) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);

  const duplicate = await findDuplicateTask(env.DB, resolvedBotId, body.sourceChatId, body.destChatId);
  if (duplicate && !body.allowDuplicate) {
    return json(
      { ok: false, errorCode: 0, description: "a task with this source and destination already exists", reason: "invalid_request", duplicateTaskId: duplicate.id },
      409,
    );
  }

  const wantsBackfill = body.scope === "live_and_backfill" || body.scope === "backfill_only";
  const wantsLive = body.scope === "live" || body.scope === "live_and_backfill";

  const client = new TelegramClient(bot.token);

  const result = await toResult(async () => {
    let startId = body.startId ?? null;
    let endId = body.endId ?? null;

    if (wantsBackfill && body.backfillMode === "lastN") {
      const resolved = await resolveLastN(client, body.sourceChatId, body.n ?? 1);
      startId = resolved.startId;
      endId = resolved.endId;
    }

    const id = crypto.randomUUID();
    const label =
      body.label ?? `${body.sourceChatTitle ?? body.sourceChatId} → ${body.destChatTitle ?? body.destChatId}`;
    const pacingBatchSize = body.pacingBatchSize ?? DEFAULT_PACING_BATCH_SIZE;

    await insertTask(env.DB, {
      id,
      bot_id: resolvedBotId,
      label,
      source_chat_id: body.sourceChatId,
      source_chat_title: body.sourceChatTitle ?? null,
      dest_chat_id: body.destChatId,
      dest_chat_title: body.destChatTitle ?? null,
      scope: body.scope,
      live_enabled: wantsLive,
      backfill_mode: wantsBackfill ? (body.backfillMode ?? "range") : null,
      start_id: startId,
      end_id: endId,
      cursor: wantsBackfill ? startId : null,
      total: wantsBackfill && startId !== null && endId !== null ? endId - startId + 1 : null,
      backfill_status: wantsBackfill ? "running" : "not_applicable",
      pacing_batch_size: pacingBatchSize,
      filter_media_types: body.filterMediaTypes ?? null,
      filter_min_size_bytes: body.filterMinSizeBytes ?? null,
      filter_max_size_bytes: body.filterMaxSizeBytes ?? null,
    });

    try {
      await upsertSavedChannel(env.DB, {
        chat_id: body.sourceChatId,
        title: body.sourceChatTitle ?? body.sourceChatId,
        preserveCustomTitle: true,
      });
      await upsertSavedChannel(env.DB, {
        chat_id: body.destChatId,
        title: body.destChatTitle ?? body.destChatId,
        chat_type: body.destChatType ?? null,
        preserveCustomTitle: true,
      });
    } catch {
      // Non-fatal
    }

    if (body.saveTemplate) {
      try {
        await insertSavedTask(env.DB, {
          id: crypto.randomUUID(),
          task_id: id,
          bot_token: bot.token,
          bot_label: bot.label,
          bot_username: bot.bot_username,
          source_chat_id: body.sourceChatId,
          source_chat_title: body.sourceChatTitle ?? null,
          dest_chat_id: body.destChatId,
          dest_chat_title: body.destChatTitle ?? null,
          scope: body.scope,
          backfill_mode: wantsBackfill ? (body.backfillMode ?? "range") : null,
          start_id: startId,
          end_id: endId,
          n: wantsBackfill && body.backfillMode === "lastN" ? (body.n ?? null) : null,
          pacing_batch_size: pacingBatchSize,
          filter_media_types: body.filterMediaTypes ?? null,
          filter_min_size_bytes: body.filterMinSizeBytes ?? null,
          filter_max_size_bytes: body.filterMaxSizeBytes ?? null,
        });
      } catch (e) {
        console.error("saved_tasks write failed", e);
      }
    }

    return await getTask(env.DB, id);
  });

  return json(result, result.ok ? 201 : 400);
}

/** Creates multiple tasks from 1 source chat through 1 bot to many target chats at once.
 * Pre-validates duplicates across all targets before inserting so partial batches never occur!
 */
export async function handleCreateBatchTasks(
  request: Request,
  env: Env,
  botId: string,
  origin: string,
): Promise<Response> {
  const body = (await request.json()) as CreateBatchTasksBody;

  if (!Array.isArray(body.targets) || body.targets.length === 0) {
    return json(
      { ok: false, errorCode: 400, description: "At least one target channel is required", reason: "invalid_request" },
      400,
    );
  }

  let resolvedBotId = botId;
  if (botId === NEW_BOT_SENTINEL) {
    if (!body.botToken) {
      return json({ ok: false, errorCode: 0, description: "botToken is required", reason: "invalid_request" }, 400);
    }
    const created = await createBotRecord(env, origin, body.botToken, body.botLabel);
    if (!created.ok) return json(created, 400);
    resolvedBotId = created.data.id;
  }

  const bot = await getBotWithSecrets(env.DB, resolvedBotId);
  if (!bot) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);

  const wantsBackfill = body.scope === "live_and_backfill" || body.scope === "backfill_only";
  const wantsLive = body.scope === "live" || body.scope === "live_and_backfill";

  if (wantsBackfill && body.backfillMode === "range") {
    if (body.startId != null && body.endId != null && body.startId > body.endId) {
      return json(
        { ok: false, errorCode: 400, description: "startId cannot be greater than endId", reason: "invalid_request" },
        400,
      );
    }
  }

  // Deduplicate targets and reject self-loops (source == dest)
  const uniqueTargets: CreateBatchTasksBody["targets"] = [];
  const seenTargets = new Set<string>();
  const sourceNorm = body.sourceChatId.trim().toLowerCase();

  for (const target of body.targets) {
    const destId = target.destChatId?.trim();
    if (!destId) continue;
    if (destId.toLowerCase() === sourceNorm) {
      return json(
        {
          ok: false,
          errorCode: 400,
          description: `Target channel (${target.destChatTitle ?? destId}) cannot be the same as the source channel`,
          reason: "invalid_request",
        },
        400,
      );
    }
    if (seenTargets.has(destId.toLowerCase())) continue;
    seenTargets.add(destId.toLowerCase());
    uniqueTargets.push({ ...target, destChatId: destId });
  }

  if (uniqueTargets.length === 0) {
    return json(
      { ok: false, errorCode: 400, description: "No valid target channels provided", reason: "invalid_request" },
      400,
    );
  }

  // Atomic pre-check for existing duplicate tasks BEFORE running resolveLastN or inserting any rows
  if (!body.allowDuplicate) {
    const duplicates: BatchCreateTasksResult["duplicates"] = [];
    for (const target of uniqueTargets) {
      const dup = await findDuplicateTask(env.DB, resolvedBotId, body.sourceChatId, target.destChatId);
      if (dup) {
        duplicates.push({
          destChatId: target.destChatId,
          destChatTitle: target.destChatTitle,
          existingTask: dup,
        });
      }
    }
    if (duplicates.length > 0) {
      return json(
        {
          ok: true,
          data: {
            bot_id: resolvedBotId,
            created: [],
            duplicates,
            errors: [],
          } satisfies BatchCreateTasksResult,
        },
        200,
      );
    }
  }

  const client = new TelegramClient(bot.token);

  const result = await toResult(async (): Promise<BatchCreateTasksResult> => {
    let startId = body.startId ?? null;
    let endId = body.endId ?? null;

    if (wantsBackfill && body.backfillMode === "lastN") {
      const resolved = await resolveLastN(client, body.sourceChatId, body.n ?? 1);
      startId = resolved.startId;
      endId = resolved.endId;
    }

    try {
      await upsertSavedChannel(env.DB, {
        chat_id: body.sourceChatId,
        title: body.sourceChatTitle ?? body.sourceChatId,
        preserveCustomTitle: true,
      });
    } catch {
      // ignore
    }

    const created: TaskSummary[] = [];
    const errors: BatchCreateTasksResult["errors"] = [];
    const pacingBatchSize = body.pacingBatchSize ?? DEFAULT_PACING_BATCH_SIZE;

    for (const target of uniqueTargets) {
      const destId = target.destChatId;
      try {
        const id = crypto.randomUUID();
        const label =
          target.label ??
          `${body.sourceChatTitle ?? body.sourceChatId} → ${target.destChatTitle ?? destId}`;

        await insertTask(env.DB, {
          id,
          bot_id: resolvedBotId,
          label,
          source_chat_id: body.sourceChatId,
          source_chat_title: body.sourceChatTitle ?? null,
          dest_chat_id: destId,
          dest_chat_title: target.destChatTitle ?? null,
          scope: body.scope,
          live_enabled: wantsLive,
          backfill_mode: wantsBackfill ? (body.backfillMode ?? "range") : null,
          start_id: startId,
          end_id: endId,
          cursor: wantsBackfill ? startId : null,
          total: wantsBackfill && startId !== null && endId !== null ? endId - startId + 1 : null,
          backfill_status: wantsBackfill ? "running" : "not_applicable",
          pacing_batch_size: pacingBatchSize,
          filter_media_types: body.filterMediaTypes ?? null,
          filter_min_size_bytes: body.filterMinSizeBytes ?? null,
          filter_max_size_bytes: body.filterMaxSizeBytes ?? null,
        });

        try {
          await upsertSavedChannel(env.DB, {
            chat_id: destId,
            title: target.destChatTitle ?? destId,
            chat_type: target.destChatType ?? null,
            preserveCustomTitle: true,
          });
        } catch {
          // ignore
        }

        if (body.saveTemplate) {
          try {
            await insertSavedTask(env.DB, {
              id: crypto.randomUUID(),
              task_id: id,
              bot_token: bot.token,
              bot_label: bot.label,
              bot_username: bot.bot_username,
              source_chat_id: body.sourceChatId,
              source_chat_title: body.sourceChatTitle ?? null,
              dest_chat_id: destId,
              dest_chat_title: target.destChatTitle ?? null,
              scope: body.scope,
              backfill_mode: wantsBackfill ? (body.backfillMode ?? "range") : null,
              start_id: startId,
              end_id: endId,
              n: wantsBackfill && body.backfillMode === "lastN" ? (body.n ?? null) : null,
              pacing_batch_size: pacingBatchSize,
              filter_media_types: body.filterMediaTypes ?? null,
              filter_min_size_bytes: body.filterMinSizeBytes ?? null,
              filter_max_size_bytes: body.filterMaxSizeBytes ?? null,
            });
          } catch (e) {
            console.error("saved_tasks write failed", e);
          }
        }

        const taskRow = await getTask(env.DB, id);
        if (taskRow) created.push(taskRow);
      } catch (err) {
        errors.push({
          destChatId: destId,
          destChatTitle: target.destChatTitle,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      bot_id: resolvedBotId,
      created,
      duplicates: [],
      errors,
    };
  });

  return json(result, result.ok ? 201 : 400);
}

interface PatchTaskBody {
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

export async function handlePatchTask(request: Request, env: Env, taskId: string): Promise<Response> {
  const currentTask = await getTask(env.DB, taskId);
  if (!currentTask) {
    return json({ ok: false, errorCode: 404, description: "task not found", reason: "invalid_request" }, 404);
  }

  const body = (await request.json()) as PatchTaskBody;

  const targetScope = body.scope ?? currentTask.scope;
  let liveEnabled = body.liveEnabled;
  let backfillStatus = body.backfillStatus;

  if (body.scope !== undefined) {
    if (body.scope === "live") {
      liveEnabled = liveEnabled !== undefined ? liveEnabled : true;
      backfillStatus = "not_applicable";
    } else if (body.scope === "backfill_only") {
      liveEnabled = false;
      if (!backfillStatus) {
        backfillStatus = currentTask.backfill_status === "not_applicable" ? "running" : currentTask.backfill_status;
      }
    } else if (body.scope === "live_and_backfill") {
      liveEnabled = liveEnabled !== undefined ? liveEnabled : true;
      if (!backfillStatus) {
        backfillStatus = currentTask.backfill_status === "not_applicable" ? "running" : currentTask.backfill_status;
      }
    }
  }

  let startId = body.startId !== undefined ? body.startId : currentTask.start_id;
  let endId = body.endId !== undefined ? body.endId : currentTask.end_id;
  let cursor = body.cursor !== undefined ? body.cursor : currentTask.cursor;
  let total = currentTask.total;

  if (targetScope !== "live") {
    if (startId !== null && endId !== null) {
      if (startId > endId) {
        return json(
          { ok: false, errorCode: 400, description: "startId cannot be greater than endId", reason: "invalid_request" },
          400,
        );
      }
      total = endId - startId + 1;

      if (body.resetProgress) {
        cursor = startId;
        backfillStatus = "running";
      } else {
        if (cursor === null || cursor < startId) {
          cursor = startId;
        }
        if (cursor <= endId && (currentTask.backfill_status === "complete" || backfillStatus === "complete")) {
          backfillStatus = "running";
        }
      }
    }
  }

  let filterMediaTypes = body.filterMediaTypes !== undefined ? body.filterMediaTypes : currentTask.filter_media_types;
  let filterMinSizeBytes = body.filterMinSizeBytes !== undefined ? body.filterMinSizeBytes : currentTask.filter_min_size_bytes;
  let filterMaxSizeBytes = body.filterMaxSizeBytes !== undefined ? body.filterMaxSizeBytes : currentTask.filter_max_size_bytes;

  if (targetScope === "backfill_only") {
    filterMediaTypes = null;
    filterMinSizeBytes = null;
    filterMaxSizeBytes = null;
  }

  await updateTaskConfig(env.DB, taskId, {
    label: body.label,
    scope: targetScope,
    live_enabled: liveEnabled,
    backfill_status: backfillStatus,
    start_id: startId,
    end_id: endId,
    cursor,
    total,
    reset_progress: body.resetProgress,
    filter_media_types: filterMediaTypes,
    filter_min_size_bytes: filterMinSizeBytes,
    filter_max_size_bytes: filterMaxSizeBytes,
  });

  const task = await getTask(env.DB, taskId);
  return json({ ok: true, data: task });
}

export async function handleDeleteTask(env: Env, taskId: string): Promise<Response> {
  await deleteTask(env.DB, taskId);
  return json({ ok: true, data: null });
}

export async function handleTestCopy(env: Env, botId: string, taskId: string, messageId?: number): Promise<Response> {
  const bot = await getBotWithSecrets(env.DB, botId);
  const task = await getTask(env.DB, taskId);
  if (!bot || !task) return json({ ok: false, errorCode: 404, description: "not found", reason: "invalid_request" }, 404);

  const client = new TelegramClient(bot.token);
  const result = await toResult(async () => {
    let copyId = messageId;
    if (!copyId) {
      const latest = await resolveLastN(client, task.source_chat_id, 1);
      copyId = latest.endId;
    }
    return client.copyMessage(task.dest_chat_id, task.source_chat_id, copyId);
  });
  return json(result, result.ok ? 200 : 400);
}
