import { findBotByTokenOrBotId, getSavedTask } from "../db/queries";
import { createBotRecord } from "../routes/api/bots";
import { createTask, type CreateTaskResult } from "./service";

/** Recreates a task from a saved template, reconnecting its bot when the
 * template survived the bot row. Shared by the text command and the buttons. */
export async function startTaskFromSaved(env: Env, savedId: string): Promise<CreateTaskResult> {
  const saved = await getSavedTask(env.DB, savedId);
  if (!saved) {
    return { ok: false, errorCode: 404, description: "saved template not found", reason: "invalid_request" };
  }

  let bot = await findBotByTokenOrBotId(env.DB, saved.bot_token);
  if (!bot) {
    const created = await createBotRecord(env, "", saved.bot_token, saved.bot_label);
    if (!created.ok) return created;
    bot = await findBotByTokenOrBotId(env.DB, saved.bot_token);
  }
  if (!bot) {
    return { ok: false, errorCode: 0, description: "could not resolve the template's bot", reason: "unknown" };
  }

  return createTask(env, bot.id, {
    sourceChatId: saved.source_chat_id,
    sourceChatTitle: saved.source_chat_title,
    destChatId: saved.dest_chat_id,
    destChatTitle: saved.dest_chat_title,
    scope: saved.scope,
    backfillMode: saved.backfill_mode ?? undefined,
    startId: saved.backfill_mode === "range" ? saved.start_id : undefined,
    endId: saved.backfill_mode === "range" ? saved.end_id : undefined,
    n: saved.backfill_mode === "lastN" ? (saved.n ?? undefined) : undefined,
    pacingBatchSize: saved.pacing_batch_size,
    filterMediaTypes: saved.filter_media_types,
    filterMinSizeBytes: saved.filter_min_size_bytes,
    filterMaxSizeBytes: saved.filter_max_size_bytes,
  });
}
