import { TelegramClient } from "../../telegram/client";
import { toResult } from "../../telegram/errors";
import { resolveLastN } from "../../jobs/resolveRange";
import { createBotRecord } from "./bots";
import {
  getBotWithSecrets,
  getTask,
  getTaskWithBot,
  listActivityLog,
  listAllTasksSummary,
  listTasksByBot,
  deleteTask,
} from "../../db/queries";
import { applyTaskPatch, createTask, type CreateTaskInput, type TaskPatch } from "../../tasks/service";

/** Sentinel path segment for POST /api/bots/:botId/tasks meaning "the bot
 * behind this task hasn't been saved yet — create it from botToken first."
 * Keeps the wizard from ever persisting a token before a task exists. */
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

interface CreateTaskBody extends CreateTaskInput {
  botToken?: string;
  botLabel?: string;
}

export async function handleCreateTask(request: Request, env: Env, botId: string, origin: string): Promise<Response> {
  const body = (await request.json()) as CreateTaskBody;

  let resolvedBotId = botId;
  if (botId === NEW_BOT_SENTINEL) {
    if (!body.botToken) {
      return json({ ok: false, errorCode: 0, description: "botToken is required", reason: "invalid_request" }, 400);
    }
    const created = await createBotRecord(env, origin, body.botToken, body.botLabel);
    if (!created.ok) return json(created, 400);
    resolvedBotId = created.data.id;
  }

  const result = await createTask(env, resolvedBotId, body);
  return json(result, result.ok ? 201 : result.errorCode === 409 ? 409 : 400);
}

export async function handlePatchTask(request: Request, env: Env, taskId: string): Promise<Response> {
  const body = (await request.json()) as TaskPatch;
  const result = await applyTaskPatch(env, taskId, body);
  return json(result, result.ok ? 200 : result.errorCode === 404 ? 404 : 400);
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
