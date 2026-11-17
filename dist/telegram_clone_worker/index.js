class TelegramApiError extends Error {
  errorCode;
  reason;
  retryAfter;
  constructor(body) {
    super(body.description);
    this.name = "TelegramApiError";
    this.errorCode = body.error_code;
    this.retryAfter = body.parameters?.retry_after;
    this.reason = classify(body);
  }
}
function classify(body) {
  const desc = body.description.toLowerCase();
  if (body.error_code === 429 || desc.includes("too many requests")) return "rate_limited";
  if (body.error_code === 401) return "unauthorized";
  if (body.error_code === 403 || desc.includes("bot was kicked") || desc.includes("bot is not a member")) {
    return "bot_not_in_chat";
  }
  if (desc.includes("not enough rights") || desc.includes("chat_admin_required") || desc.includes("have no rights") || desc.includes("can't remove chat owner") || desc.includes("user_not_participant")) {
    return "insufficient_permissions";
  }
  if (body.error_code === 400) return "invalid_request";
  return "unknown";
}
function errFromTelegram(e) {
  if (e instanceof TelegramApiError) {
    return {
      ok: false,
      errorCode: e.errorCode,
      description: e.message,
      reason: e.reason,
      retryAfter: e.retryAfter
    };
  }
  return {
    ok: false,
    errorCode: 0,
    description: e instanceof Error ? e.message : String(e),
    reason: "unknown"
  };
}
async function toResult(fn) {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (e) {
    return errFromTelegram(e);
  }
}
const API_ROOT = "https://api.telegram.org";
class TelegramClient {
  constructor(token) {
    this.token = token;
  }
  async call(method, params = {}) {
    const url = `${API_ROOT}/bot${this.token}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params)
    });
    const body = await res.json();
    if (!body.ok) throw new TelegramApiError(body);
    return body.result;
  }
  getMe() {
    return this.call("getMe");
  }
  setWebhook(url, secretToken) {
    return this.call("setWebhook", {
      url,
      secret_token: secretToken,
      max_connections: 40,
      allowed_updates: ["message", "channel_post"]
    });
  }
  deleteWebhook(dropPendingUpdates = false) {
    return this.call("deleteWebhook", { drop_pending_updates: dropPendingUpdates });
  }
  getWebhookInfo() {
    return this.call("getWebhookInfo");
  }
  getUpdates(params = {}) {
    return this.call("getUpdates", params);
  }
  getChat(chatId) {
    return this.call("getChat", { chat_id: chatId });
  }
  getChatMemberCount(chatId) {
    return this.call("getChatMemberCount", { chat_id: chatId });
  }
  getChatMember(chatId, userId) {
    return this.call("getChatMember", { chat_id: chatId, user_id: userId });
  }
  getChatAdministrators(chatId) {
    return this.call("getChatAdministrators", { chat_id: chatId });
  }
  createChatInviteLink(chatId, name) {
    return this.call("createChatInviteLink", { chat_id: chatId, name });
  }
  revokeChatInviteLink(chatId, inviteLink2) {
    return this.call("revokeChatInviteLink", { chat_id: chatId, invite_link: inviteLink2 });
  }
  exportChatInviteLink(chatId) {
    return this.call("exportChatInviteLink", { chat_id: chatId });
  }
  promoteChatMember(chatId, userId, rights) {
    return this.call("promoteChatMember", { chat_id: chatId, user_id: userId, ...rights });
  }
  banChatMember(chatId, userId) {
    return this.call("banChatMember", { chat_id: chatId, user_id: userId });
  }
  unbanChatMember(chatId, userId) {
    return this.call("unbanChatMember", { chat_id: chatId, user_id: userId, only_if_banned: true });
  }
  sendMessage(chatId, text, options = {}) {
    return this.call("sendMessage", { chat_id: chatId, text, ...options });
  }
  editMessageText(chatId, messageId, text, options = {}) {
    return this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, ...options });
  }
  answerCallbackQuery(callbackQueryId, text, showAlert = false) {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...text ? { text } : {},
      ...showAlert ? { show_alert: true } : {}
    });
  }
  setMyCommands(commands) {
    return this.call("setMyCommands", { commands });
  }
  deleteMessage(chatId, messageId) {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }
  copyMessage(destChatId, sourceChatId, messageId) {
    return this.call("copyMessage", { chat_id: destChatId, from_chat_id: sourceChatId, message_id: messageId });
  }
  copyMessages(destChatId, sourceChatId, messageIds) {
    return this.call("copyMessages", { chat_id: destChatId, from_chat_id: sourceChatId, message_ids: messageIds });
  }
}
async function insertBot(db, row) {
  await db.prepare(
    `INSERT INTO bots (id, token, bot_id, bot_username, label, webhook_secret, last_update_id) VALUES (?, ?, ?, ?, ?, ?, 0)`
  ).bind(row.id, row.token, row.bot_id, row.bot_username, row.label, row.webhook_secret).run();
}
async function listBotsSummary(db) {
  const { results } = await db.prepare(`SELECT id, bot_id, bot_username, label, created_at FROM bots ORDER BY created_at DESC, rowid DESC`).all();
  return results;
}
async function listBotsWithSecrets(db) {
  const { results } = await db.prepare(
    `SELECT id, token, bot_id, bot_username, label, webhook_secret, last_update_id, created_at FROM bots ORDER BY created_at DESC, rowid DESC`
  ).all();
  return results;
}
async function updateBotLastUpdateId(db, botId, lastUpdateId) {
  await db.prepare(`UPDATE bots SET last_update_id = ? WHERE id = ?`).bind(lastUpdateId, botId).run();
}
async function getBotWithSecrets(db, id) {
  const row = await db.prepare(`SELECT id, token, bot_id, bot_username, label, webhook_secret, last_update_id, created_at FROM bots WHERE id = ?`).bind(id).first();
  return row ?? null;
}
async function findBotByTokenOrBotId(db, token, botTelegramId) {
  if (botTelegramId) {
    const row2 = await db.prepare(
      `SELECT id, token, bot_id, bot_username, label, webhook_secret, last_update_id, created_at FROM bots WHERE token = ? OR bot_id = ?`
    ).bind(token, botTelegramId).first();
    return row2 ?? null;
  }
  const row = await db.prepare(
    `SELECT id, token, bot_id, bot_username, label, webhook_secret, last_update_id, created_at FROM bots WHERE token = ?`
  ).bind(token).first();
  return row ?? null;
}
async function updateBotLabel(db, id, label) {
  await db.prepare(`UPDATE bots SET label = ? WHERE id = ?`).bind(label, id).run();
}
async function deleteBot(db, id) {
  await db.prepare(`DELETE FROM bots WHERE id = ?`).bind(id).run();
}
function rowToTask(row) {
  return {
    id: row.id,
    bot_id: row.bot_id,
    label: row.label,
    source_chat_id: row.source_chat_id,
    source_chat_title: row.source_chat_title ?? null,
    dest_chat_id: row.dest_chat_id,
    dest_chat_title: row.dest_chat_title ?? null,
    scope: row.scope,
    live_enabled: Boolean(row.live_enabled),
    backfill_mode: row.backfill_mode ?? null,
    start_id: row.start_id ?? null,
    end_id: row.end_id ?? null,
    cursor: row.cursor ?? null,
    total: row.total ?? null,
    processed: row.processed,
    failed: row.failed,
    live_processed: row.live_processed ?? 0,
    live_failed: row.live_failed ?? 0,
    live_skipped: row.live_skipped ?? 0,
    filter_media_types: row.filter_media_types ?? null,
    filter_min_size_bytes: row.filter_min_size_bytes ?? null,
    filter_max_size_bytes: row.filter_max_size_bytes ?? null,
    pending_count: row.pending_count != null ? Number(row.pending_count) : void 0,
    backfill_status: row.backfill_status,
    pacing_batch_size: row.pacing_batch_size,
    stop_reason: row.stop_reason ?? null,
    stopped_at: row.stopped_at ?? null,
    rate_limited_until: row.rate_limited_until ?? null,
    created_at: row.created_at
  };
}
async function insertTask(db, t) {
  await db.prepare(
    `INSERT INTO tasks (
        id, bot_id, label, source_chat_id, source_chat_title, dest_chat_id, dest_chat_title,
        scope, live_enabled, backfill_mode, start_id, end_id, cursor, total, backfill_status, pacing_batch_size,
        filter_media_types, filter_min_size_bytes, filter_max_size_bytes
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    t.id,
    t.bot_id,
    t.label,
    t.source_chat_id,
    t.source_chat_title,
    t.dest_chat_id,
    t.dest_chat_title,
    t.scope,
    t.live_enabled ? 1 : 0,
    t.backfill_mode,
    t.start_id,
    t.end_id,
    t.cursor,
    t.total,
    t.backfill_status,
    t.pacing_batch_size,
    t.filter_media_types ?? null,
    t.filter_min_size_bytes ?? null,
    t.filter_max_size_bytes ?? null
  ).run();
}
async function listTasksByBot(db, botId) {
  const { results } = await db.prepare(`SELECT * FROM tasks WHERE bot_id = ? ORDER BY created_at DESC, rowid DESC`).bind(botId).all();
  return results.map(rowToTask);
}
async function listAllTasksSummary(db) {
  const { results } = await db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC`).all();
  return results.map(rowToTask);
}
async function getTask(db, id) {
  const row = await db.prepare(`SELECT * FROM tasks WHERE id = ?`).bind(id).first();
  return row ? rowToTask(row) : null;
}
async function getTaskWithBot(db, id) {
  const row = await db.prepare(
    `SELECT tasks.*,
              COALESCE(bots.bot_username, 'unknown') as bot_username,
              (SELECT COUNT(*) FROM task_pending_messages WHERE task_id = tasks.id) as pending_count
       FROM tasks
       LEFT JOIN bots ON bots.id = tasks.bot_id
       WHERE tasks.id = ?`
  ).bind(id).first();
  if (!row) return null;
  return {
    ...rowToTask(row),
    bot_username: row.bot_username ?? "unknown"
  };
}
async function listTasksForSourceChat(db, chatIds) {
  if (chatIds.length === 0) return [];
  const placeholders = chatIds.map(() => "?").join(", ");
  const { results } = await db.prepare(
    `SELECT
         tasks.*,
         COALESCE(bots.bot_username, 'unknown') as bot_username,
         COALESCE(bots.label, 'Bot') as bot_label,
         (SELECT MAX(at) FROM task_activity_log WHERE task_id = tasks.id) AS last_activity_at
       FROM tasks
       LEFT JOIN bots ON bots.id = tasks.bot_id
       WHERE tasks.source_chat_id IN (${placeholders})
       ORDER BY tasks.created_at DESC`
  ).bind(...chatIds).all();
  return results.map((row) => {
    const task = rowToTask(row);
    const resolvedLastId = (task.cursor != null && task.cursor > 1 ? task.cursor - 1 : null) ?? task.end_id ?? null;
    return {
      ...task,
      bot_username: row.bot_username ?? "unknown",
      bot_label: row.bot_label ?? "Bot",
      last_copied_message_id: resolvedLastId,
      last_activity_at: row.last_activity_at != null ? Number(row.last_activity_at) : null
    };
  });
}
async function findDuplicateTask(db, botId, sourceChatId, destChatId) {
  const row = await db.prepare(`SELECT * FROM tasks WHERE bot_id = ? AND source_chat_id = ? AND dest_chat_id = ?`).bind(botId, sourceChatId, destChatId).first();
  return row ? rowToTask(row) : null;
}
async function listActiveSyncTasks(db) {
  const { results } = await db.prepare(
    `SELECT * FROM tasks 
       WHERE (backfill_status = 'running' OR live_enabled = 1)
       AND (rate_limited_until IS NULL OR rate_limited_until <= unixepoch())
       AND stop_reason IS NULL
       ORDER BY bot_id, created_at, id`
  ).all();
  return results.map(rowToTask);
}
async function updateTaskConfig(db, id, config) {
  const sets = [];
  const binds = [];
  if (config.label !== void 0) {
    sets.push("label = ?");
    binds.push(config.label);
  }
  if (config.scope !== void 0) {
    sets.push("scope = ?");
    binds.push(config.scope);
  }
  if (config.live_enabled !== void 0) {
    sets.push("live_enabled = ?");
    binds.push(config.live_enabled ? 1 : 0);
  }
  if (config.backfill_mode !== void 0) {
    sets.push("backfill_mode = ?");
    binds.push(config.backfill_mode);
  }
  if (config.backfill_status !== void 0) {
    sets.push("backfill_status = ?");
    binds.push(config.backfill_status);
    if (config.backfill_status === "cancelled") sets.push("stopped_at = unixepoch()");
  }
  if (config.start_id !== void 0) {
    sets.push("start_id = ?");
    binds.push(config.start_id);
  }
  if (config.end_id !== void 0) {
    sets.push("end_id = ?");
    binds.push(config.end_id);
  }
  if (config.cursor !== void 0) {
    sets.push("cursor = ?");
    binds.push(config.cursor);
  }
  if (config.total !== void 0) {
    sets.push("total = ?");
    binds.push(config.total);
  }
  if (config.reset_progress) {
    sets.push("processed = 0", "failed = 0");
  }
  if (config.filter_media_types !== void 0) {
    sets.push("filter_media_types = ?");
    binds.push(config.filter_media_types);
  }
  if (config.filter_min_size_bytes !== void 0) {
    sets.push("filter_min_size_bytes = ?");
    binds.push(config.filter_min_size_bytes);
  }
  if (config.filter_max_size_bytes !== void 0) {
    sets.push("filter_max_size_bytes = ?");
    binds.push(config.filter_max_size_bytes);
  }
  if (config.live_enabled === true || config.backfill_status === "running" || config.backfill_status === "paused") {
    sets.push("stop_reason = NULL", "stopped_at = NULL");
  }
  if (sets.length > 0) {
    binds.push(id);
    await db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  }
  if (config.clear_pending || config.scope === "backfill_only" || config.live_enabled === false) {
    await db.prepare(`DELETE FROM task_pending_messages WHERE task_id = ?`).bind(id).run();
  }
}
async function advanceTaskProgress(db, id, patch) {
  const row = await db.prepare(
    `UPDATE tasks
       SET cursor = ?,
           processed = ?,
           failed = ?,
           live_processed = COALESCE(?, live_processed),
           live_failed = COALESCE(?, live_failed),
           backfill_status = CASE
             WHEN ? = 'complete' OR (end_id IS NOT NULL AND ? > end_id) THEN 'complete'
             ELSE backfill_status
           END,
           stopped_at = CASE
             WHEN (? = 'complete' OR (end_id IS NOT NULL AND ? > end_id)) AND live_enabled = 0 THEN unixepoch()
             ELSE stopped_at
           END
       WHERE id = ?
       RETURNING backfill_status, end_id`
  ).bind(
    patch.cursor,
    patch.processed,
    patch.failed,
    patch.live_processed ?? null,
    patch.live_failed ?? null,
    patch.backfill_status ?? null,
    patch.cursor,
    patch.backfill_status ?? null,
    patch.cursor,
    id
  ).first();
  const isComplete = row?.backfill_status === "complete";
  return { backfill_status: row?.backfill_status ?? "running", complete: isComplete };
}
async function incrementLiveCounters(db, taskId, processedDelta = 1, failedDelta = 0, skippedDelta = 0) {
  await db.prepare(
    `UPDATE tasks
       SET live_processed = live_processed + ?,
           live_failed = live_failed + ?,
           live_skipped = live_skipped + ?
       WHERE id = ?`
  ).bind(processedDelta, failedDelta, skippedDelta, taskId).run();
}
async function deleteTask(db, id) {
  await db.prepare(`DELETE FROM tasks WHERE id = ?`).bind(id).run();
}
async function stopTasksForBot(db, botId, reason) {
  const { results } = await db.prepare(
    `UPDATE tasks
       SET live_enabled = 0,
           backfill_status = CASE WHEN backfill_status IN ('running','paused') THEN 'failed' ELSE backfill_status END,
           stop_reason = ?,
           stopped_at = unixepoch()
       WHERE bot_id = ?
         AND stop_reason IS NULL
         AND (live_enabled = 1 OR backfill_status IN ('running','paused'))
       RETURNING id, processed, failed`
  ).bind(reason, botId).all();
  return results;
}
async function stopTask(db, id, reason) {
  await db.prepare(
    `UPDATE tasks
       SET live_enabled = 0,
           backfill_status = CASE WHEN backfill_status IN ('running','paused') THEN 'failed' ELSE backfill_status END,
           stop_reason = ?,
           stopped_at = unixepoch()
       WHERE id = ? AND stop_reason IS NULL`
  ).bind(reason, id).run();
}
async function claimTask(db, id, leaseSeconds) {
  const row = await db.prepare(
    `UPDATE tasks
       SET lease_expires_at = unixepoch() + ?
       WHERE id = ?
         AND (backfill_status = 'running' OR live_enabled = 1)
         AND stop_reason IS NULL
         AND (lease_expires_at IS NULL OR lease_expires_at < unixepoch())
         AND (rate_limited_until IS NULL OR rate_limited_until <= unixepoch())
         AND NOT EXISTS (
           SELECT 1 FROM tasks sibling
           WHERE sibling.bot_id = tasks.bot_id
             AND sibling.id <> tasks.id
             AND sibling.lease_expires_at IS NOT NULL
             AND sibling.lease_expires_at >= unixepoch()
         )
       RETURNING *`
  ).bind(leaseSeconds, id).first();
  return row ? rowToTask(row) : null;
}
async function pauseBotForRateLimit(db, botId, until) {
  await db.prepare(
    `UPDATE tasks SET rate_limited_until = ?
       WHERE bot_id = ? AND (backfill_status = 'running' OR live_enabled = 1)`
  ).bind(until, botId).run();
}
async function getBotRateLimitStats(db, botId) {
  const now = Math.floor(Date.now() / 1e3);
  const cooldownRow = await db.prepare(
    `SELECT MAX(rate_limited_until) as max_until
       FROM tasks
       WHERE bot_id = ? AND rate_limited_until > ?`
  ).bind(botId, now).first();
  const maxUntil = cooldownRow?.max_until ?? null;
  const historyRow = await db.prepare(
    `SELECT COUNT(*) as c
       FROM task_activity_log tal
       JOIN tasks t ON t.id = tal.task_id
       WHERE t.bot_id = ? AND tal.detail LIKE '%rate limited%' AND tal.at >= ?`
  ).bind(botId, now - 86400).first();
  return {
    is_cooling_down: maxUntil !== null && maxUntil > now,
    cooldown_until: maxUntil,
    cooldown_seconds_remaining: maxUntil ? Math.max(0, maxUntil - now) : 0,
    events_last_24h: historyRow?.c ?? 0
  };
}
async function releaseTaskLease(db, id) {
  await db.prepare(`UPDATE tasks SET lease_expires_at = NULL WHERE id = ?`).bind(id).run();
}
async function appendActivityLog(db, entry) {
  await db.prepare(`INSERT INTO task_activity_log (task_id, kind, detail, ok, error) VALUES (?,?,?,?,?)`).bind(entry.task_id, entry.kind, entry.detail ?? null, entry.ok ? 1 : 0, entry.error ?? null).run();
}
async function listActivityLog(db, taskId, limit = 50) {
  const { results } = await db.prepare(`SELECT * FROM task_activity_log WHERE task_id = ? ORDER BY at DESC LIMIT ?`).bind(taskId, limit).all();
  return results;
}
const ACTIVITY_LOG_KEEP_PER_TASK = 100;
async function pruneActivityLog(db, taskId, keepLimit = ACTIVITY_LOG_KEEP_PER_TASK) {
  await db.prepare(
    `DELETE FROM task_activity_log WHERE task_id = ? AND id NOT IN (
         SELECT id FROM task_activity_log WHERE task_id = ? ORDER BY at DESC LIMIT ?
       )`
  ).bind(taskId, taskId, keepLimit).run();
}
async function insertSavedTask(db, t) {
  await db.prepare(
    `INSERT INTO saved_tasks (
        id, task_id, bot_token, bot_label, bot_username,
        source_chat_id, source_chat_title, dest_chat_id, dest_chat_title,
        scope, backfill_mode, start_id, end_id, n, pacing_batch_size,
        filter_media_types, filter_min_size_bytes, filter_max_size_bytes
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    t.id,
    t.task_id,
    t.bot_token,
    t.bot_label,
    t.bot_username,
    t.source_chat_id,
    t.source_chat_title,
    t.dest_chat_id,
    t.dest_chat_title,
    t.scope,
    t.backfill_mode,
    t.start_id,
    t.end_id,
    t.n,
    t.pacing_batch_size,
    t.filter_media_types ?? null,
    t.filter_min_size_bytes ?? null,
    t.filter_max_size_bytes ?? null
  ).run();
}
async function listSavedTasks(db) {
  const { results } = await db.prepare(
    `SELECT id, task_id, bot_label, bot_username,
              substr(bot_token, 1, 6) || '…' || substr(bot_token, -4) AS token_preview,
              source_chat_id, source_chat_title, dest_chat_id, dest_chat_title,
              scope, backfill_mode, start_id, end_id, n, pacing_batch_size,
              filter_media_types, filter_min_size_bytes, filter_max_size_bytes,
              created_at
       FROM saved_tasks ORDER BY created_at DESC, rowid DESC`
  ).all();
  return results;
}
async function getSavedTask(db, id) {
  const row = await db.prepare(
    `SELECT id, task_id, bot_token, bot_label, bot_username,
              substr(bot_token, 1, 6) || '…' || substr(bot_token, -4) AS token_preview,
              source_chat_id, source_chat_title, dest_chat_id, dest_chat_title,
              scope, backfill_mode, start_id, end_id, n, pacing_batch_size,
              filter_media_types, filter_min_size_bytes, filter_max_size_bytes,
              created_at
       FROM saved_tasks WHERE id = ?`
  ).bind(id).first();
  return row ?? null;
}
async function deleteSavedTask(db, id) {
  await db.prepare(`DELETE FROM saved_tasks WHERE id = ?`).bind(id).run();
}
async function insertPendingMessage(db, taskId, messageId, mediaType, fileSize, fileName) {
  await db.prepare(
    `INSERT INTO task_pending_messages (task_id, message_id, media_type, file_size, file_name)
       VALUES (?, ?, ?, ?, ?)`
  ).bind(taskId, messageId, mediaType ?? null, fileSize ?? null, fileName ?? null).run();
}
async function listPendingMessages(db, taskId, limit = 50) {
  const { results } = await db.prepare(`SELECT * FROM task_pending_messages WHERE task_id = ? ORDER BY id ASC LIMIT ?`).bind(taskId, limit).all();
  return results;
}
async function deletePendingMessages(db, ids) {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  await db.prepare(`DELETE FROM task_pending_messages WHERE id IN (${placeholders})`).bind(...ids).run();
}
async function listTasksWithPendingMessages(db) {
  const { results } = await db.prepare(
    `SELECT DISTINCT tasks.* FROM tasks
       JOIN task_pending_messages ON task_pending_messages.task_id = tasks.id
       WHERE (tasks.rate_limited_until IS NULL OR tasks.rate_limited_until <= unixepoch())
         AND tasks.live_enabled = 1
         AND tasks.stop_reason IS NULL
         AND tasks.backfill_status != 'running'`
  ).all();
  return results.map(rowToTask);
}
async function getAppSetting(db, key) {
  const row = await db.prepare(`SELECT value FROM app_settings WHERE key = ?`).bind(key).first();
  return row?.value ?? null;
}
async function setAppSetting(db, key, value) {
  await db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key, value).run();
}
async function deleteAppSetting(db, key) {
  await db.prepare(`DELETE FROM app_settings WHERE key = ?`).bind(key).run();
}
async function getBotControllerSession(db, chatId) {
  const row = await db.prepare(`SELECT chat_id, user_id, state, data, updated_at FROM bot_controller_sessions WHERE chat_id = ?`).bind(chatId).first();
  return row ?? null;
}
async function setBotControllerSession(db, chatId, userId, state, data) {
  await db.prepare(
    `INSERT INTO bot_controller_sessions (chat_id, user_id, state, data, updated_at)
       VALUES (?, ?, ?, ?, unixepoch())
       ON CONFLICT(chat_id) DO UPDATE SET
         user_id = excluded.user_id,
         state = excluded.state,
         data = excluded.data,
         updated_at = unixepoch()`
  ).bind(chatId, userId, state, JSON.stringify(data)).run();
}
async function clearBotControllerSession(db, chatId) {
  await db.prepare(`DELETE FROM bot_controller_sessions WHERE chat_id = ?`).bind(chatId).run();
}
async function pruneBotControllerSessions(db, maxAgeSeconds) {
  await db.prepare(`DELETE FROM bot_controller_sessions WHERE updated_at < unixepoch() - ?`).bind(maxAgeSeconds).run();
}
function extractMessageMetadata(msg) {
  if (msg.document) {
    return {
      type: "document",
      size: msg.document.file_size,
      name: msg.document.file_name,
      mimeType: msg.document.mime_type
    };
  }
  if (msg.video) {
    return {
      type: "video",
      size: msg.video.file_size,
      name: msg.video.file_name,
      mimeType: msg.video.mime_type
    };
  }
  if (msg.animation) {
    return {
      type: "animation",
      size: msg.animation.file_size,
      name: msg.animation.file_name,
      mimeType: msg.animation.mime_type
    };
  }
  if (msg.audio) {
    return {
      type: "audio",
      size: msg.audio.file_size,
      name: msg.audio.file_name,
      mimeType: msg.audio.mime_type
    };
  }
  if (msg.voice) {
    return {
      type: "voice",
      size: msg.voice.file_size,
      mimeType: msg.voice.mime_type
    };
  }
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    return {
      type: "photo",
      size: largest.file_size
    };
  }
  return {
    type: "text"
  };
}
function formatBytes(bytes) {
  if (bytes == null || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = parseFloat((bytes / Math.pow(k, i)).toFixed(1));
  return `${val} ${sizes[i] || "B"}`;
}
function getMediaIcon(type) {
  switch (type) {
    case "video":
      return "🎬 Video";
    case "document":
      return "📄 Document";
    case "photo":
      return "🖼️ Photo";
    case "audio":
      return "🎵 Audio";
    case "voice":
      return "🎙️ Voice";
    case "animation":
      return "🎭 GIF";
    default:
      return "💬 Text";
  }
}
function evaluateMessageFilter(msg, criteria) {
  const meta = extractMessageMetadata(msg);
  const { type, size, name } = meta;
  if (criteria.mediaTypes && criteria.mediaTypes.length > 0) {
    if (!criteria.mediaTypes.includes(type)) {
      return {
        matched: false,
        detectedType: type,
        detectedSize: size,
        detectedName: name,
        reason: type === "text" ? "text-only not allowed" : `${type}s filtered out`
      };
    }
  }
  if (criteria.minSizeBytes != null && size !== void 0) {
    if (size < criteria.minSizeBytes) {
      return {
        matched: false,
        detectedType: type,
        detectedSize: size,
        detectedName: name,
        reason: `below min size ${formatBytes(criteria.minSizeBytes)}`
      };
    }
  }
  if (criteria.maxSizeBytes != null && size !== void 0) {
    if (size > criteria.maxSizeBytes) {
      return {
        matched: false,
        detectedType: type,
        detectedSize: size,
        detectedName: name,
        reason: `above max size ${formatBytes(criteria.maxSizeBytes)}`
      };
    }
  }
  return {
    matched: true,
    detectedType: type,
    detectedSize: size,
    detectedName: name
  };
}
function parseTelegramUpdate(update) {
  const msg = update.message ?? update.channel_post ?? update.edited_message;
  if (update.my_chat_member) {
    const mem = update.my_chat_member;
    const actor = mem.from.username ? `@${mem.from.username}` : mem.from.first_name;
    const chatTitle22 = mem.chat.title ?? (mem.chat.username ? `@${mem.chat.username}` : `Chat #${mem.chat.id}`);
    return {
      update_id: update.update_id,
      kind: "member_event",
      icon: "👤",
      summary: `Bot permissions changed to '${mem.new_chat_member.status}' by ${actor}`,
      chat_name: chatTitle22,
      chat_type: mem.chat.type,
      sender_name: actor,
      date_iso: mem.date ? new Date(mem.date * 1e3).toISOString() : void 0
    };
  }
  if (update.chat_member) {
    const mem = update.chat_member;
    const targetUser = mem.new_chat_member.user.username ? `@${mem.new_chat_member.user.username}` : mem.new_chat_member.user.first_name;
    const chatTitle22 = mem.chat.title ?? (mem.chat.username ? `@${mem.chat.username}` : `Chat #${mem.chat.id}`);
    return {
      update_id: update.update_id,
      kind: "member_event",
      icon: "👥",
      summary: `User ${targetUser} became '${mem.new_chat_member.status}' in chat`,
      chat_name: chatTitle22,
      chat_type: mem.chat.type,
      date_iso: mem.date ? new Date(mem.date * 1e3).toISOString() : void 0
    };
  }
  if (!msg) {
    return {
      update_id: update.update_id,
      kind: "other",
      icon: "⚡",
      summary: "System notification or callback event",
      chat_name: "Unknown",
      chat_type: "unknown"
    };
  }
  const sender = msg.from ? msg.from.username ? `@${msg.from.username}` : msg.from.first_name : update.channel_post ? "Channel Post" : "Anonymous";
  const chatTitle2 = msg.chat.title ?? (msg.chat.username ? `@${msg.chat.username}` : `Chat #${msg.chat.id}`);
  const isPost = Boolean(update.channel_post);
  const dateIso = msg.date ? new Date(msg.date * 1e3).toISOString() : void 0;
  if (msg.text?.startsWith("/")) {
    const parts = msg.text.trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1).join(" ");
    return {
      update_id: update.update_id,
      kind: "command",
      icon: "⚙️",
      summary: `Received command ${cmd}${args ? ` with arguments "${args.length > 30 ? `${args.slice(0, 30)}…` : args}"` : ""} from ${sender}`,
      chat_name: chatTitle2,
      chat_type: msg.chat.type,
      sender_name: sender,
      date_iso: dateIso
    };
  }
  if (msg.document) {
    const name = msg.document.file_name ?? "unnamed file";
    const sizeStr = msg.document.file_size ? ` (${formatBytes(msg.document.file_size)})` : "";
    return {
      update_id: update.update_id,
      kind: "document",
      icon: "📁",
      summary: `Received file '${name}'${sizeStr} from ${sender}`,
      chat_name: chatTitle2,
      chat_type: msg.chat.type,
      sender_name: sender,
      date_iso: dateIso
    };
  }
  if (msg.video) {
    const sizeStr = msg.video.file_size ? ` (${formatBytes(msg.video.file_size)})` : "";
    const durStr = msg.video.duration ? ` [${msg.video.duration}s]` : "";
    return {
      update_id: update.update_id,
      kind: "media",
      icon: "🎬",
      summary: `Received video${durStr}${sizeStr} from ${sender}`,
      chat_name: chatTitle2,
      chat_type: msg.chat.type,
      sender_name: sender,
      date_iso: dateIso
    };
  }
  if (msg.photo && msg.photo.length > 0) {
    const captionSnippet = msg.caption ? `: "${msg.caption.length > 40 ? `${msg.caption.slice(0, 40)}…` : msg.caption}"` : "";
    return {
      update_id: update.update_id,
      kind: "media",
      icon: "🖼️",
      summary: `Received photo${captionSnippet} from ${sender}`,
      chat_name: chatTitle2,
      chat_type: msg.chat.type,
      sender_name: sender,
      date_iso: dateIso
    };
  }
  if (msg.audio) {
    const name = msg.audio.file_name ?? "audio track";
    const sizeStr = msg.audio.file_size ? ` (${formatBytes(msg.audio.file_size)})` : "";
    return {
      update_id: update.update_id,
      kind: "media",
      icon: "🎵",
      summary: `Received audio '${name}'${sizeStr} from ${sender}`,
      chat_name: chatTitle2,
      chat_type: msg.chat.type,
      sender_name: sender,
      date_iso: dateIso
    };
  }
  if (msg.voice) {
    const durStr = msg.voice.duration ? ` (${msg.voice.duration}s)` : "";
    return {
      update_id: update.update_id,
      kind: "media",
      icon: "🎤",
      summary: `Received voice message${durStr} from ${sender}`,
      chat_name: chatTitle2,
      chat_type: msg.chat.type,
      sender_name: sender,
      date_iso: dateIso
    };
  }
  if (msg.animation) {
    return {
      update_id: update.update_id,
      kind: "media",
      icon: "🎞️",
      summary: `Received GIF / animation from ${sender}`,
      chat_name: chatTitle2,
      chat_type: msg.chat.type,
      sender_name: sender,
      date_iso: dateIso
    };
  }
  const rawText = msg.text ?? msg.caption ?? "";
  const snippet = rawText.length > 60 ? `${rawText.slice(0, 60)}…` : rawText;
  if (isPost) {
    return {
      update_id: update.update_id,
      kind: "channel_post",
      icon: "📢",
      summary: snippet ? `Published channel post: "${snippet}"` : "Published channel post",
      chat_name: chatTitle2,
      chat_type: msg.chat.type,
      date_iso: dateIso
    };
  }
  return {
    update_id: update.update_id,
    kind: "text",
    icon: "💬",
    summary: snippet ? `Message from ${sender}: "${snippet}"` : `Message received from ${sender}`,
    chat_name: chatTitle2,
    chat_type: msg.chat.type,
    sender_name: sender,
    date_iso: dateIso
  };
}
async function inspectBot(db, client, existingBotId) {
  return toResult(async () => {
    const me = await client.getMe();
    const webhookInfo = await client.getWebhookInfo().catch(() => null);
    let active_tasks = [];
    let rate_limit_info = {
      is_cooling_down: false,
      cooldown_until: null,
      cooldown_seconds_remaining: 0,
      events_last_24h: 0
    };
    if (existingBotId) {
      const allTasks = await listTasksByBot(db, existingBotId);
      active_tasks = allTasks.filter(
        (t) => t.live_enabled || t.backfill_status === "running" || t.backfill_status === "paused"
      );
      rate_limit_info = await getBotRateLimitStats(db, existingBotId);
    }
    let conflict_detected = false;
    let conflict_message;
    let recent_activities = [];
    const isWebhookActive = Boolean(webhookInfo?.url);
    if (!isWebhookActive) {
      try {
        const rawUpdates = await client.getUpdates({ limit: 8 });
        if (rawUpdates && rawUpdates.length > 0) {
          recent_activities = rawUpdates.map(parseTelegramUpdate);
        }
      } catch (e) {
        if (e instanceof TelegramApiError && e.errorCode === 409) {
          conflict_detected = true;
          conflict_message = e.message || "Conflict: terminated by other getUpdates request (another bot script or Pyrogram session is actively running)";
        }
      }
    }
    return {
      bot_id: me.id,
      bot_username: me.username ?? me.first_name,
      clone_worker_tasks: {
        active_count: active_tasks.length,
        tasks: active_tasks
      },
      webhook: {
        is_active: isWebhookActive,
        url: webhookInfo?.url || void 0,
        pending_update_count: webhookInfo?.pending_update_count ?? 0,
        last_error_message: webhookInfo?.last_error_message,
        last_error_date: webhookInfo?.last_error_date
      },
      polling_session: {
        conflict_detected,
        message: conflict_message
      },
      rate_limits: rate_limit_info,
      recent_activities
    };
  });
}
function json$6(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
async function handleListBots(env) {
  const bots = await listBotsSummary(env.DB);
  return json$6({ ok: true, data: bots });
}
async function handleSyncWebhooks(request, env) {
  const bots = await listBotsWithSecrets(env.DB);
  let webhooksDeleted = 0;
  const errors = [];
  for (const bot of bots) {
    const client = new TelegramClient(bot.token);
    try {
      await client.deleteWebhook(false);
      webhooksDeleted++;
    } catch (e) {
      errors.push(`@${bot.bot_username}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return json$6({
    ok: true,
    data: {
      totalBots: bots.length,
      webhooksDeleted,
      errors: errors.length > 0 ? errors : void 0
    }
  });
}
async function handleVerifyBot(request, env) {
  const body = await request.json().catch(() => ({}));
  let token = body.token?.trim();
  let existingBotId = null;
  if (!token && body.botId) {
    const saved = await getBotWithSecrets(env.DB, body.botId);
    if (!saved) return json$6({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
    token = saved.token;
    existingBotId = saved.id;
  }
  if (!token) {
    return json$6({ ok: false, errorCode: 0, description: "token or botId is required", reason: "invalid_request" }, 400);
  }
  const client = new TelegramClient(token);
  const result = await toResult(async () => {
    const [me, webhookInfo] = await Promise.all([
      client.getMe(),
      client.getWebhookInfo().catch(() => null)
    ]);
    const existing = existingBotId ? await getBotWithSecrets(env.DB, existingBotId) : await findBotByTokenOrBotId(env.DB, token, me.id);
    let active_tasks = [];
    let total_tasks_count = 0;
    let rate_limit_info = {
      is_cooling_down: false,
      cooldown_until: null,
      cooldown_seconds_remaining: 0,
      events_last_24h: 0
    };
    if (existing) {
      existingBotId = existing.id;
      const allTasks = await listTasksByBot(env.DB, existing.id);
      total_tasks_count = allTasks.length;
      active_tasks = allTasks.filter(
        (t) => t.live_enabled || t.backfill_status === "running" || t.backfill_status === "paused"
      );
      rate_limit_info = await getBotRateLimitStats(env.DB, existing.id);
    }
    return {
      bot_id: me.id,
      bot_username: me.username ?? me.first_name,
      existing_bot_id: existingBotId,
      active_tasks,
      total_tasks_count,
      webhook_info: {
        is_active: Boolean(webhookInfo?.url),
        url: webhookInfo?.url || void 0,
        pending_update_count: webhookInfo?.pending_update_count ?? 0,
        last_error_message: webhookInfo?.last_error_message,
        last_error_date: webhookInfo?.last_error_date
      },
      rate_limit_info
    };
  });
  return json$6(result, result.ok ? 200 : 400);
}
async function handleInspectBot(request, env) {
  const body = await request.json().catch(() => ({}));
  let token = body.token?.trim();
  let existingBotId = null;
  if (!token && body.botId) {
    const saved = await getBotWithSecrets(env.DB, body.botId);
    if (!saved) return json$6({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
    token = saved.token;
    existingBotId = saved.id;
  }
  if (!token) {
    return json$6({ ok: false, errorCode: 0, description: "token or botId is required", reason: "invalid_request" }, 400);
  }
  const client = new TelegramClient(token);
  const existing = existingBotId ? await getBotWithSecrets(env.DB, existingBotId) : await findBotByTokenOrBotId(env.DB, token);
  const result = await inspectBot(env.DB, client, existing?.id ?? null);
  return json$6(result, result.ok ? 200 : 400);
}
async function handleDisconnectBotWebhook(request, env) {
  const body = await request.json().catch(() => ({}));
  let token = body.token?.trim();
  if (!token && body.botId) {
    const saved = await getBotWithSecrets(env.DB, body.botId);
    if (!saved) return json$6({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
    token = saved.token;
  }
  if (!token) {
    return json$6({ ok: false, errorCode: 0, description: "token or botId is required", reason: "invalid_request" }, 400);
  }
  const client = new TelegramClient(token);
  const result = await toResult(async () => {
    await client.deleteWebhook(false);
    const webhookInfo = await client.getWebhookInfo().catch(() => null);
    return {
      disconnected: true,
      pending_updates_preserved: true,
      pending_update_count: webhookInfo?.pending_update_count ?? 0
    };
  });
  return json$6(result, result.ok ? 200 : 400);
}
async function createBotRecord(env, _origin, token, label) {
  const client = new TelegramClient(token);
  return toResult(async () => {
    const me = await client.getMe();
    const id = crypto.randomUUID();
    const webhookSecret = crypto.randomUUID().replace(/-/g, "");
    const botUsername = me.username ?? me.first_name;
    const botLabel = label || botUsername;
    await insertBot(env.DB, {
      id,
      token,
      bot_id: me.id,
      bot_username: botUsername,
      label: botLabel,
      webhook_secret: webhookSecret
    });
    return { id, bot_id: me.id, bot_username: botUsername, label: botLabel, created_at: Math.floor(Date.now() / 1e3) };
  });
}
async function handleUpdateBot(request, env, id) {
  const body = await request.json().catch(() => ({}));
  if (!body.label) {
    return json$6({ ok: false, errorCode: 0, description: "label is required", reason: "invalid_request" }, 400);
  }
  await updateBotLabel(env.DB, id, body.label);
  return json$6({ ok: true, data: null });
}
async function handleDeleteBot(env, id) {
  const bot = await getBotWithSecrets(env.DB, id);
  if (!bot) return json$6({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const client = new TelegramClient(bot.token);
  await toResult(() => client.deleteWebhook(false));
  await deleteBot(env.DB, id);
  return json$6({ ok: true, data: null });
}
function deriveCapabilities(botMember, chatType) {
  const isCreator = botMember.status === "creator";
  const isAdmin = botMember.status === "administrator" || isCreator;
  const has = (right) => isCreator || isAdmin && Boolean(botMember[right]);
  const canSend = (botMember.status === "member" || isAdmin) && (chatType !== "channel" || has("can_post_messages"));
  return [
    {
      key: "invite_link",
      label: "Generate invite link",
      available: has("can_invite_users"),
      reason: has("can_invite_users") ? void 0 : "bot lacks the 'Add Users' admin right in this chat"
    },
    {
      key: "ban",
      label: "Ban / unban user",
      available: has("can_restrict_members"),
      reason: has("can_restrict_members") ? void 0 : "bot lacks the 'Restrict Members' admin right in this chat"
    },
    {
      key: "promote",
      label: "Promote member",
      available: has("can_promote_members"),
      reason: has("can_promote_members") ? void 0 : "bot lacks the 'Add New Admins' admin right in this chat"
    },
    {
      key: "send_message",
      label: "Send message",
      available: canSend,
      reason: canSend ? void 0 : "bot cannot post in this chat (not a member with send rights)"
    },
    {
      key: "delete_message",
      label: "Delete message (used by the 'last N' probe)",
      available: has("can_delete_messages"),
      reason: has("can_delete_messages") ? void 0 : "bot lacks the 'Delete Messages' admin right in this chat"
    }
  ];
}
async function lookupChat(db, client, botTelegramId, chatId) {
  return toResult(async () => {
    const chat = await client.getChat(chatId);
    const member = await client.getChatMember(chatId, botTelegramId);
    let memberCount = void 0;
    try {
      memberCount = await client.getChatMemberCount(chatId);
    } catch (e) {
    }
    let admins = void 0;
    try {
      const adminData = await client.getChatAdministrators(chatId);
      admins = adminData.map((a) => ({
        id: a.user.id,
        name: a.user.first_name + (a.user.username ? ` (@${a.user.username})` : ""),
        status: a.status,
        is_bot: a.user.is_bot
      }));
    } catch (e) {
    }
    const pastTasks = await listTasksForSourceChat(db, [chatId, String(chat.id)]);
    return {
      chat: { id: chat.id, type: chat.type, title: chat.title, username: chat.username },
      botStatus: member.status,
      capabilities: deriveCapabilities(member, chat.type),
      memberCount,
      admins,
      pastTasks
    };
  });
}
async function resolveLastN(client, sourceChatId, n) {
  const probe = await client.sendMessage(sourceChatId, ".");
  let cleanupOk = true;
  try {
    await client.deleteMessage(sourceChatId, probe.message_id);
  } catch {
    cleanupOk = false;
  }
  const latestRealId = probe.message_id - 1;
  return { startId: Math.max(1, latestRealId - n + 1), endId: latestRealId, cleanupOk };
}
function json$5(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
async function loadClient(env, botId, token) {
  if (token) return new TelegramClient(token);
  if (!botId) return null;
  const bot = await getBotWithSecrets(env.DB, botId);
  return bot ? new TelegramClient(bot.token) : null;
}
async function loadClientAndBotId(env, botId, token, botTelegramId) {
  if (token) {
    const telegramId = Number(botTelegramId);
    if (!telegramId) return null;
    return { client: new TelegramClient(token), botTelegramId: telegramId };
  }
  if (!botId) return null;
  const bot = await getBotWithSecrets(env.DB, botId);
  return bot ? { client: new TelegramClient(bot.token), botTelegramId: bot.bot_id } : null;
}
async function handleGetChat(env, chatId, botId, token, botTelegramId) {
  const loaded = await loadClientAndBotId(env, botId, token, botTelegramId);
  if (!loaded) return json$5({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await lookupChat(env.DB, loaded.client, loaded.botTelegramId, chatId);
  return json$5(result, result.ok ? 200 : 400);
}
async function handleInviteLink(env, chatId, botId, token) {
  const client = await loadClient(env, botId, token);
  if (!client) return json$5({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.createChatInviteLink(chatId));
  return json$5(result, result.ok ? 200 : 400);
}
async function handleRevokeInviteLink(env, chatId, botId, inviteLink2, token) {
  const client = await loadClient(env, botId, token);
  if (!client) return json$5({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.revokeChatInviteLink(chatId, inviteLink2));
  return json$5(result, result.ok ? 200 : 400);
}
async function handleBan(env, chatId, botId, userId, token) {
  const client = await loadClient(env, botId, token);
  if (!client) return json$5({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.banChatMember(chatId, userId));
  return json$5(result, result.ok ? 200 : 400);
}
async function handleUnban(env, chatId, botId, userId, token) {
  const client = await loadClient(env, botId, token);
  if (!client) return json$5({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.unbanChatMember(chatId, userId));
  return json$5(result, result.ok ? 200 : 400);
}
async function handlePromote(env, chatId, botId, userId, rights, token) {
  const client = await loadClient(env, botId, token);
  if (!client) return json$5({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.promoteChatMember(chatId, userId, rights));
  return json$5(result, result.ok ? 200 : 400);
}
async function handleSendTestMessage(env, chatId, botId, text, token) {
  const client = await loadClient(env, botId, token);
  if (!client) return json$5({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.sendMessage(chatId, text));
  return json$5(result, result.ok ? 200 : 400);
}
async function handleLatestMessageId(env, chatId, botId, token) {
  const client = await loadClient(env, botId, token);
  if (!client) return json$5({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(async () => {
    const { endId, cleanupOk } = await resolveLastN(client, chatId, 1);
    return { latestMessageId: endId, cleanupOk };
  });
  return json$5(result, result.ok ? 200 : 400);
}
async function handleAdHocTestCopy(env, sourceChatId, botId, destChatId, token, messageId) {
  const client = await loadClient(env, botId, token);
  if (!client) return json$5({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(async () => {
    let copyId = messageId;
    if (!copyId) {
      const latest = await resolveLastN(client, sourceChatId, 1);
      copyId = latest.endId;
    }
    return client.copyMessage(destChatId, sourceChatId, copyId);
  });
  return json$5(result, result.ok ? 200 : 400);
}
const DEFAULT_PACING_BATCH_SIZE = 60;
async function createTask(env, botId, input) {
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
      duplicateTaskId: duplicate.id
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
    const label = input.label ?? `${input.sourceChatTitle ?? input.sourceChatId} → ${input.destChatTitle ?? input.destChatId}`;
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
      backfill_mode: wantsBackfill ? input.backfillMode ?? "range" : null,
      start_id: startId,
      end_id: endId,
      cursor: wantsBackfill ? startId : null,
      total: wantsBackfill && startId !== null && endId !== null ? endId - startId + 1 : null,
      backfill_status: wantsBackfill ? "running" : "not_applicable",
      pacing_batch_size: pacingBatchSize,
      filter_media_types: input.filterMediaTypes ?? null,
      filter_min_size_bytes: input.filterMinSizeBytes ?? null,
      filter_max_size_bytes: input.filterMaxSizeBytes ?? null
    });
    if (input.saveTemplate) {
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
          backfill_mode: wantsBackfill ? input.backfillMode ?? "range" : null,
          start_id: startId,
          end_id: endId,
          n: wantsBackfill && input.backfillMode === "lastN" ? input.n ?? null : null,
          pacing_batch_size: pacingBatchSize,
          filter_media_types: input.filterMediaTypes ?? null,
          filter_min_size_bytes: input.filterMinSizeBytes ?? null,
          filter_max_size_bytes: input.filterMaxSizeBytes ?? null
        });
      } catch (e) {
        console.error("saved_tasks write failed", e);
      }
    }
    return await getTask(env.DB, id);
  });
}
async function applyTaskPatch(env, taskId, patch) {
  const currentTask = await getTask(env.DB, taskId);
  if (!currentTask) {
    return { ok: false, errorCode: 404, description: "task not found", reason: "invalid_request" };
  }
  const targetScope = patch.scope ?? currentTask.scope;
  let liveEnabled = patch.liveEnabled;
  let backfillStatus = patch.backfillStatus;
  if (patch.scope !== void 0) {
    if (patch.scope === "live") {
      liveEnabled = liveEnabled !== void 0 ? liveEnabled : true;
      backfillStatus = "not_applicable";
    } else if (patch.scope === "backfill_only") {
      liveEnabled = false;
      if (!backfillStatus) {
        backfillStatus = currentTask.backfill_status === "not_applicable" ? "running" : currentTask.backfill_status;
      }
    } else if (patch.scope === "live_and_backfill") {
      liveEnabled = liveEnabled !== void 0 ? liveEnabled : true;
      if (!backfillStatus) {
        backfillStatus = currentTask.backfill_status === "not_applicable" ? "running" : currentTask.backfill_status;
      }
    }
  }
  let startId = patch.startId !== void 0 ? patch.startId : currentTask.start_id;
  let endId = patch.endId !== void 0 ? patch.endId : currentTask.end_id;
  let cursor = patch.cursor !== void 0 ? patch.cursor : currentTask.cursor;
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
        if (cursor === null || cursor < startId) {
          cursor = startId;
        }
        if (cursor <= endId && (currentTask.backfill_status === "complete" || backfillStatus === "complete")) {
          backfillStatus = "running";
        }
      }
    }
  }
  let filterMediaTypes = patch.filterMediaTypes !== void 0 ? patch.filterMediaTypes : currentTask.filter_media_types;
  let filterMinSizeBytes = patch.filterMinSizeBytes !== void 0 ? patch.filterMinSizeBytes : currentTask.filter_min_size_bytes;
  let filterMaxSizeBytes = patch.filterMaxSizeBytes !== void 0 ? patch.filterMaxSizeBytes : currentTask.filter_max_size_bytes;
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
    filter_max_size_bytes: filterMaxSizeBytes
  });
  return { ok: true, data: await getTask(env.DB, taskId) };
}
const NEW_BOT_SENTINEL = "new";
function json$4(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
async function handleListAllTasks(env) {
  const tasks = await listAllTasksSummary(env.DB);
  return json$4({ ok: true, data: tasks });
}
async function handleListTasks(env, botId) {
  const tasks = await listTasksByBot(env.DB, botId);
  return json$4({ ok: true, data: tasks });
}
async function handleGetTaskById(env, taskId) {
  const task = await getTaskWithBot(env.DB, taskId);
  if (!task) return json$4({ ok: false, errorCode: 404, description: "task not found", reason: "invalid_request" }, 404);
  return json$4({ ok: true, data: task });
}
async function handleGetTaskActivity(env, taskId) {
  const log = await listActivityLog(env.DB, taskId);
  return json$4({ ok: true, data: log });
}
async function handleCreateTask(request, env, botId, origin) {
  const body = await request.json();
  let resolvedBotId = botId;
  if (botId === NEW_BOT_SENTINEL) {
    if (!body.botToken) {
      return json$4({ ok: false, errorCode: 0, description: "botToken is required", reason: "invalid_request" }, 400);
    }
    const created = await createBotRecord(env, origin, body.botToken, body.botLabel);
    if (!created.ok) return json$4(created, 400);
    resolvedBotId = created.data.id;
  }
  const result = await createTask(env, resolvedBotId, body);
  return json$4(result, result.ok ? 201 : result.errorCode === 409 ? 409 : 400);
}
async function handlePatchTask(request, env, taskId) {
  const body = await request.json();
  const result = await applyTaskPatch(env, taskId, body);
  return json$4(result, result.ok ? 200 : result.errorCode === 404 ? 404 : 400);
}
async function handleDeleteTask(env, taskId) {
  await deleteTask(env.DB, taskId);
  return json$4({ ok: true, data: null });
}
async function handleTestCopy(env, botId, taskId, messageId) {
  const bot = await getBotWithSecrets(env.DB, botId);
  const task = await getTask(env.DB, taskId);
  if (!bot || !task) return json$4({ ok: false, errorCode: 404, description: "not found", reason: "invalid_request" }, 404);
  const client = new TelegramClient(bot.token);
  const result = await toResult(async () => {
    let copyId = messageId;
    if (!copyId) {
      const latest = await resolveLastN(client, task.source_chat_id, 1);
      copyId = latest.endId;
    }
    return client.copyMessage(task.dest_chat_id, task.source_chat_id, copyId);
  });
  return json$4(result, result.ok ? 200 : 400);
}
function json$3(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
async function handleListSavedTasks(env) {
  const saved = await listSavedTasks(env.DB);
  return json$3({ ok: true, data: saved });
}
async function handleGetSavedTask(env, id) {
  const saved = await getSavedTask(env.DB, id);
  if (!saved) return json$3({ ok: false, errorCode: 404, description: "saved task not found", reason: "invalid_request" }, 404);
  return json$3({ ok: true, data: saved });
}
async function handleCreateSavedTask(request, env) {
  const body = await request.json();
  const id = crypto.randomUUID();
  await insertSavedTask(env.DB, { ...body, id });
  return json$3({ ok: true, data: { id } }, 201);
}
async function handleDeleteSavedTask(env, id) {
  await deleteSavedTask(env.DB, id);
  return json$3({ ok: true, data: null });
}
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index2 = cursor++;
      results[index2] = await worker(items[index2], index2);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
const MAX_CONCURRENT_BOTS = 6;
const MAX_BATCH_IDS = 100;
const LEASE_SECONDS = 240;
const RATE_LIMIT_COOLDOWN_MIN_SECONDS = 60;
const RATE_LIMIT_COOLDOWN_MAX_SECONDS = 120;
async function runTick(env) {
  const tickStartedAtMs = Date.now();
  const tasks = await listActiveSyncTasks(env.DB);
  const groups = [];
  for (const task of tasks) {
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup[0].bot_id === task.bot_id) {
      lastGroup.push(task);
    } else {
      groups.push([task]);
    }
  }
  const totalBots = groups.length;
  const isSmoothMode = totalBots <= 50;
  const MAX_TICK_WALL_TIME_MS = isSmoothMode ? 5e4 : 38e3;
  if (!isSmoothMode && groups.length > 0) {
    const offset = Math.floor(tickStartedAtMs / 6e4) % groups.length;
    groups.push(...groups.splice(0, offset));
  }
  let batchesRun = 0;
  await runWithConcurrency(groups, MAX_CONCURRENT_BOTS, async (groupTasks) => {
    if (!isSmoothMode && Date.now() - tickStartedAtMs > MAX_TICK_WALL_TIME_MS) {
      return;
    }
    const botId = groupTasks[0].bot_id;
    try {
      const bot = await getBotWithSecrets(env.DB, botId);
      if (!bot) return;
      const client = new TelegramClient(bot.token);
      const hasLive = groupTasks.some((t) => t.live_enabled);
      if (hasLive) {
        try {
          const MAX_PULL_PAGES = 5;
          let page = 0;
          let currentOffset = bot.last_update_id > 0 ? bot.last_update_id + 1 : void 0;
          let maxUpdateId = bot.last_update_id;
          while (page < MAX_PULL_PAGES) {
            page++;
            const updates = await client.getUpdates({
              offset: currentOffset,
              limit: 100,
              allowed_updates: ["channel_post"]
            });
            if (!updates || updates.length === 0) break;
            for (const update of updates) {
              if (update.update_id > maxUpdateId) maxUpdateId = update.update_id;
              const post = update.channel_post;
              if (!post) continue;
              const chatStr = String(post.chat.id);
              const matchingTasks = groupTasks.filter((t) => t.source_chat_id === chatStr && t.live_enabled);
              if (matchingTasks.length === 0) continue;
              const meta = extractMessageMetadata(post);
              const icon = getMediaIcon(meta.type);
              const sizeStr = meta.size ? formatBytes(meta.size) : "";
              const fileDesc = [icon, sizeStr, meta.name ? `(${meta.name})` : ""].filter(Boolean).join(" ");
              for (const t of matchingTasks) {
                if (t.cursor === null && t.backfill_status === "not_applicable") {
                  t.cursor = post.message_id;
                }
                const filterMediaTypes = t.filter_media_types ? t.filter_media_types.split(",").map((s) => s.trim()).filter(Boolean) : void 0;
                const evalResult = evaluateMessageFilter(post, {
                  mediaTypes: filterMediaTypes,
                  minSizeBytes: t.filter_min_size_bytes,
                  maxSizeBytes: t.filter_max_size_bytes
                });
                if (!evalResult.matched) {
                  await incrementLiveCounters(env.DB, t.id, 0, 0, 1);
                  t.live_skipped = (t.live_skipped ?? 0) + 1;
                  await appendActivityLog(env.DB, {
                    task_id: t.id,
                    kind: "live_forward",
                    detail: `${fileDesc} · msg #${post.message_id} skipped: ${evalResult.reason}`,
                    ok: false,
                    error: `Filtered: ${evalResult.reason}`
                  });
                  continue;
                }
                await insertPendingMessage(
                  env.DB,
                  t.id,
                  post.message_id,
                  meta.type,
                  meta.size ?? null,
                  meta.name ?? null
                );
                if (t.backfill_status === "running") {
                  await appendActivityLog(env.DB, {
                    task_id: t.id,
                    kind: "live_forward",
                    detail: `⏳ Queued in buffer: ${fileDesc} · msg #${post.message_id} (waiting for backfill to finish)`,
                    ok: true
                  });
                }
              }
            }
            currentOffset = maxUpdateId + 1;
            if (updates.length < 100) break;
          }
          if (maxUpdateId > bot.last_update_id) {
            await updateBotLastUpdateId(env.DB, bot.id, maxUpdateId);
            bot.last_update_id = maxUpdateId;
          }
        } catch (e) {
          if (e instanceof TelegramApiError) {
            if (e.errorCode === 401 || e.reason === "unauthorized") {
              console.warn(`tick: bot ${bot.bot_username} unauthorized (401), stopping live tasks.`);
              const stoppedTasks = await stopTasksForBot(env.DB, bot.id, "unauthorized");
              for (const st of stoppedTasks) {
                await appendActivityLog(env.DB, {
                  task_id: st.id,
                  kind: "live_forward",
                  detail: "Stopped: Bot token unauthorized (401). Bot token may have been revoked or changed in @BotFather.",
                  ok: false,
                  error: "401 Unauthorized"
                });
              }
              return;
            }
            if (e.errorCode === 409 || typeof e.message === "string" && e.message.toLowerCase().includes("webhook")) {
              console.warn(`tick: webhook conflict detected for bot ${bot.bot_username}, attempting deleteWebhook to restore getUpdates.`);
              try {
                await client.deleteWebhook();
              } catch (delErr) {
                console.error(`tick: failed to deleteWebhook for bot ${bot.bot_username}:`, delErr);
              }
              return;
            }
          }
          console.error(`tick: getUpdates failed for bot ${bot.bot_username}`, e);
        }
      }
      for (const task of groupTasks) {
        if (task.backfill_status === "running" && task.cursor !== null && task.end_id !== null && task.cursor > task.end_id) {
          const res = await advanceTaskProgress(env.DB, task.id, {
            cursor: task.cursor,
            processed: task.processed,
            failed: task.failed,
            backfill_status: "complete"
          });
          task.backfill_status = res.backfill_status;
        }
        if (task.cursor === null || task.end_id === null || task.cursor > task.end_id) {
          continue;
        }
        const claimed = await claimTask(env.DB, task.id, LEASE_SECONDS);
        if (!claimed) continue;
        try {
          batchesRun++;
          const skipBotForRest = await processOneBatch(env, claimed, bot, client);
          if (skipBotForRest) break;
        } catch (e) {
          console.error(`tick: task ${claimed.id} failed`, e);
        } finally {
          await releaseTaskLease(env.DB, claimed.id);
        }
      }
    } catch (e) {
      console.error(`tick: bot ${botId} group failed`, e);
    }
  });
  const tasksWithPending = await listTasksWithPendingMessages(env.DB);
  for (const pTask of tasksWithPending) {
    try {
      await drainPendingMessagesForTask(env, pTask);
    } catch (e) {
      console.error(`tick: draining pending messages for task ${pTask.id} failed`, e);
    }
  }
  const wallTimeMs = Date.now() - tickStartedAtMs;
  console.log(`tick: ${groups.length} group(s), ${tasks.length} task(s), ${batchesRun} batch(es), mode: ${isSmoothMode ? "smooth" : "round-robin"}, ${wallTimeMs}ms`);
}
async function drainPendingMessagesForTask(env, task) {
  if (task.backfill_status === "running") return false;
  const pending = await listPendingMessages(env.DB, task.id, 60);
  if (pending.length === 0) return false;
  const bot = await getBotWithSecrets(env.DB, task.bot_id);
  if (!bot) return false;
  const client = new TelegramClient(bot.token);
  for (const item of pending) {
    const icon = getMediaIcon(item.media_type ?? "text");
    const sizeStr = item.file_size ? formatBytes(item.file_size) : "";
    const fileDesc = [icon, sizeStr, item.file_name ? `(${item.file_name})` : ""].filter(Boolean).join(" ");
    try {
      await client.copyMessage(task.dest_chat_id, task.source_chat_id, item.message_id);
      await deletePendingMessages(env.DB, [item.id]);
      await incrementLiveCounters(env.DB, task.id, 1, 0, 0);
      await appendActivityLog(env.DB, {
        task_id: task.id,
        kind: "live_forward",
        detail: `Copied ${fileDesc} · msg #${item.message_id} (delivered from live queue)`,
        ok: true
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (e instanceof TelegramApiError && e.reason === "rate_limited") {
        const waitSeconds = Math.min(
          Math.max(e.retryAfter ?? 0, RATE_LIMIT_COOLDOWN_MIN_SECONDS),
          RATE_LIMIT_COOLDOWN_MAX_SECONDS
        );
        await pauseBotForRateLimit(env.DB, task.bot_id, Math.floor(Date.now() / 1e3) + waitSeconds);
        return true;
      }
      if (e instanceof TelegramApiError && e.reason === "unauthorized") {
        await stopTasksForBot(env.DB, task.bot_id, "unauthorized");
        return true;
      }
      if (e instanceof TelegramApiError && (e.message.toLowerCase().includes("not found") || e.message.toLowerCase().includes("message to forward not found") || e.message.toLowerCase().includes("message to copy not found"))) {
        await deletePendingMessages(env.DB, [item.id]);
        await appendActivityLog(env.DB, {
          task_id: task.id,
          kind: "live_forward",
          detail: `msg #${item.message_id}: not found in source, removed from queue`,
          ok: false,
          error
        });
      }
      break;
    }
  }
  return false;
}
async function processOneBatch(env, task, botParam, clientParam) {
  if (task.cursor === null || task.end_id === null) return false;
  const bot = botParam ?? await getBotWithSecrets(env.DB, task.bot_id);
  if (!bot) return false;
  const client = clientParam ?? new TelegramClient(bot.token);
  const batchStartedAtMs = Date.now();
  const batchEnd = Math.min(task.cursor + task.pacing_batch_size - 1, task.end_id, task.cursor + MAX_BATCH_IDS - 1);
  const messageIds = [];
  for (let id = task.cursor; id <= batchEnd; id++) messageIds.push(id);
  let succeeded;
  try {
    const results = await client.copyMessages(task.dest_chat_id, task.source_chat_id, messageIds);
    succeeded = results.length;
  } catch (e) {
    if (e instanceof TelegramApiError && e.reason === "rate_limited") {
      const waitSeconds = Math.min(
        Math.max(e.retryAfter ?? 0, RATE_LIMIT_COOLDOWN_MIN_SECONDS),
        RATE_LIMIT_COOLDOWN_MAX_SECONDS
      );
      await pauseBotForRateLimit(env.DB, task.bot_id, Math.floor(Date.now() / 1e3) + waitSeconds);
      await appendActivityLog(env.DB, {
        task_id: task.id,
        kind: "backfill_batch",
        detail: `ids ${task.cursor}-${batchEnd}: rate limited, pausing bot for ${waitSeconds}s`,
        ok: true
      });
      return true;
    }
    if (e instanceof TelegramApiError && e.reason === "unauthorized") {
      const stopped = await stopTasksForBot(env.DB, task.bot_id, "unauthorized");
      for (const t of stopped) {
        await appendActivityLog(env.DB, {
          task_id: t.id,
          kind: "backfill_batch",
          detail: `bot token unauthorized (401) — task auto-stopped (${t.processed} copied, ${t.failed} failed before stopping)`,
          ok: false,
          error: e.message
        });
      }
      return true;
    }
    if (e instanceof TelegramApiError && (e.message.toLowerCase().includes("no messages to forward") || /failed to send message #\d+\b/i.test(e.message))) {
      succeeded = 0;
    } else if (e instanceof TelegramApiError && (e.reason === "bot_not_in_chat" || e.reason === "insufficient_permissions")) {
      await stopTask(env.DB, task.id, e.reason);
      await appendActivityLog(env.DB, {
        task_id: task.id,
        kind: "backfill_batch",
        detail: `ids ${task.cursor}-${batchEnd}: ${e.reason} — task auto-stopped`,
        ok: false,
        error: e.message
      });
      return false;
    } else {
      const reason = e instanceof TelegramApiError ? e.reason : "unexpected error";
      const message = e instanceof Error ? e.message : String(e);
      await appendActivityLog(env.DB, {
        task_id: task.id,
        kind: "backfill_batch",
        detail: `ids ${task.cursor}-${batchEnd}: ${reason}, resuming next tick`,
        ok: false,
        error: message
      });
      return false;
    }
  }
  const batchDurationMs = Date.now() - batchStartedAtMs;
  const skipped = messageIds.length - succeeded;
  const newCursor = batchEnd + 1;
  const wasBackfilling = task.backfill_status !== "complete";
  let newProcessed = task.processed;
  let newFailed = task.failed;
  let newLiveProcessed = task.live_processed ?? 0;
  let newLiveFailed = task.live_failed ?? 0;
  if (wasBackfilling) {
    newProcessed += succeeded;
    newFailed += skipped;
  } else {
    newLiveProcessed += succeeded;
    newLiveFailed += skipped;
  }
  const progressResult = await advanceTaskProgress(env.DB, task.id, {
    cursor: newCursor,
    processed: newProcessed,
    failed: newFailed,
    live_processed: newLiveProcessed,
    live_failed: newLiveFailed
  });
  const justCompletedBackfill = wasBackfilling && progressResult.complete;
  const isLiveScope = task.scope === "live" || task.scope === "live_and_backfill" && !wasBackfilling;
  await appendActivityLog(env.DB, {
    task_id: task.id,
    kind: isLiveScope ? "live_forward" : "backfill_batch",
    detail: `ids ${task.cursor}-${batchEnd}: ${succeeded} ok, ${skipped} skipped, took ${batchDurationMs}ms${justCompletedBackfill ? " (backfill complete)" : ""}`,
    ok: true,
    error: skipped > 0 ? `${skipped} message(s) in this range skipped by Telegram (not found / can't be copied)` : void 0
  });
  if (progressResult.complete || Math.random() < 0.05) {
    await pruneActivityLog(env.DB, task.id);
  }
  return false;
}
let bootstrapDone = false;
async function ensureDatabaseBootstrap(db) {
  if (bootstrapDone) return;
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS bot_controller_sessions (
      chat_id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      state TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`).run();
    const existing = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").first();
    if (existing) {
      bootstrapDone = true;
      return;
    }
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS bot_controller_sessions (
        chat_id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        state TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        bot_id INTEGER NOT NULL,
        bot_username TEXT NOT NULL,
        label TEXT NOT NULL,
        webhook_secret TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_update_id INTEGER NOT NULL DEFAULT 0
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        source_chat_id TEXT NOT NULL,
        source_chat_title TEXT,
        dest_chat_id TEXT NOT NULL,
        dest_chat_title TEXT,
        scope TEXT NOT NULL CHECK (scope IN ('live', 'live_and_backfill', 'backfill_only')),
        live_enabled INTEGER NOT NULL DEFAULT 0,
        backfill_mode TEXT CHECK (backfill_mode IN ('range', 'lastN')),
        start_id INTEGER,
        end_id INTEGER,
        cursor INTEGER,
        total INTEGER,
        processed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        backfill_status TEXT NOT NULL DEFAULT 'not_applicable'
          CHECK (backfill_status IN ('not_applicable', 'pending', 'running', 'paused', 'complete', 'cancelled', 'failed')),
        pacing_batch_size INTEGER NOT NULL DEFAULT 20,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        stop_reason TEXT,
        stopped_at INTEGER,
        lease_expires_at INTEGER,
        rate_limited_until INTEGER,
        live_processed INTEGER NOT NULL DEFAULT 0,
        live_failed INTEGER NOT NULL DEFAULT 0,
        filter_media_types TEXT,
        filter_min_size_bytes INTEGER,
        filter_max_size_bytes INTEGER,
        live_skipped INTEGER NOT NULL DEFAULT 0
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS task_activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('live_forward', 'backfill_batch')),
        detail TEXT,
        ok INTEGER NOT NULL,
        error TEXT,
        at INTEGER NOT NULL DEFAULT (unixepoch())
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS saved_tasks (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        bot_token TEXT NOT NULL,
        bot_label TEXT NOT NULL,
        bot_username TEXT NOT NULL,
        source_chat_id TEXT NOT NULL,
        source_chat_title TEXT,
        dest_chat_id TEXT NOT NULL,
        dest_chat_title TEXT,
        scope TEXT NOT NULL CHECK (scope IN ('live', 'live_and_backfill', 'backfill_only')),
        backfill_mode TEXT CHECK (backfill_mode IN ('range', 'lastN')),
        start_id INTEGER,
        end_id INTEGER,
        n INTEGER,
        pacing_batch_size INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        filter_media_types TEXT,
        filter_min_size_bytes INTEGER,
        filter_max_size_bytes INTEGER
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS task_pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        media_type TEXT,
        file_size INTEGER,
        file_name TEXT
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        update_id INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        received_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_bot_id ON tasks(bot_id)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_source_chat ON tasks(bot_id, source_chat_id)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_backfill_running ON tasks(backfill_status) WHERE backfill_status = 'running'`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_task_activity_log_task_id ON task_activity_log(task_id, at DESC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_saved_tasks_task_id ON saved_tasks(task_id)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_pending_messages_task_id ON task_pending_messages(task_id, id ASC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_updates_bot_id ON updates(bot_id, received_at DESC)`)
    ]);
    bootstrapDone = true;
  } catch (err) {
    console.error("Database bootstrap initialization check failed:", err);
  }
}
const PBKDF2_ITERATIONS = 1e5;
const HASH_ALGO = "SHA-256";
function generateSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const saltBytes = enc.encode(salt);
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: HASH_ALGO
    },
    keyMaterial,
    256
  );
  const hashBytes = new Uint8Array(derived);
  return Array.from(hashBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function timingSafeStringCompare(a, b) {
  const enc = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b))
  ]);
  const bytesA = new Uint8Array(hashA);
  const bytesB = new Uint8Array(hashB);
  let mismatch = 0;
  for (let i = 0; i < 32; i++) {
    mismatch |= bytesA[i] ^ bytesB[i];
  }
  return mismatch === 0;
}
function base64UrlEncode(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
async function importHmacKey(secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: HASH_ALGO },
    false,
    ["sign", "verify"]
  );
}
async function signSessionToken(payload, secret) {
  const enc = new TextEncoder();
  const payloadBytes = enc.encode(JSON.stringify(payload));
  const payloadPart = base64UrlEncode(payloadBytes);
  const key = await importHmacKey(secret);
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(payloadPart));
  const sigPart = base64UrlEncode(new Uint8Array(sigBuffer));
  return `${payloadPart}.${sigPart}`;
}
async function verifySessionToken(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return { valid: false };
    const [payloadPart, sigPart] = parts;
    const key = await importHmacKey(secret);
    const enc = new TextEncoder();
    const sigBytes = base64UrlDecode(sigPart);
    const isValidSig = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      enc.encode(payloadPart)
    );
    if (!isValidSig) return { valid: false };
    const payloadBytes = base64UrlDecode(payloadPart);
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (!payload || payload.sub !== "admin" || typeof payload.exp !== "number" || typeof payload.iat !== "number" || Date.now() > payload.exp) {
      return { valid: false };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
}
function json$2(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}
let ephemeralSigningSecret = null;
async function getSigningSecret(env) {
  if (env.AUTH_SECRET && env.AUTH_SECRET.trim().length > 0) {
    return env.AUTH_SECRET.trim();
  }
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'auth_secret'").first();
    if (row && row.value && row.value.trim().length > 0) {
      return row.value.trim();
    }
    const newSecret = generateSalt() + generateSalt();
    await env.DB.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('auth_secret', ?)").bind(newSecret).run();
    const stored = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'auth_secret'").first();
    return stored?.value || newSecret;
  } catch (err) {
    console.error("Failed to query or store auth_secret in D1:", err);
    if (!ephemeralSigningSecret) {
      ephemeralSigningSecret = generateSalt() + generateSalt() + generateSalt();
    }
    return ephemeralSigningSecret;
  }
}
async function getAuthMode(env) {
  if (env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.trim().length > 0) {
    return { mode: "enforced", source: "env" };
  }
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'admin_password_hash'").first();
    if (row && row.value && row.value.trim().length > 0) {
      return { mode: "enforced", source: "d1" };
    }
  } catch (err) {
    console.error("Failed to check admin_password_hash in D1:", err);
  }
  return { mode: "open", source: "none" };
}
function extractBearerToken(request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  return null;
}
async function isRequestAuthenticated(request, env) {
  const token = extractBearerToken(request);
  if (!token) return false;
  const secret = await getSigningSecret(env);
  const result = await verifySessionToken(token, secret);
  return result.valid;
}
async function handleAuthStatus(request, env) {
  const { mode, source } = await getAuthMode(env);
  const authenticated = await isRequestAuthenticated(request, env);
  const statusData = {
    mode,
    source,
    authenticated: mode === "open" ? true : authenticated
  };
  return json$2({ ok: true, data: statusData });
}
async function handleAuthLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const inputPassword = typeof body.password === "string" ? body.password : "";
  if (!inputPassword) {
    return json$2({ ok: false, errorCode: 400, description: "Password is required", reason: "invalid_request" }, 400);
  }
  if (inputPassword.length > 256) {
    return json$2({ ok: false, errorCode: 400, description: "Password exceeds maximum length (256 characters)", reason: "invalid_request" }, 400);
  }
  const { mode, source } = await getAuthMode(env);
  let verified = false;
  if (source === "env") {
    const expected = env.ADMIN_PASSWORD ?? "";
    verified = await timingSafeStringCompare(inputPassword, expected);
  } else if (source === "d1") {
    try {
      const rows = await env.DB.prepare("SELECT key, value FROM app_settings WHERE key IN ('admin_password_hash', 'admin_password_salt')").all();
      const hashRow = rows.results.find((r) => r.key === "admin_password_hash");
      const saltRow = rows.results.find((r) => r.key === "admin_password_salt");
      if (hashRow && saltRow) {
        const computedHash = await hashPassword(inputPassword, saltRow.value);
        verified = await timingSafeStringCompare(computedHash, hashRow.value);
      }
    } catch (err) {
      console.error("Failed to verify D1 password:", err);
    }
  } else {
    verified = true;
  }
  if (!verified) {
    return json$2({ ok: false, errorCode: 401, description: "Invalid password", reason: "unauthorized" }, 401);
  }
  const secret = await getSigningSecret(env);
  const token = await signSessionToken(
    {
      sub: "admin",
      iat: Date.now(),
      exp: Date.now() + 30 * 24 * 60 * 60 * 1e3
      // 30 days
    },
    secret
  );
  return json$2({ ok: true, data: { token } });
}
async function handleAuthSetup(request, env) {
  const { mode, source } = await getAuthMode(env);
  if (source === "env") {
    return json$2(
      {
        ok: false,
        errorCode: 400,
        description: "Password is configured via environment variable ADMIN_PASSWORD",
        reason: "invalid_request"
      },
      400
    );
  }
  if (source === "d1") {
    const isAuthed = await isRequestAuthenticated(request, env);
    if (!isAuthed) {
      return json$2(
        {
          ok: false,
          errorCode: 401,
          description: "Existing admin password must be authenticated to reconfigure",
          reason: "unauthorized"
        },
        401
      );
    }
  }
  const body = await request.json().catch(() => ({}));
  const newPassword = typeof body.password === "string" ? body.password : "";
  if (!newPassword || newPassword.length < 4) {
    return json$2(
      {
        ok: false,
        errorCode: 400,
        description: "Password must be at least 4 characters",
        reason: "invalid_request"
      },
      400
    );
  }
  if (newPassword.length > 256) {
    return json$2(
      {
        ok: false,
        errorCode: 400,
        description: "Password exceeds maximum length (256 characters)",
        reason: "invalid_request"
      },
      400
    );
  }
  await storeAdminPassword(env, newPassword);
  const secret = await getSigningSecret(env);
  const token = await signSessionToken(
    {
      sub: "admin",
      iat: Date.now(),
      exp: Date.now() + 30 * 24 * 60 * 60 * 1e3
    },
    secret
  );
  return json$2({ ok: true, data: { token } });
}
async function handleAuthRemove(request, env) {
  const { source } = await getAuthMode(env);
  if (source === "env") {
    return json$2(
      {
        ok: false,
        errorCode: 400,
        description: "Cannot remove password managed by ADMIN_PASSWORD environment variable",
        reason: "invalid_request"
      },
      400
    );
  }
  const isAuthed = await isRequestAuthenticated(request, env);
  if (!isAuthed) {
    return json$2(
      { ok: false, errorCode: 401, description: "Authentication required", reason: "unauthorized" },
      401
    );
  }
  await clearAdminPassword(env);
  return json$2({ ok: true, data: { status: "removed" } });
}
async function storeAdminPassword(env, password) {
  const salt = generateSalt();
  const hash = await hashPassword(password, salt);
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('admin_password_hash', ?)").bind(hash),
    env.DB.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('admin_password_salt', ?)").bind(salt)
  ]);
}
async function clearAdminPassword(env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM app_settings WHERE key = 'admin_password_hash'"),
    env.DB.prepare("DELETE FROM app_settings WHERE key = 'admin_password_salt'")
  ]);
}
async function authenticateApiRequest(request, env) {
  const { mode } = await getAuthMode(env);
  if (mode === "open") {
    return null;
  }
  const authenticated = await isRequestAuthenticated(request, env);
  if (authenticated) {
    return null;
  }
  return json$2(
    {
      ok: false,
      errorCode: 401,
      description: "Admin authentication required",
      reason: "unauthorized"
    },
    401
  );
}
function taskActionPatch(task, action) {
  const patch = {};
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
async function performTaskAction(env, task, action) {
  const patch = taskActionPatch(task, action);
  if (!patch) {
    return {
      ok: false,
      description: `Nothing to ${action} — the task is ${task.backfill_status.replace(/_/g, " ")}${task.live_enabled ? " with live forwarding on" : ""}.`
    };
  }
  const result = await applyTaskPatch(env, task.id, patch);
  if (!result.ok) return { ok: false, description: result.description };
  return {
    ok: true,
    task: result.data,
    label: action === "pause" ? "Paused" : action === "resume" ? "Resumed" : "Stopped"
  };
}
async function startTaskFromSaved(env, savedId) {
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
    backfillMode: saved.backfill_mode ?? void 0,
    startId: saved.backfill_mode === "range" ? saved.start_id : void 0,
    endId: saved.backfill_mode === "range" ? saved.end_id : void 0,
    n: saved.backfill_mode === "lastN" ? saved.n ?? void 0 : void 0,
    pacingBatchSize: saved.pacing_batch_size,
    filterMediaTypes: saved.filter_media_types,
    filterMinSizeBytes: saved.filter_min_size_bytes,
    filterMaxSizeBytes: saved.filter_max_size_bytes
  });
}
const MAX_MESSAGE_LENGTH = 3800;
function clipHtml(html, limit = MAX_MESSAGE_LENGTH) {
  return html.length > limit ? `${html.slice(0, limit - 1)}…` : html;
}
function stripHtml(html) {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
}
function sendOptions(keyboard2, plain = false) {
  return {
    ...plain ? {} : { parse_mode: "HTML" },
    disable_web_page_preview: true,
    ...keyboard2 ? { reply_markup: keyboard2 } : {}
  };
}
async function botSend(ctx, html, keyboard2) {
  const text = clipHtml(html);
  try {
    await ctx.client.sendMessage(ctx.chatId, text, sendOptions(keyboard2));
    return;
  } catch (e) {
    if (e instanceof TelegramApiError && e.errorCode !== 400) return;
  }
  try {
    await ctx.client.sendMessage(ctx.chatId, stripHtml(text), sendOptions(keyboard2, true));
  } catch {
  }
}
async function botEdit(ctx, messageId, html, keyboard2) {
  const text = clipHtml(html);
  try {
    await ctx.client.editMessageText(ctx.chatId, messageId, text, sendOptions(keyboard2));
    return;
  } catch (e) {
    if (e instanceof TelegramApiError) {
      if (e.errorCode === 400 && /not modified/i.test(e.message)) return;
      if (e.errorCode !== 400) return;
    }
  }
  try {
    await ctx.client.editMessageText(ctx.chatId, messageId, stripHtml(text), sendOptions(keyboard2, true));
  } catch {
    await botSend(ctx, html, keyboard2);
  }
}
async function botReply(ctx, html) {
  await botSend(ctx, html);
}
function btn(text, callbackData) {
  return { text, callback_data: callbackData };
}
function esc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function code(value) {
  return `<code>${esc(value)}</code>`;
}
function shortId(id) {
  return id.slice(0, 8);
}
function fmtTime(seconds) {
  if (!seconds) return "—";
  const d = new Date(seconds * 1e3);
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
function pct(part, total) {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.round(part / total * 100));
}
function progressBar(part, total, width = 10) {
  const filled = total && total > 0 ? Math.min(width, Math.round(part / total * width)) : 0;
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}
const SCOPE_LABELS = {
  live: "New messages only",
  live_and_backfill: "Existing + new",
  backfill_only: "Existing only (one-time)"
};
function scopeLabel(scope) {
  return SCOPE_LABELS[scope] ?? scope;
}
function taskState(task) {
  if (task.stop_reason) return `⛔ stopped (${task.stop_reason.replace(/_/g, " ")})`;
  if (task.scope === "live_and_backfill") {
    const parts = [];
    if (task.backfill_status === "running") parts.push("📦 backfilling");
    else if (task.backfill_status === "paused") parts.push("⏸ backfill paused");
    else if (task.backfill_status === "complete") parts.push("✅ backfill complete");
    else if (task.backfill_status === "cancelled") parts.push("cancelled");
    else if (task.backfill_status === "failed") parts.push("failed");
    parts.push(task.live_enabled ? "📡 live" : "⏸ live paused");
    return parts.join(" · ");
  }
  if (task.scope === "live") return task.live_enabled ? "📡 live" : "⏸ live paused";
  switch (task.backfill_status) {
    case "running":
      return "📦 backfilling";
    case "paused":
      return "⏸ paused";
    case "complete":
      return "✅ complete";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "❌ failed";
    default:
      return "idle";
  }
}
function backfillSummary(task) {
  if (task.scope === "live" || !task.backfill_mode) return "—";
  if (task.backfill_mode === "lastN") return `last ${task.total ?? "?"} messages`;
  return `ids ${task.start_id ?? "?"}–${task.end_id ?? "?"}`;
}
function filterSummary(task) {
  const parts = [];
  if (task.filter_media_types) parts.push(`media: ${task.filter_media_types.split(",").join(", ")}`);
  if (task.filter_min_size_bytes) parts.push(`min ${formatBytes(task.filter_min_size_bytes)}`);
  if (task.filter_max_size_bytes) parts.push(`max ${formatBytes(task.filter_max_size_bytes)}`);
  return parts.length > 0 ? parts.join(" · ") : "all messages";
}
function taskLine(task, index2) {
  const prefix = "";
  return `${prefix}${code(shortId(task.id))} ${esc(task.label)}
   ${taskState(task)} · ${task.processed + task.failed} done`;
}
function taskDetailHtml(task, botUsername) {
  const scanned = task.total ? Math.min(task.total, task.processed + task.failed) : task.processed + task.failed;
  const lines = [];
  lines.push(`<b>${esc(task.label)}</b>`);
  lines.push(`${taskState(task)}`);
  lines.push("");
  lines.push(`<b>Bot</b> @${esc(botUsername)}`);
  lines.push(`<b>Source</b> ${esc(task.source_chat_title ?? task.source_chat_id)} ${code(task.source_chat_id)}`);
  lines.push(`<b>Destination</b> ${esc(task.dest_chat_title ?? task.dest_chat_id)} ${code(task.dest_chat_id)}`);
  lines.push(`<b>Scope</b> ${esc(scopeLabel(task.scope))} · pace ${task.pacing_batch_size}/min`);
  lines.push(`<b>Backfill</b> ${esc(backfillSummary(task))}`);
  if (task.scope !== "live") {
    lines.push(
      `   ${progressBar(scanned, task.total)} ${pct(scanned, task.total)}% · ${scanned}/${task.total ?? "?"} scanned`
    );
    lines.push(`   cursor ${code(task.cursor ?? "—")} · copied ${task.processed} · failed ${task.failed}`);
  }
  if (task.scope !== "backfill_only") {
    lines.push(
      `   live copied ${task.live_processed} · failed ${task.live_failed} · skipped ${task.live_skipped}${task.pending_count !== void 0 ? ` · queued ${task.pending_count}` : ""}`
    );
    lines.push(`<b>Filters</b> ${esc(filterSummary(task))}`);
  }
  if (task.stop_reason) {
    lines.push(`<b>Stopped</b> ${esc(task.stop_reason.replace(/_/g, " "))} at ${fmtTime(task.stopped_at)}`);
  }
  if (task.rate_limited_until && task.rate_limited_until > Math.floor(Date.now() / 1e3)) {
    lines.push(`<b>Cooldown</b> until ${fmtTime(task.rate_limited_until)}`);
  }
  lines.push(`<b>Created</b> ${fmtTime(task.created_at)}`);
  lines.push(`<b>ID</b> ${code(task.id)}`);
  return lines.join("\n");
}
function botLine(bot, index2, taskCount) {
  return `${index2}. <b>${esc(bot.label)}</b> @${esc(bot.bot_username)} · ${taskCount} task${taskCount === 1 ? "" : "s"}`;
}
function savedTaskLine(saved, index2) {
  const detail = saved.backfill_mode ? saved.backfill_mode === "lastN" ? `last ${saved.n ?? "?"} messages` : `ids ${saved.start_id ?? "?"}–${saved.end_id ?? "?"}` : "no backfill";
  return `${index2}. ${code(shortId(saved.id))} <b>${esc(saved.bot_label)}</b> @${esc(saved.bot_username)}
   ${esc(
    saved.source_chat_title ?? saved.source_chat_id
  )} → ${esc(saved.dest_chat_title ?? saved.dest_chat_id)}
   ${esc(scopeLabel(saved.scope))} · ${esc(detail)}`;
}
function unauthorizedHtml(userId, claimAvailable) {
  const lines = [
    "⛔ This bot only answers configured controller admins.",
    `Your Telegram user id is ${code(userId)}.`
  ];
  if (claimAvailable) {
    lines.push("This controller has no admin yet — send /claim &lt;code&gt; with the claim code to take ownership.");
  } else {
    lines.push("Add that id to the BOT_CONTROLLER_ADMIN_IDS secret, or ask an existing admin to run /admin add.");
  }
  return lines.join("\n");
}
function dedupeById(matches) {
  const seen = /* @__PURE__ */ new Set();
  return matches.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}
async function resolveBot(env, ref) {
  const bots = await listBotsWithSecrets(env.DB);
  if (bots.length === 0) return { ok: false, error: "No bots are connected yet. Add one with /botadd <token>." };
  const raw = ref.trim();
  if (!raw) return { ok: false, error: "Which bot? Give a bot id, @username, or the number from /bots." };
  if (/^\d+$/.test(raw)) {
    const index2 = Number(raw);
    if (index2 >= 1 && index2 <= bots.length) return { ok: true, value: bots[index2 - 1] };
    const byTelegramId = bots.filter((b) => b.bot_id === index2);
    if (byTelegramId.length === 1) return { ok: true, value: byTelegramId[0] };
  }
  const cleaned = raw.replace(/^@/, "").toLowerCase();
  const exact = dedupeById(
    bots.filter(
      (b) => b.id === raw || b.bot_username.toLowerCase() === cleaned || b.label.toLowerCase() === raw.toLowerCase()
    )
  );
  if (exact.length === 1) return { ok: true, value: exact[0] };
  if (cleaned.length >= 3) {
    const prefixed = dedupeById(bots.filter((b) => b.bot_username.toLowerCase().startsWith(cleaned)));
    if (prefixed.length === 1) return { ok: true, value: prefixed[0] };
    if (prefixed.length > 1) return { ok: false, error: ambiguous("bot", prefixed.map((b) => `@${b.bot_username}`)) };
  }
  if (raw.length >= 4) {
    const byId = dedupeById(bots.filter((b) => b.id.startsWith(raw)));
    if (byId.length === 1) return { ok: true, value: byId[0] };
    if (byId.length > 1) {
      return { ok: false, error: ambiguous("bot", byId.map((b) => `${shortId(b.id)} (@${b.bot_username})`)) };
    }
  }
  return { ok: false, error: `No bot matches ${raw}. Use /bots to list them.` };
}
async function resolveTask(env, ref) {
  const tasks = await listAllTasksSummary(env.DB);
  if (tasks.length === 0) return { ok: false, error: "No tasks exist yet. Create one with /newtask." };
  const raw = ref.trim();
  if (!raw) return { ok: false, error: "Which task? Give a task id or the number from /tasks." };
  if (/^\d+$/.test(raw)) {
    const index2 = Number(raw);
    if (index2 >= 1 && index2 <= tasks.length) return { ok: true, value: tasks[index2 - 1] };
  }
  const exact = dedupeById(tasks.filter((t) => t.id === raw || t.label.toLowerCase() === raw.toLowerCase()));
  if (exact.length === 1) return { ok: true, value: exact[0] };
  if (raw.length >= 4) {
    const byId = dedupeById(tasks.filter((t) => t.id.startsWith(raw)));
    if (byId.length === 1) return { ok: true, value: byId[0] };
    if (byId.length > 1) {
      return { ok: false, error: ambiguous("task", byId.map((t) => `${shortId(t.id)} ${t.label}`)) };
    }
  }
  return { ok: false, error: `No task matches ${raw}. Use /tasks to list them.` };
}
function ambiguous(kind, candidates) {
  return `That ${kind} reference matches more than one:
${candidates.map((c) => `• ${esc(c)}`).join("\n")}`;
}
function splitLead(raw, count) {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  return { head: parts.slice(0, count), rest: parts.slice(count).join(" ") };
}
function countTasksByBot(tasks) {
  const counts = /* @__PURE__ */ new Map();
  for (const task of tasks) counts.set(task.bot_id, (counts.get(task.bot_id) ?? 0) + 1);
  return counts;
}
const MODE_KEY = "bot_controller_mode";
const OFFSET_KEY = "bot_controller_offset";
const SECRET_KEY = "bot_controller_webhook_secret";
const ADMINS_KEY = "bot_controller_admins";
const SESSION_TTL_SECONDS = 15 * 60;
function getControllerToken(env) {
  const token = env.BOT_CONTROLLER_TOKEN?.trim();
  return token ? token : null;
}
async function getControllerMode(env) {
  const value = await getAppSetting(env.DB, MODE_KEY);
  return value === "webhook" ? "webhook" : "poll";
}
async function setControllerMode(env, mode) {
  await setAppSetting(env.DB, MODE_KEY, mode);
}
async function getControllerOffset(env) {
  const value = await getAppSetting(env.DB, OFFSET_KEY);
  const offset = Number(value ?? 0);
  return Number.isFinite(offset) && offset > 0 ? offset : 0;
}
async function setControllerOffset(env, nextUpdateOffset) {
  await setAppSetting(env.DB, OFFSET_KEY, String(nextUpdateOffset));
}
async function ensureWebhookSecret(env) {
  const fromEnv = env.BOT_CONTROLLER_WEBHOOK_SECRET?.trim();
  if (fromEnv) return fromEnv;
  const existing = await getAppSetting(env.DB, SECRET_KEY);
  if (existing) return existing;
  const candidate = crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)`).bind(SECRET_KEY, candidate).run();
  return await getAppSetting(env.DB, SECRET_KEY) ?? candidate;
}
async function getWebhookSecret(env) {
  const fromEnv = env.BOT_CONTROLLER_WEBHOOK_SECRET?.trim();
  if (fromEnv) return fromEnv;
  return getAppSetting(env.DB, SECRET_KEY);
}
function envAdminIds(env) {
  return (env.BOT_CONTROLLER_ADMIN_IDS ?? "").split(/[,\s]+/).map((part) => Number(part.trim())).filter((id) => Number.isInteger(id) && id > 0);
}
async function storedAdminIds(env) {
  const raw = await getAppSetting(env.DB, ADMINS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id) => Number.isInteger(id) && id > 0);
  } catch {
    return [];
  }
}
async function getAdminIds(env) {
  const ids = /* @__PURE__ */ new Set([...envAdminIds(env), ...await storedAdminIds(env)]);
  return [...ids];
}
async function isControllerAdmin(env, userId) {
  return (await getAdminIds(env)).includes(userId);
}
async function addAdminId(env, userId) {
  if (envAdminIds(env).includes(userId)) return false;
  const ids = await storedAdminIds(env);
  if (!ids.includes(userId)) {
    await setAppSetting(env.DB, ADMINS_KEY, JSON.stringify([...ids, userId]));
  }
  return true;
}
async function removeAdminId(env, userId) {
  if (envAdminIds(env).includes(userId)) return false;
  const ids = await storedAdminIds(env);
  if (!ids.includes(userId)) return false;
  const next = ids.filter((id) => id !== userId);
  if (next.length === 0) await deleteAppSetting(env.DB, ADMINS_KEY);
  else await setAppSetting(env.DB, ADMINS_KEY, JSON.stringify(next));
  return true;
}
async function getSession(env, chatId) {
  const row = await getBotControllerSession(env.DB, chatId);
  if (!row) return null;
  const now = Math.floor(Date.now() / 1e3);
  if (now - row.updated_at > SESSION_TTL_SECONDS) {
    await clearBotControllerSession(env.DB, chatId);
    return null;
  }
  try {
    const parsed = JSON.parse(row.data);
    return {
      state: row.state,
      data: parsed && typeof parsed === "object" ? parsed : {},
      updatedAt: row.updated_at
    };
  } catch {
    await clearBotControllerSession(env.DB, chatId);
    return null;
  }
}
async function saveSession(env, chatId, userId, state, data) {
  await setBotControllerSession(env.DB, chatId, userId, state, data);
}
async function dropSession(env, chatId) {
  await clearBotControllerSession(env.DB, chatId);
}
async function purgeStaleSessions(env) {
  await pruneBotControllerSessions(env.DB, SESSION_TTL_SECONDS);
}
const MEDIA_TYPES$1 = ["document", "video", "photo", "audio", "voice", "animation"];
function keyboard(...rows) {
  return { inline_keyboard: rows };
}
function truncate(text, max = 34) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function backToMenu() {
  return [btn("« Menu", "m")];
}
function cancelKeyboard() {
  return keyboard([btn("✖️ Cancel", "x")]);
}
function configKeyboard() {
  return keyboard([btn("🔐 Security", "sec"), btn("🔀 Delivery mode", "mode")], backToMenu());
}
function mainMenuKeyboard() {
  return keyboard(
    [btn("📊 Status", "s"), btn("🤖 Bots", "b")],
    [btn("📋 Tasks", "t:active:0"), btn("➕ New task", "n")],
    [btn("🗂 Templates", "p"), btn("🛠 Chat tools", "o")],
    [btn("🔐 Security", "sec"), btn("⚙️ Config", "cfg")],
    [btn("🔀 Delivery mode", "mode")]
  );
}
function botsKeyboard(bots, taskCounts) {
  const rows = bots.map((bot) => [
    btn(
      `${truncate(bot.label)} · @${bot.bot_username}${taskCounts ? ` (${taskCounts.get(bot.id) ?? 0})` : ""}`,
      `B:${shortId(bot.id)}`
    )
  ]);
  return { inline_keyboard: [...rows, [btn("➕ Add bot", "Ba")], backToMenu()] };
}
function botDetailKeyboard(botId) {
  const ref = shortId(botId);
  return keyboard(
    [btn("🔍 Inspect", `Bi:${ref}`), btn("📋 Tasks", `Bt:${ref}:0`)],
    [btn("✏️ Rename", `Br:${ref}`), btn("🔌 Webhook off", `Bu:${ref}`)],
    [btn("🗑 Delete", `Bd:${ref}`), ...backToMenu()]
  );
}
function tasksKeyboard(tasks, filter, page, total) {
  const rows = tasks.map((task) => {
    const state = taskState(task).replace(/[^\p{Letter}\p{Number} /]/gu, "").trim();
    return [btn(`${truncate(task.label)} · ${truncate(state, 12)}`, `T:${shortId(task.id)}`)];
  });
  const filters = [
    btn(filter === "active" ? "✅ Active" : "Active", "tf:active:0"),
    btn(filter === "paused" ? "✅ Paused" : "Paused", "tf:paused:0"),
    btn(filter === "done" ? "✅ Done" : "Done", "tf:done:0"),
    btn(filter === "all" ? "✅ All" : "All", "tf:all:0")
  ];
  const pager = [];
  if (page > 0) pager.push(btn("« Prev", `tf:${filter}:${page - 1}`));
  if ((page + 1) * 8 < total) pager.push(btn("Next »", `tf:${filter}:${page + 1}`));
  return {
    inline_keyboard: [
      ...rows,
      filters,
      ...pager.length > 0 ? [pager] : [],
      [btn("➕ New task", "n"), btn("« Menu", "m")]
    ]
  };
}
function taskDetailKeyboard(task) {
  const ref = shortId(task.id);
  const rows = [];
  const stateRow = [];
  if (task.backfill_status === "running" || task.live_enabled) {
    stateRow.push(btn("⏸ Pause", `Tp:${ref}`));
  }
  if (!task.live_enabled || task.scope !== "live" && task.backfill_status !== "running" && task.backfill_status !== "complete") {
    stateRow.push(btn("▶️ Resume", `Tr:${ref}`));
  }
  if (task.backfill_status === "running" || task.backfill_status === "paused" || task.live_enabled) {
    stateRow.push(btn("⏹ Stop", `Ts:${ref}`));
  }
  if (stateRow.length > 0) rows.push(stateRow);
  rows.push([btn("✏️ Edit", `Te:${ref}`), btn("🧪 Test copy", `Tt:${ref}`), btn("📜 Activity", `Ta:${ref}`)]);
  rows.push([btn("🗑 Delete", `Td:${ref}`), btn("« Tasks", `t:active:0`), btn("« Menu", "m")]);
  return { inline_keyboard: rows };
}
function activityKeyboard(taskId) {
  return keyboard([btn("« Task", `T:${shortId(taskId)}`), btn("« Tasks", "t:active:0"), btn("« Menu", "m")]);
}
function savedKeyboard(saved) {
  const rows = saved.flatMap((item) => [
    [btn(`▶️ ${truncate(item.bot_label)} · ${truncate(item.dest_chat_title ?? item.dest_chat_id, 20)}`, `Pr:${shortId(item.id)}`)],
    [btn("🗑 Delete template", `Pd:${shortId(item.id)}`)]
  ]);
  return { inline_keyboard: [...rows, backToMenu()] };
}
function toolsBotsKeyboard(bots) {
  const rows = bots.map((bot) => [btn(`${truncate(bot.label)} · @${bot.bot_username}`, `O:${shortId(bot.id)}`)]);
  return { inline_keyboard: [...rows, backToMenu()] };
}
function chatPanelKeyboard() {
  return keyboard(
    [btn("ℹ️ Info", "oc:info"), btn("🔗 Invite", "oc:invite"), btn("🕘 Latest id", "oc:latest")],
    [btn("🚫 Ban", "oc:ban"), btn("♻️ Unban", "oc:unban"), btn("⭐ Promote", "oc:promote")],
    [btn("✉️ Send test", "oc:sendtest"), btn("🧪 Copy test", "oc:copytest"), btn("🔁 Revoke", "oc:revoke")],
    [btn("🔄 Change chat", "o"), btn("« Menu", "m")]
  );
}
function securityKeyboard(mode) {
  const rows = [[btn("🔍 Auth status", "sa")]];
  if (mode !== "env") rows.push([btn("🔑 Set password", "sp")]);
  if (mode === "d1") rows.push([btn("🔓 Remove password", "sr")]);
  rows.push([btn("👥 Admins", "adm"), btn("🔀 Delivery mode", "mode")]);
  rows.push(backToMenu());
  return { inline_keyboard: rows };
}
function adminsKeyboard(ids) {
  const rows = ids.map((id) => [btn(`Remove ${id}`, `admr:${id}`)]);
  return { inline_keyboard: [...rows, [btn("➕ Add admin", "adma"), btn("« Security", "sec"), btn("« Menu", "m")]] };
}
function modeKeyboard() {
  return keyboard([btn("🐢 Cron polling", "mp"), btn("⚡ Webhook info", "mw")], backToMenu());
}
function confirmKeyboard(yesData, yesLabel = "Confirm", backData = "m") {
  return keyboard([btn(`✅ ${yesLabel}`, yesData), btn("✖️ Cancel", backData)]);
}
function newTaskBotKeyboard(bots) {
  const rows = bots.map((bot) => [
    btn(`${truncate(bot.label)} · @${bot.bot_username}`, `Nb:${shortId(bot.id)}`)
  ]);
  rows.push([btn("🔑 Add bot token", "Nbt")]);
  rows.push([btn("✖️ Cancel", "x")]);
  return { inline_keyboard: rows };
}
function scopeKeyboard(prefix, includeKeep = false) {
  const rows = [
    [btn("📡 New messages only", `${prefix}:live`)],
    [btn("📦 Existing + new", `${prefix}:both`)],
    [btn("🗄 Existing only", `${prefix}:backfill`)]
  ];
  if (includeKeep) rows.push([btn("➖ Keep current scope", `${prefix}:keep`)]);
  rows.push([btn("✖️ Cancel", "x")]);
  return { inline_keyboard: rows };
}
function backfillModeKeyboard() {
  return keyboard(
    [btn("#️⃣ Range", "Nm:range")],
    [btn("🔢 Last N", "Nm:lastN")],
    [btn("✖️ Cancel", "x")]
  );
}
function lastNKeyboard() {
  return keyboard(
    [btn("10", "Nn:10"), btn("100", "Nn:100"), btn("1,000", "Nn:1000")],
    [btn("✖️ Cancel", "x")]
  );
}
function pacingKeyboard() {
  return keyboard(
    [btn("30/min", "Np:30"), btn("60/min", "Np:60"), btn("100/min", "Np:100")],
    [btn("Default (60)", "Np:default")],
    [btn("✖️ Cancel", "x")]
  );
}
function sizePercent(value) {
  if (!value) return "0";
  return String(Math.round(value / 1048576));
}
function filterKeyboard(prefix, data) {
  const selected = new Set((data.filterMediaTypes ?? "").split(",").filter(Boolean));
  const mediaButtons = MEDIA_TYPES$1.map((type) => [
    btn(`${selected.has(type) ? "✅" : "▫️"} ${type}`, `${prefix}:m:${type}`)
  ]);
  const min = sizePercent(data.filterMinSizeBytes);
  const max = sizePercent(data.filterMaxSizeBytes);
  return {
    inline_keyboard: [
      ...mediaButtons,
      [
        btn(min === "0" ? "✅ No min" : "No min", `${prefix}:min:0`),
        btn(min === "5" ? "✅ 5 MB" : "5 MB", `${prefix}:min:5`),
        btn(min === "10" ? "✅ 10 MB" : "10 MB", `${prefix}:min:10`),
        btn(min === "50" ? "✅ 50 MB" : "50 MB", `${prefix}:min:50`)
      ],
      [
        btn(max === "0" ? "✅ No max" : "No max", `${prefix}:max:0`),
        btn(max === "100" ? "✅ 100 MB" : "100 MB", `${prefix}:max:100`),
        btn(max === "500" ? "✅ 500 MB" : "500 MB", `${prefix}:max:500`),
        btn(max === "1024" ? "✅ 1 GB" : "1 GB", `${prefix}:max:1024`)
      ],
      [btn("✅ Done", `${prefix}:done`), btn("✖️ Cancel", "x")]
    ]
  };
}
function createTaskKeyboard(hasDuplicate) {
  const rows = [[btn("🚀 Create", "Nc:create"), btn("💾 Create + save template", "Nc:save")]];
  if (hasDuplicate) rows.push([btn("⚠️ Create duplicate anyway", "Nc:again")]);
  rows.push([btn("✖️ Cancel", "x")]);
  return { inline_keyboard: rows };
}
function editResetKeyboard() {
  return keyboard([btn("Reset progress", "Er:yes"), btn("Keep progress", "Er:no")], [btn("✖️ Cancel", "x")]);
}
function editConfirmKeyboard() {
  return keyboard([btn("✅ Apply", "Ec:apply"), btn("✖️ Cancel", "x")]);
}
function keepFieldKeyboard(field) {
  return keyboard([btn("➖ Keep current", `Ekeep:${field}`)], [btn("✖️ Cancel", "x")]);
}
const PAGE_SIZE = 8;
async function mainMenuView(env) {
  const [bots, tasks] = await Promise.all([listBotsSummary(env.DB), listAllTasksSummary(env.DB)]);
  const live = tasks.filter((t) => t.live_enabled).length;
  const active = tasks.filter((t) => t.backfill_status === "running").length;
  return {
    text: [
      "<b>Telegram Clone Worker · Control</b>",
      "",
      `Bots <b>${bots.length}</b> · tasks <b>${tasks.length}</b>`,
      `Backfilling <b>${active}</b> · live <b>${live}</b>`,
      "",
      "Tap a button below, or keep using the slash commands."
    ].join("\n"),
    keyboard: mainMenuKeyboard()
  };
}
async function statusView(env) {
  const [bots, tasks, saved, controllerMode] = await Promise.all([
    listBotsSummary(env.DB),
    listAllTasksSummary(env.DB),
    listSavedTasks(env.DB),
    getControllerMode(env)
  ]);
  const live = tasks.filter((t) => t.live_enabled).length;
  const running = tasks.filter((t) => t.backfill_status === "running").length;
  const paused = tasks.filter(
    (t) => t.backfill_status === "paused" || !t.live_enabled && t.scope === "live"
  ).length;
  const complete = tasks.filter((t) => t.backfill_status === "complete").length;
  const failed = tasks.filter((t) => t.backfill_status === "failed" || t.stop_reason).length;
  const copied = tasks.reduce((sum, t) => sum + t.processed + t.live_processed, 0);
  const queued = tasks.reduce((sum, t) => sum + (t.pending_count ?? 0), 0);
  return {
    text: [
      "<b>Status</b>",
      "",
      `Bots: <b>${bots.length}</b> · tasks: <b>${tasks.length}</b> · templates: <b>${saved.length}</b>`,
      `Backfilling: <b>${running}</b> · live: <b>${live}</b> · paused: <b>${paused}</b>`,
      `Complete: <b>${complete}</b> · failed/stopped: <b>${failed}</b>`,
      `Messages copied: <b>${copied.toLocaleString()}</b> · queued live: <b>${queued}</b>`,
      "",
      `Delivery: <b>${controllerMode}</b> · cron every minute.`
    ].join("\n"),
    keyboard: {
      inline_keyboard: [
        [{ text: "📋 Tasks", callback_data: "t:active:0" }, { text: "🤖 Bots", callback_data: "b" }],
        [{ text: "« Menu", callback_data: "m" }]
      ]
    }
  };
}
async function botsView(env) {
  const [bots, tasks] = await Promise.all([listBotsSummary(env.DB), listAllTasksSummary(env.DB)]);
  if (bots.length === 0) {
    return {
      text: "No bots connected yet. Add one with its @BotFather token.",
      keyboard: {
        inline_keyboard: [
          [{ text: "➕ Add bot", callback_data: "Ba" }],
          [{ text: "➕ New task", callback_data: "n" }],
          [{ text: "« Menu", callback_data: "m" }]
        ]
      }
    };
  }
  const counts = countTasksByBot(tasks);
  return {
    text: [`<b>Connected bots (${bots.length})</b>`, "", ...bots.map((b, i) => botLine(b, i + 1, counts.get(b.id) ?? 0))].join(
      "\n"
    ),
    keyboard: botsKeyboard(bots, counts)
  };
}
async function botDetailView(env, botId) {
  const bot = await getBotWithSecrets(env.DB, botId);
  if (!bot) return null;
  const [tasks, rate] = await Promise.all([listTasksByBot(env.DB, bot.id), getBotRateLimitStats(env.DB, bot.id)]);
  const active = tasks.filter(
    (t) => t.live_enabled || t.backfill_status === "running" || t.backfill_status === "paused"
  );
  const rateText = rate.is_cooling_down ? `cooling down ${Math.ceil(rate.cooldown_seconds_remaining / 60)} min` : "not cooling down";
  const lines = [
    `<b>${esc(bot.label)}</b> @${esc(bot.bot_username)}`,
    `Bot id ${code(bot.bot_id)} · added ${fmtTime(bot.created_at)}`,
    `Tasks: <b>${tasks.length}</b> · active: <b>${active.length}</b>`,
    `Rate limits: ${esc(rateText)} · ${rate.events_last_24h} 429s in 24h`
  ];
  if (active.length > 0) {
    lines.push("", "<b>Active work</b>");
    for (const task of active.slice(0, 5)) lines.push(`• ${code(task.id.slice(0, 8))} ${esc(task.label)}`);
  }
  lines.push("", "Choose an action below.");
  return { text: lines.join("\n"), keyboard: botDetailKeyboard(bot.id) };
}
async function botInspectView(env, botId) {
  const bot = await getBotWithSecrets(env.DB, botId);
  if (!bot) return null;
  const result = await inspectBot(env.DB, new TelegramClient(bot.token), bot.id);
  if (!result.ok) {
    return {
      text: `❌ ${esc(result.description)}`,
      keyboard: { inline_keyboard: [[{ text: "« Bot", callback_data: `B:${bot.id.slice(0, 8)}` }], [{ text: "« Menu", callback_data: "m" }]] }
    };
  }
  const report = result.data;
  const lines = [
    `<b>Inspect @${esc(report.bot_username)}</b>`,
    "",
    `Webhook: <b>${report.webhook.is_active ? "active" : "none"}</b>${report.webhook.url ? ` · ${esc(report.webhook.url)}` : ""}`,
    `Pending updates: ${report.webhook.pending_update_count}`,
    `Polling conflict: <b>${report.polling_session.conflict_detected ? "yes" : "no"}</b>`,
    `Rate limits: ${report.rate_limits.is_cooling_down ? "cooling down" : "ok"} · ${report.rate_limits.events_last_24h} 429s`,
    `Active clone tasks: <b>${report.clone_worker_tasks.active_count}</b>`
  ];
  for (const task of report.clone_worker_tasks.tasks.slice(0, 4)) lines.push(taskLine(task));
  if (report.recent_activities.length > 0) {
    lines.push("", "<b>Recent updates</b>");
    for (const activity of report.recent_activities.slice(0, 4)) {
      lines.push(`${esc(activity.summary)} — ${esc(activity.chat_name)}`);
    }
  }
  return {
    text: lines.join("\n"),
    keyboard: { inline_keyboard: [[{ text: "« Bot", callback_data: `B:${bot.id.slice(0, 8)}` }], [{ text: "« Menu", callback_data: "m" }]] }
  };
}
function matchesFilter(task, filter) {
  const stopped = Boolean(task.stop_reason);
  switch (filter) {
    case "active":
      return !stopped && (task.live_enabled || task.backfill_status === "running");
    case "paused":
      return !stopped && (task.backfill_status === "paused" || !task.live_enabled && task.scope === "live");
    case "done":
      return stopped || task.backfill_status === "complete" || task.backfill_status === "cancelled" || task.backfill_status === "failed";
    default:
      return true;
  }
}
async function tasksView(env, filter, page, botId) {
  const all = await listAllTasksSummary(env.DB);
  const filtered = all.filter((task) => (botId ? task.bot_id === botId : true) && matchesFilter(task, filter));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pages - 1);
  const slice = filtered.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);
  const labels = {
    active: "Active",
    paused: "Paused",
    done: "Completed",
    all: "All"
  };
  const lines = [
    `<b>Tasks · ${labels[filter] ?? "All"}${botId ? " · bot filter" : ""}</b>`,
    "",
    filtered.length === 0 ? "Nothing here yet." : `Page ${current + 1}/${pages} · ${filtered.length} task${filtered.length === 1 ? "" : "s"}`
  ];
  if (slice.length > 0) {
    lines.push("", ...slice.map((task) => `• ${taskLine(task)}`));
  }
  return {
    text: lines.join("\n"),
    keyboard: tasksKeyboard(slice, filter, current, filtered.length)
  };
}
async function taskDetailView(env, taskId) {
  const detail = await getTaskWithBot(env.DB, taskId);
  if (!detail) return null;
  return { text: taskDetailHtml(detail, detail.bot_username), keyboard: taskDetailKeyboard(detail) };
}
async function taskActivityView(env, taskId) {
  const detail = await getTaskWithBot(env.DB, taskId);
  if (!detail) return null;
  const entries = await listActivityLog(env.DB, taskId, 10);
  const lines = [`<b>Activity · ${esc(detail.label)}</b>`, ""];
  if (entries.length === 0) {
    lines.push("No activity recorded yet.");
  } else {
    for (const entry of entries) {
      const row = entry;
      lines.push(`${row.ok ? "✅" : "❌"} ${fmtTime(row.at)} · ${esc(row.kind)}`);
      lines.push(`   ${esc(row.detail ?? row.error ?? "")}`);
    }
  }
  return { text: lines.join("\n"), keyboard: activityKeyboard(taskId) };
}
async function savedView(env) {
  const saved = await listSavedTasks(env.DB);
  if (saved.length === 0) {
    return {
      text: "No saved templates yet. Create a task with Create + save template to keep one.",
      keyboard: { inline_keyboard: [[{ text: "➕ New task", callback_data: "n" }], [{ text: "« Menu", callback_data: "m" }]] }
    };
  }
  return {
    text: [`<b>Saved templates (${saved.length})</b>`, "", ...saved.slice(0, 12).map((s, i) => savedTaskLine(s, i + 1))].join("\n"),
    keyboard: savedKeyboard(saved.slice(0, 12))
  };
}
async function toolsBotsView(env) {
  const bots = await listBotsSummary(env.DB);
  if (bots.length === 0) {
    return {
      text: "No bots connected yet.",
      keyboard: { inline_keyboard: [[{ text: "« Menu", callback_data: "m" }]] }
    };
  }
  return {
    text: "<b>Chat tools</b>\n\nChoose the bot that should act on the chat.",
    keyboard: toolsBotsKeyboard(bots)
  };
}
async function chatInfoView(env, botId, chatId) {
  const bot = await getBotWithSecrets(env.DB, botId);
  if (!bot) {
    return { text: "That bot no longer exists.", keyboard: { inline_keyboard: [[{ text: "« Tools", callback_data: "o" }]] } };
  }
  const lookup = await lookupChat(env.DB, new TelegramClient(bot.token), bot.bot_id, chatId);
  if (!lookup.ok) {
    return {
      text: `❌ ${esc(lookup.description)}`,
      keyboard: {
        inline_keyboard: [
          [{ text: "🔄 Change chat", callback_data: `O:${botId.slice(0, 8)}` }],
          [{ text: "« Menu", callback_data: "m" }]
        ]
      }
    };
  }
  const data = lookup.data;
  const lines = [
    `<b>${esc(data.chat.title ?? data.chat.username ?? data.chat.id)}</b>`,
    `Type: ${esc(data.chat.type)} · id ${code(data.chat.id)}${data.chat.username ? ` · @${esc(data.chat.username)}` : ""}`,
    `Members: ${data.memberCount ?? "unknown"} · bot status: <b>${esc(data.botStatus)}</b>`,
    "",
    "<b>Bot rights</b>",
    ...data.capabilities.map((cap) => `${cap.available ? "✅" : "❌"} ${esc(cap.label)}`)
  ];
  return { text: lines.join("\n"), keyboard: chatPanelKeyboard() };
}
async function securityView(env) {
  const auth = await getAuthMode(env);
  const admins = await getAdminIds(env);
  return {
    text: [
      "<b>Security</b>",
      "",
      `Web console auth: <b>${auth.mode}</b> via <b>${auth.source}</b>`,
      `Controller admins: <b>${admins.length}</b>`,
      "",
      auth.source === "env" ? "The console password is fixed by the ADMIN_PASSWORD secret." : auth.source === "d1" ? "The console password is stored in D1 and can be changed here." : "The console is open. Set a password to protect it."
    ].join("\n"),
    keyboard: securityKeyboard(auth.source)
  };
}
async function adminsView(env) {
  const [admins, envIds] = await Promise.all([getAdminIds(env), Promise.resolve(envAdminIds(env))]);
  const lines = ["<b>Controller admins</b>", ""];
  if (admins.length === 0) lines.push("No admins configured.");
  for (const id of admins) lines.push(`• ${code(id)}${envIds.includes(id) ? " · env" : " · stored"}`);
  lines.push("", "Env ids come from BOT_CONTROLLER_ADMIN_IDS and cannot be removed here.");
  return { text: lines.join("\n"), keyboard: adminsKeyboard(admins.filter((id) => !envIds.includes(id))) };
}
async function configView(env) {
  const [bots, tasks, auth, controllerMode, admins] = await Promise.all([
    listBotsSummary(env.DB),
    listAllTasksSummary(env.DB),
    getAuthMode(env),
    getControllerMode(env),
    getAdminIds(env)
  ]);
  return {
    text: [
      "<b>Effective configuration</b>",
      "",
      `Controller token: <b>${env.BOT_CONTROLLER_TOKEN?.trim() ? "set (env)" : "missing"}</b>`,
      `Controller mode: <b>${controllerMode}</b>`,
      `Webhook secret: <b>${env.BOT_CONTROLLER_WEBHOOK_SECRET?.trim() ? "env" : "generated/stored"}</b>`,
      `Admins: <b>${admins.length}</b>`,
      `Console auth: <b>${auth.mode}</b> via <b>${auth.source}</b>`,
      `Bots: <b>${bots.length}</b> · tasks: <b>${tasks.length}</b>`,
      "",
      "Cron trigger runs every minute."
    ].join("\n"),
    keyboard: configKeyboard()
  };
}
async function modeView(env) {
  const controllerMode = await getControllerMode(env);
  return {
    text: [
      `<b>Delivery mode: ${controllerMode}</b>`,
      "",
      controllerMode === "webhook" ? "Telegram calls this Worker instantly for each command." : "The cron poller checks for commands once a minute.",
      "",
      "Switch to polling with the button below. Webhook registration needs the authenticated setup endpoint."
    ].join("\n"),
    keyboard: modeKeyboard()
  };
}
function filterPromptView(prefix, data) {
  const selected = (data.filterMediaTypes ?? "").split(",").filter(Boolean);
  return {
    text: [
      "<b>Live message filters</b>",
      "",
      `Media: ${selected.length > 0 ? esc(selected.join(", ")) : "all"}`,
      `Min size: ${data.filterMinSizeBytes ? `${Math.round(data.filterMinSizeBytes / 1048576)} MB` : "off"}`,
      `Max size: ${data.filterMaxSizeBytes ? `${Math.round(data.filterMaxSizeBytes / 1048576)} MB` : "off"}`,
      "",
      "Filters apply to live messages only; backfill always copies everything."
    ].join("\n"),
    keyboard: filterKeyboard(prefix, data)
  };
}
function scopePromptView(prefix, keep = false) {
  return {
    text: [
      "<b>Scope</b>",
      "",
      "New messages only — live mirror",
      "Existing + new — backfill, then live",
      "Existing only — one-time backfill"
    ].join("\n"),
    keyboard: scopeKeyboard(prefix, keep)
  };
}
function modePromptView() {
  return {
    text: "<b>Backfill mode</b>\n\nRange — copy message ids start…end\nLast N — copy the newest N messages",
    keyboard: backfillModeKeyboard()
  };
}
function lastNPromptView() {
  return {
    text: "<b>Last N</b>\n\nChoose how many of the newest messages to copy, or send a number.",
    keyboard: lastNKeyboard()
  };
}
function pacingPromptView() {
  return {
    text: "<b>Pacing</b>\n\nMessages copied per minute. Choose a preset or send a number (1–100).",
    keyboard: pacingKeyboard()
  };
}
function createConfirmView(data) {
  const backfill = data.scope === "live" ? "none" : data.backfillMode === "lastN" ? `last ${data.n ?? "?"} messages` : `ids ${data.startId ?? "?"}–${data.endId ?? "?"}`;
  const filters = data.scope === "backfill_only" ? "not used (backfill only)" : data.filterMediaTypes || data.filterMinSizeBytes || data.filterMaxSizeBytes ? [
    data.filterMediaTypes ?? "all media",
    data.filterMinSizeBytes ? `min ${Math.round(data.filterMinSizeBytes / 1048576)} MB` : "",
    data.filterMaxSizeBytes ? `max ${Math.round(data.filterMaxSizeBytes / 1048576)} MB` : ""
  ].filter(Boolean).join(" · ") : "all messages";
  const lines = [
    "<b>Review the new task</b>",
    "",
    `<b>Bot</b> @${esc(data.botUsername ?? "")}`,
    `<b>Source</b> ${esc(data.sourceChatTitle ?? data.sourceChatId)} ${code(data.sourceChatId ?? "")}`,
    `<b>Destination</b> ${esc(data.destChatTitle ?? data.destChatId)} ${code(data.destChatId ?? "")}`,
    `<b>Scope</b> ${esc(data.scope ? scopeLabel(data.scope) : "")}`,
    `<b>Backfill</b> ${esc(backfill)} · pace ${data.pacingBatchSize ?? 60}/min`,
    `<b>Live filters</b> ${esc(filters)}`
  ];
  if (data.duplicateTaskId) {
    lines.push("", "⚠️ A task with this pairing already exists.");
  }
  lines.push("", "Create it?");
  return { text: lines.join("\n"), keyboard: createTaskKeyboard(Boolean(data.duplicateTaskId)) };
}
function editConfirmView(task, data) {
  const scope = data.scope ?? task.scope;
  const lines = [
    "<b>Apply these changes?</b>",
    "",
    `<b>Label</b> ${esc(data.label ?? task.label)}`,
    `<b>Scope</b> ${esc(scopeLabel(scope))}`
  ];
  if (scope !== "live") {
    lines.push(`<b>Range</b> ${data.startId ?? task.start_id ?? "?"}–${data.endId ?? task.end_id ?? "?"}`);
    lines.push(`<b>Cursor</b> ${data.cursor ?? task.cursor ?? "—"}`);
    lines.push(`<b>Reset progress</b> ${data.resetProgress ? "yes" : "no"}`);
  }
  lines.push("", "Send apply to save.");
  return { text: lines.join("\n"), keyboard: editConfirmKeyboard() };
}
function editResetView() {
  return {
    text: "<b>Progress</b>\n\nReset copied/failed counters and restart the range, or keep them?",
    keyboard: editResetKeyboard()
  };
}
function editFieldView(task, field, current) {
  const labels = {
    start: ["Start id", "the first message id to copy"],
    end: ["End id", "the last message id to copy"],
    cursor: ["Cursor", "the next message id to resume from"]
  };
  return {
    text: [
      `<b>${labels[field][0]}</b>`,
      `Current: ${code(current ?? "not set")}`,
      "",
      `Send ${labels[field][1]}, or keep it.`
    ].join("\n"),
    keyboard: keepFieldKeyboard(field)
  };
}
function newTaskBotView(bots) {
  return {
    text: bots.length > 0 ? "<b>New task · bot</b>\n\nChoose the bot that will copy messages, or add a new token." : "<b>New task · bot</b>\n\nNo bots connected yet. Add one with a bot token from @BotFather.",
    keyboard: newTaskBotKeyboard(bots)
  };
}
function botTasksView(bots, botId, tasks) {
  const bot = bots.find((b) => b.id === botId);
  return {
    text: [
      `<b>Tasks · ${esc(bot?.label ?? "bot")}</b>`,
      "",
      tasks.length === 0 ? "No tasks for this bot." : `${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
      ...tasks.slice(0, 8).map((task) => `• ${taskLine(task)}`)
    ].join("\n"),
    keyboard: {
      inline_keyboard: [
        ...tasks.slice(0, 8).map((task) => [
          { text: `📋 ${task.label.slice(0, 30)}`, callback_data: `T:${task.id.slice(0, 8)}` }
        ]),
        [
          { text: "« Bot", callback_data: `B:${botId.slice(0, 8)}` },
          { text: "« Menu", callback_data: "m" }
        ]
      ]
    }
  };
}
const MEDIA_TYPES = ["document", "video", "photo", "audio", "voice", "animation"];
function parseFilterInput(raw) {
  const text = raw.trim().toLowerCase();
  if (text === "" || text === "none" || text === "all" || text === "-") {
    return { ok: true, value: { mediaTypes: null, minBytes: null, maxBytes: null } };
  }
  let mediaTypes = null;
  let minMb = null;
  let maxMb = null;
  for (const token of text.split(/\s+/)) {
    const [key, ...valueParts] = token.split("=");
    const value = valueParts.join("=");
    if (!value) {
      return { ok: false, error: `Expected key=value, got "${token}". Example: media=document,video min=10 max=500` };
    }
    if (key === "media") {
      const types = value.split(/[,+]/).map((t) => t.trim()).filter(Boolean);
      if (types.length === 0) return { ok: false, error: "media= needs at least one type." };
      const invalid = types.filter((t) => !MEDIA_TYPES.includes(t));
      if (invalid.length > 0) {
        return { ok: false, error: `Unknown media type(s): ${invalid.join(", ")}. Allowed: ${MEDIA_TYPES.join(", ")}.` };
      }
      mediaTypes = types;
    } else if (key === "min" || key === "max") {
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0) return { ok: false, error: `${key} must be a non-negative number of MB.` };
      if (key === "min") minMb = num;
      else maxMb = num;
    } else {
      return { ok: false, error: `Unknown filter "${key}". Use media=, min=, max=.` };
    }
  }
  if (minMb !== null && maxMb !== null && minMb > maxMb) {
    return { ok: false, error: "min cannot be greater than max." };
  }
  return {
    ok: true,
    value: {
      mediaTypes: mediaTypes ? mediaTypes.join(",") : null,
      minBytes: minMb === null ? null : Math.round(minMb * 1024 * 1024),
      maxBytes: maxMb === null ? null : Math.round(maxMb * 1024 * 1024)
    }
  };
}
function wizardDataOf(session) {
  return session.data;
}
function isBotToken(text) {
  return /^\d+:[A-Za-z0-9_-]{20,}$/.test(text.trim());
}
function chatTitle(lookup) {
  if (!lookup.ok) return { id: "", title: null };
  const chat = lookup.data.chat;
  return {
    id: String(chat.id),
    title: chat.title ?? (chat.username ? `@${chat.username}` : null)
  };
}
async function show(ctx, state, data, view, edit) {
  await saveSession(ctx.env, ctx.chatId, ctx.userId, state, data);
  if (edit === void 0) await botSend(ctx, view.text, view.keyboard);
  else await botEdit(ctx, edit, view.text, view.keyboard);
}
async function startNewTaskWizard(ctx, edit) {
  const bots = await listBotsSummary(ctx.env.DB);
  await show(ctx, "newtask:bot", {}, newTaskBotView(bots), edit);
}
async function startEditTaskWizard(ctx, task, edit) {
  const data = {
    taskId: task.id,
    label: task.label,
    filterMediaTypes: task.filter_media_types,
    filterMinSizeBytes: task.filter_min_size_bytes,
    filterMaxSizeBytes: task.filter_max_size_bytes
  };
  await show(
    ctx,
    "taskedit:label",
    data,
    {
      text: [
        `<b>Edit ${esc(task.label)}</b>`,
        "",
        "<b>Step 1/7 · label</b>",
        `Current: ${esc(task.label)}`,
        "Send a new label, or tap Cancel to abort."
      ].join("\n"),
      keyboard: cancelKeyboard()
    },
    edit
  );
}
async function promptSource(ctx, data, edit) {
  await show(
    ctx,
    "newtask:source",
    data,
    {
      text: [
        "<b>Step 2/8 · source chat</b>",
        `Bot: @${esc(data.botUsername ?? "")}`,
        "",
        "Send the source channel/group id (e.g. <code>-1001234567890</code>) or @username.",
        "The bot must already be a member with access to its history."
      ].join("\n"),
      keyboard: cancelKeyboard()
    },
    edit
  );
}
async function promptDest(ctx, data, edit) {
  await show(
    ctx,
    "newtask:dest",
    data,
    {
      text: [
        "<b>Step 3/8 · destination chat</b>",
        `Source: ${esc(data.sourceChatTitle ?? data.sourceChatId ?? "")}`,
        "",
        "Send the destination channel/group id or @username.",
        "The bot must be an admin allowed to post there."
      ].join("\n"),
      keyboard: cancelKeyboard()
    },
    edit
  );
}
async function promptScope(ctx, data, edit) {
  await show(ctx, "newtask:scope", data, scopePromptView("Ns"), edit);
}
async function promptMode(ctx, data, edit) {
  await show(ctx, "newtask:mode", data, modePromptView(), edit);
}
async function promptRange(ctx, data, edit) {
  await show(
    ctx,
    "newtask:range",
    data,
    {
      text: "<b>Step 6/8 · range</b>\n\nSend start and end message ids, e.g. <code>1 50000</code>.",
      keyboard: cancelKeyboard()
    },
    edit
  );
}
async function promptLastN(ctx, data, edit) {
  await show(ctx, "newtask:lastn", data, lastNPromptView(), edit);
}
async function promptPacing(ctx, data, edit) {
  await show(ctx, "newtask:pacing", data, pacingPromptView(), edit);
}
async function promptFilter(ctx, data, edit) {
  if (data.scope === "backfill_only") {
    await promptConfirm(ctx, data, edit);
    return;
  }
  await show(ctx, "newtask:filter", data, filterPromptView("Nf", data), edit);
}
async function promptConfirm(ctx, data, edit) {
  await show(ctx, "newtask:confirm", data, createConfirmView(data), edit);
}
function taskStateShort(task) {
  if (task.stop_reason) return "stopped";
  if (task.live_enabled && task.backfill_status === "running") return "live + backfill running";
  if (task.live_enabled) return "live";
  if (task.backfill_status === "running") return "backfill running";
  return task.backfill_status.replace(/_/g, " ");
}
async function completeNewTask(ctx, data, saveTemplate) {
  if (!data.botId || !data.sourceChatId || !data.destChatId || !data.scope) {
    await dropSession(ctx.env, ctx.chatId);
    await botSend(ctx, "That wizard state was incomplete — start again with /newtask or the New task button.");
    return;
  }
  const wantsBackfill = data.scope !== "live";
  const input = {
    sourceChatId: data.sourceChatId,
    sourceChatTitle: data.sourceChatTitle ?? void 0,
    destChatId: data.destChatId,
    destChatTitle: data.destChatTitle ?? void 0,
    scope: data.scope,
    backfillMode: wantsBackfill ? data.backfillMode ?? "range" : void 0,
    startId: wantsBackfill && data.backfillMode !== "lastN" ? data.startId : void 0,
    endId: wantsBackfill && data.backfillMode !== "lastN" ? data.endId : void 0,
    n: wantsBackfill && data.backfillMode === "lastN" ? data.n : void 0,
    pacingBatchSize: data.pacingBatchSize,
    saveTemplate,
    allowDuplicate: data.allowDuplicate,
    filterMediaTypes: data.filterMediaTypes ?? void 0,
    filterMinSizeBytes: data.filterMinSizeBytes ?? void 0,
    filterMaxSizeBytes: data.filterMaxSizeBytes ?? void 0
  };
  const result = await createTask(ctx.env, data.botId, input);
  if (!result.ok) {
    if (result.errorCode === 409 && result.duplicateTaskId) {
      data.duplicateTaskId = result.duplicateTaskId;
      await promptConfirm(ctx, data);
      return;
    }
    await botSend(ctx, `❌ ${esc(result.description)}

Adjust the wizard or tap Cancel.`);
    return;
  }
  await dropSession(ctx.env, ctx.chatId);
  const task = result.data;
  await botSend(
    ctx,
    task ? [
      "✅ <b>Task created</b>",
      "",
      `<b>${esc(task.label)}</b>`,
      `<b>ID</b> ${code(task.id)}`,
      `<b>Scope</b> ${esc(scopeLabel(task.scope))} · ${esc(taskStateShort(task))}`,
      "",
      "Open it with the button below."
    ].join("\n") : "✅ Task created, but it could not be re-read. Use /tasks to find it.",
    task ? { inline_keyboard: [[{ text: "📋 Open task", callback_data: `T:${shortId(task.id)}` }], [{ text: "« Menu", callback_data: "m" }]] } : void 0
  );
}
async function currentEditTask(ctx, data) {
  if (!data.taskId) return null;
  const task = await getTask(ctx.env.DB, data.taskId);
  if (!task) {
    await dropSession(ctx.env, ctx.chatId);
    await botSend(ctx, "That task no longer exists. Edit cancelled.");
    return null;
  }
  return task;
}
function editTargetScope(data, task) {
  return data.scope ?? task.scope;
}
async function promptEditScope(ctx, data, task, edit) {
  await show(ctx, "taskedit:scope", data, scopePromptView("Es", true), edit);
}
async function promptEditStart(ctx, data, task, edit) {
  await show(ctx, "taskedit:start", data, editFieldView(task, "start", task.start_id), edit);
}
async function promptEditEnd(ctx, data, task, edit) {
  await show(ctx, "taskedit:end", data, editFieldView(task, "end", task.end_id), edit);
}
async function promptEditCursor(ctx, data, task, edit) {
  await show(ctx, "taskedit:cursor", data, editFieldView(task, "cursor", task.cursor), edit);
}
async function promptEditReset(ctx, data, edit) {
  await show(ctx, "taskedit:reset", data, editResetView(), edit);
}
async function promptEditFilter(ctx, data, task, edit) {
  if (editTargetScope(data, task) === "backfill_only") {
    await promptEditConfirm(ctx, data, task, edit);
    return;
  }
  await show(ctx, "taskedit:filter", data, filterPromptView("Ef", data), edit);
}
async function promptEditConfirm(ctx, data, task, edit) {
  await show(ctx, "taskedit:confirm", data, editConfirmView(task, data), edit);
}
async function completeEditTask(ctx, data, task) {
  const patch = {
    label: data.label,
    scope: data.scope,
    startId: data.startId,
    endId: data.endId,
    cursor: data.cursor,
    resetProgress: data.resetProgress
  };
  if (data.filtersTouched) {
    patch.filterMediaTypes = data.filterMediaTypes ?? null;
    patch.filterMinSizeBytes = data.filterMinSizeBytes ?? null;
    patch.filterMaxSizeBytes = data.filterMaxSizeBytes ?? null;
  }
  const result = await applyTaskPatch(ctx.env, task.id, patch);
  if (!result.ok) {
    await botSend(ctx, `❌ ${esc(result.description)}`);
    return;
  }
  await dropSession(ctx.env, ctx.chatId);
  const updated = await getTaskWithBot(ctx.env.DB, task.id);
  await botSend(
    ctx,
    updated ? `✅ <b>Task updated</b>

${esc(updated.label)} · ${esc(taskStateShort(updated))}
<code>${esc(updated.id)}</code>` : "✅ Task updated.",
    {
      inline_keyboard: [[{ text: "📋 Open task", callback_data: `T:${shortId(task.id)}` }], [{ text: "« Menu", callback_data: "m" }]]
    }
  );
}
function parseScopeInput(text) {
  const value = text.trim().toLowerCase();
  if (["1", "live", "live_only", "new", "messages"].includes(value)) return "live";
  if (["2", "both", "all", "live_and_backfill", "live+backfill"].includes(value)) return "live_and_backfill";
  if (["3", "backfill", "backfill_only", "history", "existing"].includes(value)) return "backfill_only";
  return null;
}
async function advanceWizard(ctx, session) {
  const data = wizardDataOf(session);
  const text = ctx.text.trim();
  switch (session.state) {
    case "newtask:bot": {
      if (isBotToken(text)) {
        await ctx.client.deleteMessage(ctx.chatId, ctx.messageId).catch(() => void 0);
        const existing = await findBotByTokenOrBotId(ctx.env.DB, text);
        if (existing) {
          data.botId = existing.id;
          data.botUsername = existing.bot_username;
          await botSend(ctx, `Using the already connected bot @${esc(existing.bot_username)}.`);
        } else {
          const created = await createBotRecord(ctx.env, "", text);
          if (!created.ok) {
            await botSend(ctx, `❌ ${esc(created.description)}

Send a valid bot token, or tap Cancel.`);
            return;
          }
          data.botId = created.data.id;
          data.botUsername = created.data.bot_username;
          await botSend(ctx, `✅ Connected @${esc(created.data.bot_username)}.`);
        }
      } else {
        const found = await resolveBot(ctx.env, text);
        if (!found.ok) {
          await botSend(ctx, `❌ ${esc(found.error)}`);
          return;
        }
        data.botId = found.value.id;
        data.botUsername = found.value.bot_username;
      }
      await promptSource(ctx, data);
      return;
    }
    case "newtask:source":
    case "newtask:dest": {
      if (!data.botId) {
        await dropSession(ctx.env, ctx.chatId);
        await botSend(ctx, "Wizard state was lost — start again with /newtask.");
        return;
      }
      const bot = await resolveBot(ctx.env, data.botId);
      if (!bot.ok) {
        await dropSession(ctx.env, ctx.chatId);
        await botSend(ctx, `❌ ${esc(bot.error)}`);
        return;
      }
      const client = new TelegramClient(bot.value.token);
      const lookup = await lookupChat(ctx.env.DB, client, bot.value.bot_id, text);
      if (!lookup.ok) {
        await botSend(ctx, `❌ Cannot access ${esc(text)}: ${esc(lookup.description)}`);
        return;
      }
      const resolved = chatTitle(lookup);
      if (session.state === "newtask:source") {
        data.sourceChatId = resolved.id;
        data.sourceChatTitle = resolved.title;
        await promptDest(ctx, data);
      } else {
        data.destChatId = resolved.id;
        data.destChatTitle = resolved.title;
        const send = lookup.data.capabilities.find((c) => c.key === "send_message");
        data.destWarning = send && !send.available ? send.reason : void 0;
        await promptScope(ctx, data);
      }
      return;
    }
    case "newtask:scope": {
      const scope = parseScopeInput(text);
      if (!scope) {
        await botSend(ctx, "Reply 1, 2 or 3, or use the buttons.");
        return;
      }
      data.scope = scope;
      if (scope === "live") await promptPacing(ctx, data);
      else await promptMode(ctx, data);
      return;
    }
    case "newtask:mode": {
      const value = text.toLowerCase();
      if (["1", "range"].includes(value)) data.backfillMode = "range";
      else if (["2", "lastn", "last", "n"].includes(value)) data.backfillMode = "lastN";
      else {
        await botSend(ctx, "Reply 1 for range or 2 for last N, or use the buttons.");
        return;
      }
      if (data.backfillMode === "range") await promptRange(ctx, data);
      else await promptLastN(ctx, data);
      return;
    }
    case "newtask:range": {
      const numbers = (text.match(/\d+/g) ?? []).map(Number);
      if (numbers.length !== 2 || numbers[0] < 1 || numbers[0] > numbers[1]) {
        await botSend(ctx, "Send two message ids with start ≤ end, e.g. <code>1 50000</code>.");
        return;
      }
      data.startId = numbers[0];
      data.endId = numbers[1];
      await promptPacing(ctx, data);
      return;
    }
    case "newtask:lastn": {
      const n = Number(text);
      if (!Number.isInteger(n) || n < 1 || n > 1e6) {
        await botSend(ctx, "Send a whole number between 1 and 1,000,000.");
        return;
      }
      data.n = n;
      await promptPacing(ctx, data);
      return;
    }
    case "newtask:pacing": {
      if (/^(default|auto)$/i.test(text)) {
        data.pacingBatchSize = void 0;
      } else {
        const n = Number(text);
        if (!Number.isInteger(n) || n < 1 || n > 100) {
          await botSend(ctx, "Send a whole number from 1 to 100, or choose Default.");
          return;
        }
        data.pacingBatchSize = n;
      }
      if (data.scope === "backfill_only") await promptConfirm(ctx, data);
      else await promptFilter(ctx, data);
      return;
    }
    case "newtask:filter": {
      const parsed = parseFilterInput(text);
      if (!parsed.ok) {
        await botSend(ctx, `❌ ${esc(parsed.error)}`);
        return;
      }
      data.filterMediaTypes = parsed.value.mediaTypes;
      data.filterMinSizeBytes = parsed.value.minBytes;
      data.filterMaxSizeBytes = parsed.value.maxBytes;
      await promptConfirm(ctx, data);
      return;
    }
    case "newtask:confirm": {
      const value = text.toLowerCase();
      if (["create", "start", "yes", "go"].includes(value)) {
        await completeNewTask(ctx, data, false);
        return;
      }
      if (["save", "template", "savetemplate"].includes(value)) {
        await completeNewTask(ctx, data, true);
        return;
      }
      if (value === "again" && data.duplicateTaskId) {
        data.allowDuplicate = true;
        await completeNewTask(ctx, data, false);
        return;
      }
      await botSend(ctx, "Choose Create or Create + save template, or tap Cancel.");
      return;
    }
    case "taskedit:label": {
      const task = await currentEditTask(ctx, data);
      if (!task) return;
      if (text !== "-") data.label = text;
      await promptEditScope(ctx, data);
      return;
    }
    case "taskedit:scope": {
      const task = await currentEditTask(ctx, data);
      if (!task) return;
      if (text !== "-") {
        const scope = parseScopeInput(text);
        if (!scope) {
          await botSend(ctx, "Reply 1, 2, 3 or - to keep, or use the buttons.");
          return;
        }
        data.scope = scope;
      }
      if (editTargetScope(data, task) === "live") await promptEditFilter(ctx, data, task);
      else await promptEditStart(ctx, data, task);
      return;
    }
    case "taskedit:start": {
      const task = await currentEditTask(ctx, data);
      if (!task) return;
      if (text !== "-") {
        const n = Number(text);
        if (!Number.isInteger(n) || n < 1) {
          await botSend(ctx, "Send a positive message id, or use Keep current.");
          return;
        }
        data.startId = n;
      }
      if ((data.startId ?? task.start_id) === null) {
        await botSend(ctx, "A start id is required for backfill — send a number.");
        return;
      }
      await promptEditEnd(ctx, data, task);
      return;
    }
    case "taskedit:end": {
      const task = await currentEditTask(ctx, data);
      if (!task) return;
      if (text !== "-") {
        const n = Number(text);
        if (!Number.isInteger(n) || n < 1) {
          await botSend(ctx, "Send a positive message id, or use Keep current.");
          return;
        }
        data.endId = n;
      }
      if ((data.endId ?? task.end_id) === null) {
        await botSend(ctx, "An end id is required for backfill — send a number.");
        return;
      }
      await promptEditCursor(ctx, data, task);
      return;
    }
    case "taskedit:cursor": {
      const task = await currentEditTask(ctx, data);
      if (!task) return;
      if (text !== "-") {
        const n = Number(text);
        if (!Number.isInteger(n) || n < 0) {
          await botSend(ctx, "Send a non-negative message id, or use Keep current.");
          return;
        }
        data.cursor = n;
      }
      await promptEditReset(ctx, data);
      return;
    }
    case "taskedit:reset": {
      const task = await currentEditTask(ctx, data);
      if (!task) return;
      const value = text.toLowerCase();
      if (!["yes", "no", "y", "n"].includes(value)) {
        await botSend(ctx, "Choose Reset progress or Keep progress.");
        return;
      }
      data.resetProgress = value === "yes" || value === "y";
      await promptEditFilter(ctx, data, task);
      return;
    }
    case "taskedit:filter": {
      const task = await currentEditTask(ctx, data);
      if (!task) return;
      if (text !== "-") {
        const parsed = parseFilterInput(text);
        if (!parsed.ok) {
          await botSend(ctx, `❌ ${esc(parsed.error)}`);
          return;
        }
        data.filtersTouched = true;
        data.filterMediaTypes = parsed.value.mediaTypes;
        data.filterMinSizeBytes = parsed.value.minBytes;
        data.filterMaxSizeBytes = parsed.value.maxBytes;
      }
      await promptEditConfirm(ctx, data, task);
      return;
    }
    case "taskedit:confirm": {
      const task = await currentEditTask(ctx, data);
      if (!task) return;
      if (text.toLowerCase() !== "apply") {
        await botSend(ctx, "Tap Apply to save, or Cancel to abort.");
        return;
      }
      await completeEditTask(ctx, data, task);
      return;
    }
    default: {
      await dropSession(ctx.env, ctx.chatId);
      await botSend(ctx, "That wizard state is no longer valid — start again with /newtask.");
    }
  }
}
async function askConfirm(ctx, action, payload, text) {
  await saveSession(ctx.env, ctx.chatId, ctx.userId, `confirm:${action}`, payload);
  await botSend(ctx, `${text}

Confirm or cancel.`, confirmKeyboard("cy", "Confirm", "cn"));
}
async function cancelConfirmation(ctx) {
  await dropSession(ctx.env, ctx.chatId);
  await botSend(ctx, "Cancelled.");
}
async function runConfirmation(ctx) {
  const session = await getSession(ctx.env, ctx.chatId);
  if (!session || !session.state.startsWith("confirm:")) {
    await botSend(ctx, "Nothing to confirm.");
    return;
  }
  const action = session.state.slice("confirm:".length);
  await dropSession(ctx.env, ctx.chatId);
  if (action === "taskdelete") {
    const taskId = String(session.data.taskId ?? "");
    const task = await getTask(ctx.env.DB, taskId);
    if (!task) {
      await botSend(ctx, "That task no longer exists.");
      return;
    }
    await deleteTask(ctx.env.DB, taskId);
    await botSend(ctx, `🗑 Deleted <b>${esc(task.label)}</b>.`);
    return;
  }
  if (action === "botremove") {
    const botId = String(session.data.botId ?? "");
    const bot = await getBotWithSecrets(ctx.env.DB, botId);
    if (!bot) {
      await botSend(ctx, "That bot no longer exists.");
      return;
    }
    await toResult(() => new TelegramClient(bot.token).deleteWebhook(false));
    await deleteBot(ctx.env.DB, botId);
    await botSend(ctx, `🗑 Deleted @${esc(bot.bot_username)} and its tasks.`);
    return;
  }
  if (action === "saveddel") {
    const savedId = String(session.data.savedId ?? "");
    await deleteSavedTask(ctx.env.DB, savedId);
    await botSend(ctx, "🗑 Saved template deleted. Running tasks were not touched.");
    return;
  }
  if (action === "authremove") {
    await clearAdminPassword(ctx.env);
    await botSend(ctx, "🔓 Web console password removed — the console is now open.");
    return;
  }
  await botSend(ctx, "Unknown confirmation.");
}
async function handleControllerCallback(env, query) {
  const token = getControllerToken(env);
  if (!token) return;
  const client = new TelegramClient(token);
  if (!query.message) {
    await client.answerCallbackQuery(query.id).catch(() => void 0);
    return;
  }
  const ctx = {
    env,
    client,
    chatId: query.message.chat.id,
    messageId: query.message.message_id,
    userId: query.from.id,
    text: ""
  };
  if (!await isControllerAdmin(env, query.from.id)) {
    await client.answerCallbackQuery(query.id, "Not authorized", true).catch(() => void 0);
    return;
  }
  await client.answerCallbackQuery(query.id).catch(() => void 0);
  try {
    await route(ctx, query.data ?? "");
  } catch (e) {
    console.error("controller callback failed", query.data, e);
    await botSend(ctx, `❌ ${e instanceof Error ? e.message : String(e)}`);
  }
}
async function viewOrError(ctx, view, message = "Not found.") {
  if (!view) {
    await botEdit(ctx, ctx.messageId, `❌ ${message}`, {
      inline_keyboard: [[{ text: "« Menu", callback_data: "m" }]]
    });
    return;
  }
  await botEdit(ctx, ctx.messageId, view.text, view.keyboard);
}
async function currentSession(ctx) {
  return getSession(ctx.env, ctx.chatId);
}
async function requireNewTaskData(ctx) {
  const session = await currentSession(ctx);
  if (!session || !session.state.startsWith("newtask:")) {
    await botSend(ctx, "That wizard expired — tap New task to start again.", {
      inline_keyboard: [[{ text: "➕ New task", callback_data: "n" }], [{ text: "« Menu", callback_data: "m" }]]
    });
    return null;
  }
  return wizardDataOf(session);
}
async function saveAndEdit(ctx, state, data, view) {
  await saveSession(ctx.env, ctx.chatId, ctx.userId, state, data);
  await botEdit(ctx, ctx.messageId, view.text, view.keyboard);
}
async function taskForEdit(ctx, data) {
  if (!data.taskId) return null;
  return getTask(ctx.env.DB, data.taskId);
}
async function route(ctx, data) {
  const [kind, a, b] = data.split(":");
  switch (kind) {
    case "m":
      return viewOrError(ctx, await mainMenuView(ctx.env));
    case "s":
      return viewOrError(ctx, await statusView(ctx.env));
    case "b":
      return viewOrError(ctx, await botsView(ctx.env));
    case "Ba": {
      await saveSession(ctx.env, ctx.chatId, ctx.userId, "bot:add", {});
      return botEdit(
        ctx,
        ctx.messageId,
        "<b>Add bot</b>\n\nSend the bot token from @BotFather. The message is deleted after it is processed.",
        { inline_keyboard: [[{ text: "« Bots", callback_data: "b" }], [{ text: "✖️ Cancel", callback_data: "x" }]] }
      );
    }
    case "cfg":
      return viewOrError(ctx, await configView(ctx.env));
    case "mode":
      return viewOrError(ctx, await modeView(ctx.env));
    case "mp": {
      await ctx.client.deleteWebhook(false).catch(() => void 0);
      await setControllerMode(ctx.env, "poll");
      return viewOrError(ctx, await modeView(ctx.env));
    }
    case "mw":
      await botSend(
        ctx,
        "To switch to webhook mode, call the authenticated endpoint <code>POST /api/bot-controller/setup</code>. It registers this Worker's URL with Telegram and flips the mode."
      );
      return;
    case "x": {
      await dropSession(ctx.env, ctx.chatId);
      return viewOrError(ctx, await mainMenuView(ctx.env));
    }
    case "cy": {
      await runConfirmation(ctx);
      return viewOrError(ctx, await mainMenuView(ctx.env));
    }
    case "cn": {
      await cancelConfirmation(ctx);
      return viewOrError(ctx, await mainMenuView(ctx.env));
    }
    case "B": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) {
        return botEdit(ctx, ctx.messageId, `❌ ${bot.error}`, { inline_keyboard: [[{ text: "« Bots", callback_data: "b" }]] });
      }
      return viewOrError(ctx, await botDetailView(ctx.env, bot.value.id));
    }
    case "Bi": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) {
        return botEdit(ctx, ctx.messageId, `❌ ${bot.error}`, { inline_keyboard: [[{ text: "« Bots", callback_data: "b" }]] });
      }
      return viewOrError(ctx, await botInspectView(ctx.env, bot.value.id));
    }
    case "Bu": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) return;
      await toResult(() => new TelegramClient(bot.value.token).deleteWebhook(false));
      return viewOrError(ctx, await botDetailView(ctx.env, bot.value.id));
    }
    case "Bd": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) return;
      const tasks = await listTasksByBot(ctx.env.DB, bot.value.id);
      return botEdit(
        ctx,
        ctx.messageId,
        `<b>Delete @${bot.value.bot_username}?</b>

This disconnects its webhook and permanently deletes <b>${tasks.length}</b> task${tasks.length === 1 ? "" : "s"} that use it.`,
        confirmKeyboard(`Bdc:${shortId(bot.value.id)}`, "Delete bot", "b")
      );
    }
    case "Bdc": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) return;
      await toResult(() => new TelegramClient(bot.value.token).deleteWebhook(false));
      await deleteBot(ctx.env.DB, bot.value.id);
      return viewOrError(ctx, await botsView(ctx.env));
    }
    case "Br": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) return;
      await saveSession(ctx.env, ctx.chatId, ctx.userId, "bot:rename", { botId: bot.value.id });
      return botEdit(
        ctx,
        ctx.messageId,
        `<b>Rename @${esc(bot.value.bot_username)}</b>

Current label: ${esc(bot.value.label)}
Send the new label.`,
        { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: `B:${shortId(bot.value.id)}` }]] }
      );
    }
    case "Bt": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) return;
      const [tasks, bots] = await Promise.all([listTasksByBot(ctx.env.DB, bot.value.id), listBotsSummary(ctx.env.DB)]);
      return viewOrError(ctx, botTasksView(bots, bot.value.id, tasks));
    }
    case "t":
    case "tf":
      return viewOrError(ctx, await tasksView(ctx.env, a || "active", Number(b) || 0));
    case "T": {
      const task = await resolveTask(ctx.env, a);
      if (!task.ok) {
        return botEdit(ctx, ctx.messageId, `❌ ${task.error}`, { inline_keyboard: [[{ text: "« Tasks", callback_data: "t:active:0" }]] });
      }
      return viewOrError(ctx, await taskDetailView(ctx.env, task.value.id));
    }
    case "Tp":
    case "Tr":
    case "Ts": {
      const task = await resolveTask(ctx.env, a);
      if (!task.ok) return;
      const action = kind === "Tp" ? "pause" : kind === "Tr" ? "resume" : "stop";
      const result = await performTaskAction(ctx.env, task.value, action);
      if (!result.ok) {
        await botSend(ctx, `❌ ${esc(result.description)}`);
      }
      return viewOrError(ctx, await taskDetailView(ctx.env, task.value.id));
    }
    case "Tt": {
      const task = await resolveTask(ctx.env, a);
      if (!task.ok) return;
      const bot = await getBotWithSecrets(ctx.env.DB, task.value.bot_id);
      if (!bot) {
        await botSend(ctx, "That task's bot row is missing.");
        return;
      }
      const client = new TelegramClient(bot.token);
      const result = await toResult(async () => {
        const latest = await resolveLastN(client, task.value.source_chat_id, 1);
        const copy = await client.copyMessage(task.value.dest_chat_id, task.value.source_chat_id, latest.endId);
        return { sourceId: latest.endId, messageId: copy.message_id };
      });
      await botSend(
        ctx,
        result.ok ? `✅ Copied message ${result.data.sourceId} → destination (new message ${result.data.messageId}).` : `❌ ${esc(result.description)}`
      );
      return viewOrError(ctx, await taskDetailView(ctx.env, task.value.id));
    }
    case "Ta": {
      const task = await resolveTask(ctx.env, a);
      if (!task.ok) return;
      return viewOrError(ctx, await taskActivityView(ctx.env, task.value.id));
    }
    case "Te": {
      const task = await resolveTask(ctx.env, a);
      if (!task.ok) return;
      return startEditTaskWizard(ctx, task.value, ctx.messageId);
    }
    case "Td": {
      const task = await resolveTask(ctx.env, a);
      if (!task.ok) return;
      return botEdit(
        ctx,
        ctx.messageId,
        `<b>Delete "${esc(task.value.label)}"?</b>

This removes the task and its activity log permanently. The bot and chats stay untouched.`,
        confirmKeyboard(`Tdc:${shortId(task.value.id)}`, "Delete task", "t:active:0")
      );
    }
    case "Tdc": {
      const task = await resolveTask(ctx.env, a);
      if (!task.ok) return;
      await deleteTask(ctx.env.DB, task.value.id);
      return viewOrError(ctx, await tasksView(ctx.env, "active", 0));
    }
    case "Tl": {
      const task = await resolveTask(ctx.env, a);
      if (!task.ok) return;
      await saveSession(ctx.env, ctx.chatId, ctx.userId, "task:label", { taskId: task.value.id });
      return botEdit(
        ctx,
        ctx.messageId,
        `<b>Rename task</b>

Current: ${esc(task.value.label)}
Send the new label.`,
        { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: `T:${shortId(task.value.id)}` }]] }
      );
    }
    case "n":
      return startNewTaskWizard(ctx, ctx.messageId);
    case "Nb": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) return;
      const session = await currentSession(ctx);
      const data2 = session && session.state.startsWith("newtask:") ? wizardDataOf(session) : {};
      data2.botId = bot.value.id;
      data2.botUsername = bot.value.bot_username;
      return promptSource(ctx, data2, ctx.messageId);
    }
    case "Nbt": {
      await saveSession(ctx.env, ctx.chatId, ctx.userId, "newtask:bot", {});
      return botEdit(
        ctx,
        ctx.messageId,
        "<b>New task · add bot</b>\n\nSend the bot token from @BotFather. The message is deleted after it is processed.",
        { inline_keyboard: [[{ text: "« Back", callback_data: "n" }], [{ text: "✖️ Cancel", callback_data: "x" }]] }
      );
    }
    case "Ns": {
      const data2 = await requireNewTaskData(ctx);
      if (!data2) return;
      data2.scope = a === "live" ? "live" : a === "both" ? "live_and_backfill" : "backfill_only";
      if (data2.scope === "live") return promptPacing(ctx, data2, ctx.messageId);
      return promptMode(ctx, data2, ctx.messageId);
    }
    case "Nm": {
      const data2 = await requireNewTaskData(ctx);
      if (!data2) return;
      data2.backfillMode = a === "lastN" ? "lastN" : "range";
      if (data2.backfillMode === "range") return promptRange(ctx, data2, ctx.messageId);
      return promptLastN(ctx, data2, ctx.messageId);
    }
    case "Nn": {
      const data2 = await requireNewTaskData(ctx);
      if (!data2) return;
      data2.n = Number(a);
      return promptPacing(ctx, data2, ctx.messageId);
    }
    case "Np": {
      const data2 = await requireNewTaskData(ctx);
      if (!data2) return;
      data2.pacingBatchSize = a === "default" ? void 0 : Number(a);
      if (data2.scope === "backfill_only") return promptConfirm(ctx, data2, ctx.messageId);
      return promptFilter(ctx, data2, ctx.messageId);
    }
    case "Nf": {
      const data2 = await requireNewTaskData(ctx);
      if (!data2) return;
      if (a === "m" && b) {
        toggleMedia(data2, b);
      } else if (a === "min") {
        data2.filterMinSizeBytes = mbToBytes(Number(b));
        if (data2.filterMinSizeBytes === null) {
          data2.filterMinSizeBytes = null;
        }
      } else if (a === "max") {
        data2.filterMaxSizeBytes = mbToBytes(Number(b));
      } else if (a === "done") {
        return promptConfirm(ctx, data2, ctx.messageId);
      }
      return saveAndEdit(ctx, "newtask:filter", data2, filterPromptView("Nf", data2));
    }
    case "Nc": {
      const session = await currentSession(ctx);
      if (!session || !session.state.startsWith("newtask:")) return;
      const data2 = wizardDataOf(session);
      if (a === "again") data2.allowDuplicate = true;
      return completeNewTask(ctx, data2, a === "save");
    }
    case "Es": {
      const session = await currentSession(ctx);
      if (!session || !session.state.startsWith("taskedit:")) return;
      const data2 = wizardDataOf(session);
      const task = await taskForEdit(ctx, data2);
      if (!task) return;
      if (a !== "keep") data2.scope = a === "live" ? "live" : a === "both" ? "live_and_backfill" : "backfill_only";
      if (editTargetScope(data2, task) === "live") return promptEditFilter(ctx, data2, task, ctx.messageId);
      return promptEditStart(ctx, data2, task, ctx.messageId);
    }
    case "Ekeep": {
      const session = await currentSession(ctx);
      if (!session || !session.state.startsWith("taskedit:")) return;
      const data2 = wizardDataOf(session);
      const task = await taskForEdit(ctx, data2);
      if (!task) return;
      if (a === "start") return promptEditEnd(ctx, data2, task, ctx.messageId);
      if (a === "end") return promptEditCursor(ctx, data2, task, ctx.messageId);
      return promptEditReset(ctx, data2, ctx.messageId);
    }
    case "Er": {
      const session = await currentSession(ctx);
      if (!session || !session.state.startsWith("taskedit:")) return;
      const data2 = wizardDataOf(session);
      const task = await taskForEdit(ctx, data2);
      if (!task) return;
      data2.resetProgress = a === "yes";
      return promptEditFilter(ctx, data2, task, ctx.messageId);
    }
    case "Ef": {
      const session = await currentSession(ctx);
      if (!session || !session.state.startsWith("taskedit:")) return;
      const data2 = wizardDataOf(session);
      const task = await taskForEdit(ctx, data2);
      if (!task) return;
      if (a === "m" && b) {
        toggleMedia(data2, b);
        data2.filtersTouched = true;
      } else if (a === "min" || a === "max") {
        const value = mbToBytes(Number(b));
        if (a === "min") data2.filterMinSizeBytes = value;
        else data2.filterMaxSizeBytes = value;
        data2.filtersTouched = true;
      } else if (a === "done") {
        return promptEditConfirm(ctx, data2, task, ctx.messageId);
      }
      return saveAndEdit(ctx, "taskedit:filter", data2, filterPromptView("Ef", data2));
    }
    case "Ec": {
      const session = await currentSession(ctx);
      if (!session || !session.state.startsWith("taskedit:")) return;
      const data2 = wizardDataOf(session);
      const task = await taskForEdit(ctx, data2);
      if (!task) return;
      return completeEditTask(ctx, data2, task);
    }
    case "p":
      return viewOrError(ctx, await savedView(ctx.env));
    case "Pr": {
      const saved = await findSaved(ctx, a);
      if (!saved) return;
      const result = await startTaskFromSaved(ctx.env, saved);
      await botSend(
        ctx,
        result.ok && result.data ? `✅ Started <b>${result.data.label}</b> from the template.` : `❌ ${result.ok ? "Task started but could not be re-read." : esc(result.description)}`,
        result.ok && result.data ? { inline_keyboard: [[{ text: "📋 Open task", callback_data: `T:${shortId(result.data.id)}` }], [{ text: "« Templates", callback_data: "p" }]] } : { inline_keyboard: [[{ text: "« Templates", callback_data: "p" }]] }
      );
      return;
    }
    case "Pd": {
      const saved = await findSaved(ctx, a);
      if (!saved) return;
      return botEdit(
        ctx,
        ctx.messageId,
        "Delete this saved template? Running bots and tasks are not affected.",
        confirmKeyboard(`Pdc:${saved}`, "Delete template", "p")
      );
    }
    case "Pdc": {
      const id = await findSaved(ctx, a);
      if (!id) return;
      await deleteSavedTask(ctx.env.DB, id);
      return viewOrError(ctx, await savedView(ctx.env));
    }
    case "o":
      return viewOrError(ctx, await toolsBotsView(ctx.env));
    case "O": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) return;
      await saveSession(ctx.env, ctx.chatId, ctx.userId, "tool:chat", { botId: bot.value.id });
      return botEdit(
        ctx,
        ctx.messageId,
        `<b>Chat tools · @${bot.value.bot_username}</b>

Send the chat id or @username to inspect.`,
        { inline_keyboard: [[{ text: "« Tools", callback_data: "o" }], [{ text: "✖️ Cancel", callback_data: "x" }]] }
      );
    }
    case "oc": {
      const session = await currentSession(ctx);
      if (!session || session.state !== "tool:panel") {
        await botSend(ctx, "Open the chat tools menu again.", {
          inline_keyboard: [[{ text: "🛠 Chat tools", callback_data: "o" }]]
        });
        return;
      }
      const data2 = session.data;
      if (!data2.botId || !data2.chatId) return;
      const action = a;
      if (action === "info") {
        return viewOrError(ctx, await chatInfoView(ctx.env, data2.botId, data2.chatId));
      }
      if (action === "invite") {
        const bot = await getBotWithSecrets(ctx.env.DB, data2.botId);
        if (!bot) return;
        const result = await toResult(() => new TelegramClient(bot.token).createChatInviteLink(data2.chatId));
        await botSend(
          ctx,
          result.ok ? `✅ Invite link: ${esc(result.data.invite_link)}` : `❌ ${esc(result.description)}`,
          {
            inline_keyboard: [
              [{ text: "« Chat panel", callback_data: `Ch:${data2.botId.slice(0, 8)}:${data2.chatId}` }],
              [{ text: "🛠 Chat tools", callback_data: "o" }]
            ]
          }
        );
        return;
      }
      if (action === "latest") {
        const bot = await getBotWithSecrets(ctx.env.DB, data2.botId);
        if (!bot) return;
        const result = await toResult(() => resolveLastN(new TelegramClient(bot.token), data2.chatId, 1));
        await botSend(
          ctx,
          result.ok ? `Latest message id: ${result.data.endId}` : `❌ ${esc(result.description)}`,
          { inline_keyboard: [[{ text: "🛠 Chat tools", callback_data: "o" }]] }
        );
        return;
      }
      if (["revoke", "ban", "unban", "promote", "sendtest", "copytest"].includes(action)) {
        await saveSession(ctx.env, ctx.chatId, ctx.userId, `tool:${action}`, data2);
        const prompts = {
          revoke: "Send the invite link to revoke.",
          ban: "Send the numeric user id to ban.",
          unban: "Send the numeric user id to unban.",
          promote: "Send the numeric user id to promote (delete, invite, restrict).",
          sendtest: "Send the test message text.",
          copytest: "Send the destination chat id for the test copy."
        };
        return botEdit(ctx, ctx.messageId, `<b>Chat tools</b>

${prompts[action]}`, {
          inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "o" }]]
        });
      }
      return;
    }
    case "Ch": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) return;
      return viewOrError(ctx, await chatInfoView(ctx.env, bot.value.id, b ?? ""));
    }
    case "sec":
      return viewOrError(ctx, await securityView(ctx.env));
    case "sa":
      return viewOrError(ctx, await securityView(ctx.env));
    case "sp": {
      await saveSession(ctx.env, ctx.chatId, ctx.userId, "auth:set", {});
      return botEdit(
        ctx,
        ctx.messageId,
        "<b>Set web console password</b>\n\nSend the new password (4–256 characters). Your message is deleted after it is processed.",
        { inline_keyboard: [[{ text: "« Security", callback_data: "sec" }], [{ text: "✖️ Cancel", callback_data: "x" }]] }
      );
    }
    case "sr":
      return botEdit(
        ctx,
        ctx.messageId,
        "⚠️ <b>Remove web console password?</b>\n\nAnyone who can reach the Worker URL will be able to manage bots and tasks.",
        confirmKeyboard("srd", "Remove password", "sec")
      );
    case "srd": {
      await clearAdminPassword(ctx.env);
      return viewOrError(ctx, await securityView(ctx.env));
    }
    case "adm":
      return viewOrError(ctx, await adminsView(ctx.env));
    case "adma": {
      await saveSession(ctx.env, ctx.chatId, ctx.userId, "admin:add", {});
      return botEdit(
        ctx,
        ctx.messageId,
        "<b>Add controller admin</b>\n\nSend the numeric Telegram user id to allow.",
        { inline_keyboard: [[{ text: "« Admins", callback_data: "adm" }], [{ text: "✖️ Cancel", callback_data: "x" }]] }
      );
    }
    case "admr": {
      if (Number(a) === ctx.userId) {
        await botSend(ctx, "You cannot remove yourself. Ask another admin, or clear the env allowlist.");
      } else if (a) {
        await removeAdminId(ctx.env, Number(a));
      }
      return viewOrError(ctx, await adminsView(ctx.env));
    }
  }
}
async function findSaved(ctx, ref) {
  const saved = await listSavedTasks(ctx.env.DB);
  if (/^\d+$/.test(ref)) {
    const index2 = Number(ref);
    if (index2 >= 1 && index2 <= saved.length) return saved[index2 - 1].id;
  }
  const exact = saved.filter((s) => s.id === ref);
  if (exact.length === 1) return exact[0].id;
  const prefix = saved.filter((s) => ref.length >= 4 && s.id.startsWith(ref));
  if (prefix.length === 1) return prefix[0].id;
  return null;
}
function toggleMedia(data, type) {
  const current = (data.filterMediaTypes ?? "").split(",").filter(Boolean);
  const next = current.includes(type) ? current.filter((t) => t !== type) : [...current, type];
  data.filterMediaTypes = next.length > 0 ? next.join(",") : null;
}
function mbToBytes(mb) {
  if (!Number.isFinite(mb) || mb <= 0) return null;
  return Math.round(mb * 1024 * 1024);
}
async function loadTool(ctx, data) {
  if (!data.botId) {
    await dropSession(ctx.env, ctx.chatId);
    await botSend(ctx, "That chat session expired — open Chat tools again.");
    return null;
  }
  const bot = await getBotWithSecrets(ctx.env.DB, data.botId);
  if (!bot) {
    await dropSession(ctx.env, ctx.chatId);
    await botSend(ctx, "That bot no longer exists.");
    return null;
  }
  return { bot, client: new TelegramClient(bot.token), data };
}
async function keepPanel(ctx, data, message) {
  await saveSession(ctx.env, ctx.chatId, ctx.userId, "tool:panel", data);
  await botSend(ctx, message, chatPanelKeyboard());
}
async function handleTextSession(ctx, session) {
  switch (session.state) {
    case "bot:add": {
      const token = ctx.text.trim();
      if (!isBotToken(token)) {
        await botSend(ctx, "That does not look like a bot token. Send the full token from @BotFather, or tap Cancel.");
        return true;
      }
      await ctx.client.deleteMessage(ctx.chatId, ctx.messageId).catch(() => void 0);
      const existing = await findBotByTokenOrBotId(ctx.env.DB, token);
      if (existing) {
        await dropSession(ctx.env, ctx.chatId);
        const view2 = await botDetailView(ctx.env, existing.id);
        await botSend(ctx, `That token is already connected as @${esc(existing.bot_username)}.`, view2?.keyboard);
        return true;
      }
      const created = await createBotRecord(ctx.env, "", token);
      if (!created.ok) {
        await botSend(ctx, `❌ Telegram rejected the token: ${esc(created.description)}`);
        return true;
      }
      await dropSession(ctx.env, ctx.chatId);
      const view = await botDetailView(ctx.env, created.data.id);
      await botSend(
        ctx,
        `✅ Connected <b>${esc(created.data.label)}</b> @${esc(created.data.bot_username)}.`,
        view?.keyboard
      );
      return true;
    }
    case "bot:rename": {
      const data = session.data;
      const label = ctx.text.trim();
      if (!data.botId || !label) {
        await botSend(ctx, "Send a non-empty label, or tap Cancel.");
        return true;
      }
      const bot = await getBotWithSecrets(ctx.env.DB, data.botId);
      if (!bot) {
        await dropSession(ctx.env, ctx.chatId);
        await botSend(ctx, "That bot no longer exists.");
        return true;
      }
      await updateBotLabel(ctx.env.DB, data.botId, label);
      await dropSession(ctx.env, ctx.chatId);
      await botSend(ctx, `✅ @${esc(bot.bot_username)} is now labelled <b>${esc(label)}</b>.`, {
        inline_keyboard: [[{ text: "« Bot", callback_data: `B:${data.botId.slice(0, 8)}` }], [{ text: "« Menu", callback_data: "m" }]]
      });
      return true;
    }
    case "task:label": {
      const data = session.data;
      const label = ctx.text.trim();
      if (!data.taskId || !label) {
        await botSend(ctx, "Send a non-empty label, or tap Cancel.");
        return true;
      }
      const result = await applyTaskPatch(ctx.env, data.taskId, { label });
      if (!result.ok) {
        await botSend(ctx, `❌ ${esc(result.description)}`);
        return true;
      }
      await dropSession(ctx.env, ctx.chatId);
      await botSend(ctx, `✅ Task renamed to <b>${esc(label)}</b>.`, {
        inline_keyboard: [[{ text: "« Task", callback_data: `T:${data.taskId.slice(0, 8)}` }], [{ text: "« Menu", callback_data: "m" }]]
      });
      return true;
    }
    case "auth:set": {
      const password = ctx.text.trim();
      await ctx.client.deleteMessage(ctx.chatId, ctx.messageId).catch(() => void 0);
      if (password.length < 4 || password.length > 256) {
        await botSend(ctx, "❌ Password must be 4–256 characters. Tap Set password to try again.");
        return true;
      }
      await storeAdminPassword(ctx.env, password);
      await dropSession(ctx.env, ctx.chatId);
      const view = await securityView(ctx.env);
      await botSend(ctx, `✅ Web console password updated.

${view.text}`, view.keyboard);
      return true;
    }
    case "admin:add": {
      const userId = Number(ctx.text.trim());
      if (!Number.isInteger(userId) || userId <= 0) {
        await botSend(ctx, "Send a numeric Telegram user id, or tap Cancel.");
        return true;
      }
      const added = await addAdminId(ctx.env, userId);
      await dropSession(ctx.env, ctx.chatId);
      const view = await adminsView(ctx.env);
      await botSend(
        ctx,
        added ? `✅ ${code(userId)} can now control this bot.

${view.text}` : `${code(userId)} is already env-managed.`,
        view.keyboard
      );
      return true;
    }
    case "tool:chat": {
      const tool = await loadTool(ctx, session.data);
      if (!tool) return true;
      const lookup = await lookupChat(ctx.env.DB, tool.client, tool.bot.bot_id, ctx.text.trim());
      if (!lookup.ok) {
        await botSend(ctx, `❌ Cannot access ${esc(ctx.text.trim())}: ${esc(lookup.description)}`);
        return true;
      }
      tool.data.chatId = String(lookup.data.chat.id);
      tool.data.chatTitle = lookup.data.chat.title ?? null;
      await saveSession(ctx.env, ctx.chatId, ctx.userId, "tool:panel", tool.data);
      const view = await chatInfoView(ctx.env, tool.bot.id, tool.data.chatId);
      await botSend(ctx, view.text, view.keyboard);
      return true;
    }
    case "tool:revoke":
    case "tool:ban":
    case "tool:unban":
    case "tool:promote":
    case "tool:sendtest":
    case "tool:copytest": {
      const tool = await loadTool(ctx, session.data);
      if (!tool) return true;
      const chatId = tool.data.chatId;
      if (!chatId) {
        await dropSession(ctx.env, ctx.chatId);
        await botSend(ctx, "That chat session expired — open Chat tools again.");
        return true;
      }
      const input = ctx.text.trim();
      if (session.state === "tool:revoke") {
        const result2 = await toResult(() => tool.client.revokeChatInviteLink(chatId, input));
        await keepPanel(
          ctx,
          tool.data,
          result2.ok ? `✅ Invite link revoked: ${esc(result2.data.invite_link)}` : `❌ ${esc(result2.description)}`
        );
        return true;
      }
      if (session.state === "tool:ban" || session.state === "tool:unban") {
        const userId = Number(input.split(/\s+/)[0]);
        if (!Number.isInteger(userId) || userId <= 0) {
          await botSend(ctx, `Send the numeric user id to ${session.state === "tool:ban" ? "ban" : "unban"}.`);
          return true;
        }
        const ban = session.state === "tool:ban";
        const result2 = await toResult(
          () => ban ? tool.client.banChatMember(chatId, userId) : tool.client.unbanChatMember(chatId, userId)
        );
        await keepPanel(
          ctx,
          tool.data,
          result2.ok ? `✅ User ${userId} ${ban ? "banned" : "unbanned"} in ${esc(chatId)}.` : `❌ ${esc(result2.description)}`
        );
        return true;
      }
      if (session.state === "tool:promote") {
        const userId = Number(input.split(/\s+/)[0]);
        if (!Number.isInteger(userId) || userId <= 0) {
          await botSend(ctx, "Send the numeric user id to promote.");
          return true;
        }
        const result2 = await toResult(
          () => tool.client.promoteChatMember(chatId, userId, {
            can_delete_messages: true,
            can_invite_users: true,
            can_restrict_members: true
          })
        );
        await keepPanel(
          ctx,
          tool.data,
          result2.ok ? `✅ User ${userId} promoted (delete, invite, restrict).` : `❌ ${esc(result2.description)}`
        );
        return true;
      }
      if (session.state === "tool:sendtest") {
        const text = input || "Test message from Telegram Clone Worker";
        const result2 = await toResult(() => tool.client.sendMessage(chatId, text));
        await keepPanel(
          ctx,
          tool.data,
          result2.ok ? `✅ Sent as message ${code(result2.data.message_id)}.` : `❌ ${esc(result2.description)}`
        );
        return true;
      }
      const dest = input.split(/\s+/)[0];
      if (!dest) {
        await botSend(ctx, "Send the destination chat id.");
        return true;
      }
      const result = await toResult(async () => {
        const latest = await resolveLastN(tool.client, chatId, 1);
        const copy = await tool.client.copyMessage(dest, chatId, latest.endId);
        return { sourceId: latest.endId, messageId: copy.message_id };
      });
      await keepPanel(
        ctx,
        tool.data,
        result.ok ? `✅ Copied message ${code(result.data.sourceId)} → ${esc(dest)} (new message ${code(result.data.messageId)}).` : `❌ ${esc(result.description)}`
      );
      return true;
    }
    case "tool:panel": {
      await botSend(ctx, "Use the chat tool buttons above, or tap Chat tools to start over.", chatPanelKeyboard());
      return true;
    }
    default:
      if (session.state.startsWith("confirm:")) {
        await botSend(ctx, "Tap Confirm or Cancel above, or use /confirm and /cancel.");
        return true;
      }
      return false;
  }
}
function parseCommand(text) {
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const rawArgs = (match[2] ?? "").trim();
  return {
    name: match[1].toLowerCase(),
    args: rawArgs ? rawArgs.split(/\s+/) : [],
    rawArgs
  };
}
function safeEqual$1(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function handleControllerUpdate(env, update) {
  const token = getControllerToken(env);
  if (!token) return;
  if (update.callback_query) {
    await handleControllerCallback(env, update.callback_query);
    return;
  }
  const message = update.message;
  const from = message?.from;
  if (!message || !message.text || !from || from.is_bot) return;
  const ctx = {
    env,
    client: new TelegramClient(token),
    chatId: message.chat.id,
    messageId: message.message_id,
    userId: from.id,
    text: message.text.trim()
  };
  if (!await isControllerAdmin(env, from.id)) {
    if (await handleClaim(ctx)) return;
    if (!/^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(ctx.text)) return;
    const admins = await getAdminIds(env);
    const claimAvailable = admins.length === 0 && Boolean(env.BOT_CONTROLLER_CLAIM_CODE?.trim());
    await botReply(ctx, unauthorizedHtml(from.id, claimAvailable));
    return;
  }
  const command = parseCommand(ctx.text);
  if (command) {
    await dispatchCommand(ctx, command);
    return;
  }
  const session = await getSession(env, ctx.chatId);
  if (session) {
    if (await handleTextSession(ctx, session)) return;
    await advanceWizard(ctx, session);
    return;
  }
  await botReply(ctx, "Send /help for the command list, or /newtask to create a task.");
}
async function handleClaim(ctx) {
  const match = /^\/claim(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?$/.exec(ctx.text);
  if (!match) return false;
  const admins = await getAdminIds(ctx.env);
  if (admins.length > 0) return false;
  const expected = ctx.env.BOT_CONTROLLER_CLAIM_CODE?.trim();
  if (!expected) {
    await botReply(
      ctx,
      "This controller has no admin configured.\nSet the BOT_CONTROLLER_ADMIN_IDS secret to your Telegram user id, or set BOT_CONTROLLER_CLAIM_CODE and send /claim &lt;code&gt;."
    );
    return true;
  }
  if (!match[1] || !safeEqual$1(match[1], expected)) {
    await botReply(ctx, "❌ Wrong claim code.");
    return true;
  }
  await addAdminId(ctx.env, ctx.userId);
  await botReply(ctx, `✅ You are now a controller admin (user id ${code(ctx.userId)}).
Send /help to see every command.`);
  return true;
}
async function dispatchCommand(ctx, command) {
  if (!["cancel", "confirm"].includes(command.name)) {
    await dropSession(ctx.env, ctx.chatId);
  }
  switch (command.name) {
    case "start":
    case "menu":
      return showMainMenu(ctx);
    case "help":
      return sendHelp(ctx);
    case "status":
    case "dashboard":
      return showStatusView(ctx);
    case "config":
      return showConfigView(ctx);
    case "bots":
      return showBotsView(ctx);
    case "bot":
      return sendBotDetail(ctx, command.args[0]);
    case "botadd":
      return addBot(ctx, command);
    case "botrename":
      return renameBot(ctx, command);
    case "botremove":
      return removeBot(ctx, command.args[0]);
    case "botinspect":
      return inspectConnectedBot(ctx, command.args[0]);
    case "botunhook":
      return disconnectWebhook(ctx, command.args[0]);
    case "webhooksync":
      return syncWebhooks(ctx);
    case "tasks":
      return showTasksView(ctx, command.args[0]);
    case "task":
      return sendTaskDetail(ctx, command.args[0]);
    case "activity":
      return sendTaskActivity(ctx, command.args[0], command.args[1]);
    case "pause":
      return setTaskRunningState(ctx, command.args[0], "pause");
    case "resume":
      return setTaskRunningState(ctx, command.args[0], "resume");
    case "stop":
      return setTaskRunningState(ctx, command.args[0], "stop");
    case "tasklabel":
      return relabelTask(ctx, command);
    case "taskedit":
      return editTask(ctx, command.args[0]);
    case "taskdelete":
      return deleteTaskCommand(ctx, command.args[0]);
    case "testcopy":
      return testCopyTask(ctx, command.args[0], command.args[1]);
    case "newtask":
      return startNewTaskWizard(ctx);
    case "saved":
      return showSavedView(ctx);
    case "savedrun":
      return runSaved(ctx, command.args[0]);
    case "saveddel":
      return deleteSaved(ctx, command.args[0]);
    case "chat":
      return sendChat(ctx, command.args);
    case "invite":
      return inviteLink(ctx, command.args);
    case "revoke":
      return revokeInvite(ctx, command.args);
    case "ban":
      return banUser(ctx, command.args, true);
    case "unban":
      return banUser(ctx, command.args, false);
    case "promote":
      return promoteUser(ctx, command.args);
    case "sendtest":
      return sendTestMessage(ctx, command.args);
    case "latest":
      return latestMessageId(ctx, command.args);
    case "copytest":
      return adHocTestCopy(ctx, command.args);
    case "mode":
      return manageMode(ctx, command.args);
    case "admin":
      return manageAdmins(ctx, command.args);
    case "authstatus":
      return showSecurityView(ctx);
    case "authset":
      return setPassword(ctx, command.rawArgs);
    case "authremove":
      return removePassword(ctx);
    case "cancel":
      await dropSession(ctx.env, ctx.chatId);
      return showMainMenu(ctx);
    case "confirm":
      return runConfirmation(ctx);
    default:
      await botReply(ctx, `Unknown command /${esc(command.name)}. Send /help for the list.`);
  }
}
async function sendHelp(ctx) {
  await botReply(
    ctx,
    [
      "<b>Telegram Clone Worker · controller</b>",
      "Tip: /start opens the button menu; every list has action buttons.",
      "",
      "<b>Snapshot</b>",
      "/menu — button menu",
      "/status — bots, tasks and throughput",
      "/config — effective settings",
      "",
      "<b>Bots</b>",
      "/bots — list connected bots",
      "/bot &lt;ref&gt; — details + rate limits",
      "/botadd &lt;token&gt; [label] — connect a bot",
      "/botrename &lt;ref&gt; &lt;label&gt;",
      "/botinspect &lt;ref&gt; — external activity check",
      "/botunhook &lt;ref&gt; — remove its webhook",
      "/webhooksync — remove webhooks from all bots",
      "/botremove &lt;ref&gt;",
      "",
      "<b>Tasks</b>",
      "/tasks [botRef] · /task &lt;ref&gt; · /activity &lt;ref&gt; [n]",
      "/newtask — guided creation",
      "/taskedit &lt;ref&gt; — guided edit",
      "/pause &lt;ref&gt; · /resume &lt;ref&gt; · /stop &lt;ref&gt;",
      "/tasklabel &lt;ref&gt; &lt;label&gt; · /taskdelete &lt;ref&gt;",
      "/testcopy &lt;ref&gt; [messageId]",
      "",
      "<b>Templates</b>",
      "/saved · /savedrun &lt;id&gt; · /saveddel &lt;id&gt;",
      "",
      "<b>Chat tools</b> (bot optional when only one exists)",
      "/chat &lt;bot&gt; &lt;chat&gt;",
      "/invite · /revoke · /ban · /unban · /promote",
      "/sendtest · /latest · /copytest",
      "",
      "<b>Security &amp; system</b>",
      "/authstatus · /authset &lt;password&gt; · /authremove",
      "/admin list|add|remove",
      "/mode — webhook vs polling",
      "",
      "Refs accept full ids, unique prefixes, or listing numbers. /cancel aborts a wizard."
    ].join("\n")
  );
}
async function showMainMenu(ctx) {
  const view = await mainMenuView(ctx.env);
  await botSend(ctx, view.text, view.keyboard);
}
async function showStatusView(ctx) {
  const view = await statusView(ctx.env);
  await botSend(ctx, view.text, view.keyboard);
}
async function showConfigView(ctx) {
  const view = await configView(ctx.env);
  await botSend(ctx, view.text, view.keyboard);
}
async function showBotsView(ctx) {
  const view = await botsView(ctx.env);
  await botSend(ctx, view.text, view.keyboard);
}
async function showSavedView(ctx) {
  const view = await savedView(ctx.env);
  await botSend(ctx, view.text, view.keyboard);
}
async function showSecurityView(ctx) {
  const view = await securityView(ctx.env);
  await botSend(ctx, view.text, view.keyboard);
}
async function showTasksView(ctx, botRef) {
  if (botRef) {
    const bot = await resolveBot(ctx.env, botRef);
    if (!bot.ok) {
      await botReply(ctx, `❌ ${esc(bot.error)}`);
      return;
    }
    const view2 = await tasksView(ctx.env, "all", 0, bot.value.id);
    await botSend(ctx, view2.text, view2.keyboard);
    return;
  }
  const view = await tasksView(ctx.env, "active", 0);
  await botSend(ctx, view.text, view.keyboard);
}
function formatRateLimit(rate) {
  if (!rate.is_cooling_down) return `not cooling down · ${rate.events_last_24h} 429s in 24h`;
  return `cooling down ${Math.ceil(rate.cooldown_seconds_remaining / 60)} min · ${rate.events_last_24h} 429s in 24h`;
}
async function sendBotDetail(ctx, ref) {
  if (!ref) {
    await botReply(ctx, "Usage: /bot &lt;number or @username&gt;");
    return;
  }
  const found = await resolveBot(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  const bot = found.value;
  const [tasks, rate] = await Promise.all([
    listTasksByBot(ctx.env.DB, bot.id),
    getBotRateLimitStats(ctx.env.DB, bot.id)
  ]);
  const active = tasks.filter((t) => t.live_enabled || t.backfill_status === "running" || t.backfill_status === "paused");
  const lines = [
    `<b>${esc(bot.label)}</b> @${esc(bot.bot_username)}`,
    `Bot id ${code(bot.bot_id)} · added ${fmtTime(bot.created_at)}`,
    `Tasks: <b>${tasks.length}</b> · active: <b>${active.length}</b>`,
    `Rate limits: ${esc(formatRateLimit(rate))}`
  ];
  if (active.length > 0) {
    lines.push("", "<b>Active work</b>");
    for (const task of active.slice(0, 8)) lines.push(taskLine(task));
    if (active.length > 8) lines.push(`… and ${active.length - 8} more`);
  }
  lines.push(
    "",
    `Actions: /botinspect ${esc(shortId(bot.id))} · /botrename · /botunhook · /botremove`
  );
  await botReply(ctx, lines.join("\n"));
}
async function addBot(ctx, command) {
  const token = command.args[0];
  const label = command.args.slice(1).join(" ");
  if (!token) {
    await botReply(ctx, "Usage: /botadd &lt;token&gt; [label]\nGet a token from @BotFather. The message is deleted after processing.");
    return;
  }
  await ctx.client.deleteMessage(ctx.chatId, ctx.messageId).catch(() => void 0);
  const existing = await findBotByTokenOrBotId(ctx.env.DB, token);
  if (existing) {
    await botReply(ctx, `That token is already connected as <b>${esc(existing.label)}</b> @${esc(existing.bot_username)}.`);
    return;
  }
  const created = await createBotRecord(ctx.env, "", token, label || void 0);
  if (!created.ok) {
    await botReply(ctx, `❌ Telegram rejected the token: ${esc(created.description)}`);
    return;
  }
  await botReply(
    ctx,
    `✅ Connected <b>${esc(created.data.label)}</b> @${esc(created.data.bot_username)}.
Ref: ${code(shortId(created.data.id))} · create a task with /newtask.`
  );
}
async function renameBot(ctx, command) {
  const { head, rest } = splitLead(command.rawArgs, 1);
  if (!head[0] || !rest) {
    await botReply(ctx, "Usage: /botrename &lt;bot&gt; &lt;new label&gt;");
    return;
  }
  const found = await resolveBot(ctx.env, head[0]);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  await updateBotLabel(ctx.env.DB, found.value.id, rest);
  await botReply(ctx, `✅ @${esc(found.value.bot_username)} is now labelled <b>${esc(rest)}</b>.`);
}
async function removeBot(ctx, ref) {
  if (!ref) {
    await botReply(ctx, "Usage: /botremove &lt;bot&gt;");
    return;
  }
  const found = await resolveBot(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  const tasks = await listTasksByBot(ctx.env.DB, found.value.id);
  await askConfirm(
    ctx,
    "botremove",
    { botId: found.value.id },
    `<b>Delete @${esc(found.value.bot_username)}?</b>

This disconnects its webhook and permanently deletes <b>${tasks.length}</b> task${tasks.length === 1 ? "" : "s"} that use it. This cannot be undone.`
  );
}
async function inspectConnectedBot(ctx, ref) {
  if (!ref) {
    await botReply(ctx, "Usage: /botinspect &lt;bot&gt;");
    return;
  }
  const found = await resolveBot(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  const bot = found.value;
  const client = new TelegramClient(bot.token);
  const result = await inspectBot(ctx.env.DB, client, bot.id);
  if (!result.ok) {
    await botReply(ctx, `❌ ${esc(result.description)}`);
    return;
  }
  const report = result.data;
  const lines = [
    `<b>Inspect @${esc(report.bot_username)}</b>`,
    "",
    `Webhook: <b>${report.webhook.is_active ? "active" : "none"}</b>${report.webhook.url ? ` · ${esc(report.webhook.url)}` : ""}`,
    `Pending updates: ${report.webhook.pending_update_count}`,
    `Polling conflict: <b>${report.polling_session.conflict_detected ? "yes" : "no"}</b>`
  ];
  if (report.webhook.last_error_message) {
    lines.push(`Last webhook error: ${esc(report.webhook.last_error_message)}`);
  }
  if (report.polling_session.message) lines.push(`↳ ${esc(report.polling_session.message)}`);
  lines.push(`Rate limits: ${esc(formatRateLimit(report.rate_limits))}`);
  lines.push(`Active clone tasks: <b>${report.clone_worker_tasks.active_count}</b>`);
  for (const task of report.clone_worker_tasks.tasks.slice(0, 5)) lines.push(taskLine(task));
  if (report.recent_activities.length > 0) {
    lines.push("", "<b>Recent updates</b>");
    for (const activity of report.recent_activities.slice(0, 6)) {
      lines.push(`${activity.icon} ${esc(activity.summary)} — ${esc(activity.chat_name)}`);
    }
  }
  await botReply(ctx, lines.join("\n"));
}
async function disconnectWebhook(ctx, ref) {
  if (!ref) {
    await botReply(ctx, "Usage: /botunhook &lt;bot&gt;");
    return;
  }
  const found = await resolveBot(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  const client = new TelegramClient(found.value.token);
  const result = await toResult(async () => {
    await client.deleteWebhook(false);
    return client.getWebhookInfo().catch(() => null);
  });
  if (!result.ok) {
    await botReply(ctx, `❌ ${esc(result.description)}`);
    return;
  }
  await botReply(
    ctx,
    `✅ Webhook removed from @${esc(found.value.bot_username)}; pending updates preserved (${result.data?.pending_update_count ?? 0}).`
  );
}
async function syncWebhooks(ctx) {
  const bots = await listBotsWithSecrets(ctx.env.DB);
  let removed = 0;
  const errors = [];
  for (const bot of bots) {
    try {
      await new TelegramClient(bot.token).deleteWebhook(false);
      removed++;
    } catch (e) {
      errors.push(`@${bot.bot_username}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const lines = [`<b>Webhook sync</b>`, "", `Bots checked: <b>${bots.length}</b> · webhooks removed: <b>${removed}</b>`];
  if (errors.length > 0) lines.push("", ...errors.map((e) => `❌ ${esc(e)}`));
  await botReply(ctx, lines.join("\n"));
}
async function sendTaskDetail(ctx, ref) {
  if (!ref) {
    await botReply(ctx, "Usage: /task &lt;task id, prefix or number&gt;");
    return;
  }
  const found = await resolveTask(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  const detail = await getTaskWithBot(ctx.env.DB, found.value.id);
  if (!detail) {
    await botReply(ctx, "That task no longer exists.");
    return;
  }
  const actions = detail.scope === "live" ? `/pause ${shortId(detail.id)} · /resume ${shortId(detail.id)} · /taskedit ${shortId(detail.id)}` : `/pause ${shortId(detail.id)} · /resume ${shortId(detail.id)} · /stop ${shortId(detail.id)} · /taskedit ${shortId(detail.id)}`;
  await botReply(ctx, `${taskDetailHtml(detail, detail.bot_username)}

${actions}`);
}
async function sendTaskActivity(ctx, ref, limitArg) {
  if (!ref) {
    await botReply(ctx, "Usage: /activity &lt;task&gt; [count]");
    return;
  }
  const found = await resolveTask(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  const limit = Math.min(30, Math.max(1, Number(limitArg) || 10));
  const entries = await listActivityLog(ctx.env.DB, found.value.id, limit);
  if (entries.length === 0) {
    await botReply(ctx, `No activity recorded yet for ${esc(found.value.label)}.`);
    return;
  }
  const lines = [`<b>Activity · ${esc(found.value.label)}</b>`, ""];
  for (const entry of entries) {
    const row = entry;
    const icon = row.ok ? "✅" : "❌";
    const detail = row.detail ?? row.error ?? "";
    lines.push(`${icon} ${fmtTime(row.at)} · ${esc(row.kind)}
   ${esc(detail)}`);
  }
  await botReply(ctx, lines.join("\n"));
}
async function setTaskRunningState(ctx, ref, action) {
  if (!ref) {
    await botReply(ctx, `Usage: /${action} &lt;task&gt;`);
    return;
  }
  const found = await resolveTask(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  const task = found.value;
  const result = await performTaskAction(ctx.env, task, action);
  if (!result.ok) {
    await botReply(ctx, `❌ ${esc(result.description)}`);
    return;
  }
  await botReply(
    ctx,
    `✅ ${result.label} ${esc(task.label)}.
Now: ${esc(taskState(result.task ?? task))}`
  );
}
async function relabelTask(ctx, command) {
  const { head, rest } = splitLead(command.rawArgs, 1);
  if (!head[0] || !rest) {
    await botReply(ctx, "Usage: /tasklabel &lt;task&gt; &lt;new label&gt;");
    return;
  }
  const found = await resolveTask(ctx.env, head[0]);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  const result = await applyTaskPatch(ctx.env, found.value.id, { label: rest });
  if (!result.ok) {
    await botReply(ctx, `❌ ${esc(result.description)}`);
    return;
  }
  await botReply(ctx, `✅ Task renamed to <b>${esc(rest)}</b>.`);
}
async function editTask(ctx, ref) {
  if (!ref) {
    await botReply(ctx, "Usage: /taskedit &lt;task&gt;");
    return;
  }
  const found = await resolveTask(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  await startEditTaskWizard(ctx, found.value);
}
async function deleteTaskCommand(ctx, ref) {
  if (!ref) {
    await botReply(ctx, "Usage: /taskdelete &lt;task&gt;");
    return;
  }
  const found = await resolveTask(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  await askConfirm(
    ctx,
    "taskdelete",
    { taskId: found.value.id },
    `<b>Delete "${esc(found.value.label)}"?</b>

This removes the task and its activity log permanently. The bot and chats stay untouched.`
  );
}
async function testCopyTask(ctx, ref, messageIdArg) {
  if (!ref) {
    await botReply(ctx, "Usage: /testcopy &lt;task&gt; [messageId]");
    return;
  }
  const found = await resolveTask(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  const task = found.value;
  const bot = await getBotWithSecrets(ctx.env.DB, task.bot_id);
  if (!bot) {
    await botReply(ctx, "That task's bot row is missing.");
    return;
  }
  const client = new TelegramClient(bot.token);
  const result = await toResult(async () => {
    const copyId = Number(messageIdArg) || (await resolveLastN(client, task.source_chat_id, 1)).endId;
    const copy = await client.copyMessage(task.dest_chat_id, task.source_chat_id, copyId);
    return { copyId, copy };
  });
  await botReply(
    ctx,
    result.ok ? `✅ Copied message ${code(result.data.copyId)} → destination (new message ${code(
      result.data.copy.message_id
    )}).` : `❌ ${esc(result.description)}`
  );
}
async function resolveSavedTask(ctx, ref) {
  const saved = await listSavedTasks(ctx.env.DB);
  if (saved.length === 0) return { ok: false, error: "No saved templates exist." };
  if (/^\d+$/.test(ref)) {
    const index2 = Number(ref);
    if (index2 >= 1 && index2 <= saved.length) return { ok: true, id: saved[index2 - 1].id };
  }
  const exact = saved.filter((s) => s.id === ref);
  if (exact.length === 1) return { ok: true, id: exact[0].id };
  const prefix = saved.filter((s) => ref.length >= 4 && s.id.startsWith(ref));
  if (prefix.length === 1) return { ok: true, id: prefix[0].id };
  if (prefix.length > 1) return { ok: false, error: "That template reference matches more than one." };
  return { ok: false, error: `No template matches ${ref}. Use /saved to list them.` };
}
async function runSaved(ctx, ref) {
  if (!ref) {
    await botReply(ctx, "Usage: /savedrun &lt;number or id&gt;");
    return;
  }
  const resolved = await resolveSavedTask(ctx, ref);
  if (!resolved.ok) {
    await botReply(ctx, `❌ ${esc(resolved.error)}`);
    return;
  }
  const result = await startTaskFromSaved(ctx.env, resolved.id);
  if (!result.ok) {
    await botReply(ctx, `❌ ${esc(result.description)}`);
    return;
  }
  await botReply(
    ctx,
    result.data ? `✅ Started <b>${esc(result.data.label)}</b> from the template.` : "✅ Task started from the template."
  );
}
async function deleteSaved(ctx, ref) {
  if (!ref) {
    await botReply(ctx, "Usage: /saveddel &lt;number or id&gt;");
    return;
  }
  const resolved = await resolveSavedTask(ctx, ref);
  if (!resolved.ok) {
    await botReply(ctx, `❌ ${esc(resolved.error)}`);
    return;
  }
  await askConfirm(
    ctx,
    "saveddel",
    { savedId: resolved.id },
    "Delete this saved template? Running bots and tasks are not affected."
  );
}
async function resolveBotChat(ctx, args) {
  if (args.length >= 2) {
    const found = await resolveBot(ctx.env, args[0]);
    if (found.ok) return { bot: found.value, chatId: args[1], rest: args.slice(2).join(" ") };
  }
  const bots = await listBotsWithSecrets(ctx.env.DB);
  if (bots.length === 1 && args.length >= 1) {
    return { bot: bots[0], chatId: args[0], rest: args.slice(1).join(" ") };
  }
  return {
    error: bots.length === 0 ? "No bots connected yet." : "Give the bot first: /command &lt;bot&gt; &lt;chat&gt; … (or connect just one bot to omit it)."
  };
}
function isTarget(value) {
  return !("error" in value);
}
function capabilityLine(cap) {
  return `${cap.available ? "✅" : "❌"} ${esc(cap.label)}${cap.reason ? ` — ${esc(cap.reason)}` : ""}`;
}
async function sendChat(ctx, args) {
  const target = await resolveBotChat(ctx, args);
  if (!isTarget(target)) {
    await botReply(ctx, `❌ ${esc(target.error)}`);
    return;
  }
  const client = new TelegramClient(target.bot.token);
  const lookup = await lookupChat(ctx.env.DB, client, target.bot.bot_id, target.chatId);
  if (!lookup.ok) {
    await botReply(ctx, `❌ ${esc(lookup.description)}`);
    return;
  }
  const data = lookup.data;
  const lines = [
    `<b>${esc(data.chat.title ?? data.chat.username ?? data.chat.id)}</b>`,
    `Type: ${esc(data.chat.type)} · id ${code(data.chat.id)}${data.chat.username ? ` · @${esc(data.chat.username)}` : ""}`,
    `Members: ${data.memberCount ?? "unknown"}`,
    `Bot status: <b>${esc(data.botStatus)}</b>`,
    "",
    "<b>Bot rights</b>",
    ...data.capabilities.map(capabilityLine)
  ];
  if (data.admins && data.admins.length > 0) {
    lines.push("", "<b>Admins</b>");
    for (const admin of data.admins.slice(0, 10)) lines.push(`• ${esc(admin.name)} (${esc(admin.status)})`);
  }
  if (data.pastTasks && data.pastTasks.length > 0) {
    lines.push("", `<b>Past tasks from this source</b>: ${data.pastTasks.length}`);
    for (const task of data.pastTasks.slice(0, 5)) {
      lines.push(`• ${code(shortId(task.id))} ${esc(task.label)}`);
    }
  }
  lines.push(
    "",
    `Actions: /invite · /ban · /unban · /promote · /sendtest · /latest · /copytest
Bot: @${esc(target.bot.bot_username)} · chat ${code(data.chat.id)}`
  );
  await botReply(ctx, lines.join("\n"));
}
async function inviteLink(ctx, args) {
  const target = await resolveBotChat(ctx, args);
  if (!isTarget(target)) {
    await botReply(ctx, `❌ ${esc(target.error)}`);
    return;
  }
  const client = new TelegramClient(target.bot.token);
  const result = await toResult(() => client.createChatInviteLink(target.chatId));
  await botReply(
    ctx,
    result.ok ? `✅ Invite link: ${esc(result.data.invite_link)}` : `❌ ${esc(result.description)}`
  );
}
async function revokeInvite(ctx, args) {
  const target = await resolveBotChat(ctx, args);
  if (!isTarget(target)) {
    await botReply(ctx, `❌ ${esc(target.error)}`);
    return;
  }
  if (!target.rest) {
    await botReply(ctx, "Usage: /revoke &lt;bot&gt; &lt;chat&gt; &lt;invite link&gt;");
    return;
  }
  const client = new TelegramClient(target.bot.token);
  const result = await toResult(() => client.revokeChatInviteLink(target.chatId, target.rest));
  await botReply(
    ctx,
    result.ok ? `✅ Invite link revoked: ${esc(result.data.invite_link)}` : `❌ ${esc(result.description)}`
  );
}
async function banUser(ctx, args, ban) {
  const target = await resolveBotChat(ctx, args);
  if (!isTarget(target)) {
    await botReply(ctx, `❌ ${esc(target.error)}`);
    return;
  }
  const userId = Number(target.rest.trim().split(/\s+/)[0]);
  if (!Number.isInteger(userId) || userId <= 0) {
    await botReply(ctx, `Usage: /${ban ? "ban" : "unban"} &lt;bot&gt; &lt;chat&gt; &lt;userId&gt;`);
    return;
  }
  const client = new TelegramClient(target.bot.token);
  const result = await toResult(
    () => ban ? client.banChatMember(target.chatId, userId) : client.unbanChatMember(target.chatId, userId)
  );
  await botReply(
    ctx,
    result.ok ? `✅ User ${userId} ${ban ? "banned" : "unbanned"} in ${esc(target.chatId)}.` : `❌ ${esc(result.description)}`
  );
}
const PROMOTE_RIGHTS = {
  delete: "can_delete_messages",
  invite: "can_invite_users",
  restrict: "can_restrict_members",
  promote: "can_promote_members",
  info: "can_change_info",
  pin: "can_pin_messages",
  manage: "can_manage_chat"
};
async function promoteUser(ctx, args) {
  const target = await resolveBotChat(ctx, args);
  if (!isTarget(target)) {
    await botReply(ctx, `❌ ${esc(target.error)}`);
    return;
  }
  const [userIdText, ...rightTokens] = target.rest.trim().split(/\s+/).filter(Boolean);
  const userId = Number(userIdText);
  if (!Number.isInteger(userId) || userId <= 0) {
    await botReply(
      ctx,
      "Usage: /promote &lt;bot&gt; &lt;chat&gt; &lt;userId&gt; [delete,invite,restrict,promote,info,pin,manage]\nDefault rights: delete, invite, restrict."
    );
    return;
  }
  let rights = {
    can_delete_messages: true,
    can_invite_users: true,
    can_restrict_members: true
  };
  if (rightTokens.length > 0) {
    const requested = rightTokens.join(",").split(",").map((token) => token.trim().toLowerCase()).filter(Boolean);
    const unknown = requested.filter((token) => !(token in PROMOTE_RIGHTS));
    if (unknown.length > 0 || requested.length === 0) {
      await botReply(
        ctx,
        `❌ Unknown right(s): ${esc(unknown.join(", ") || "(none)")}. Use: ${Object.keys(PROMOTE_RIGHTS).join(", ")}.`
      );
      return;
    }
    rights = {};
    for (const token of requested) rights[PROMOTE_RIGHTS[token]] = true;
  }
  const client = new TelegramClient(target.bot.token);
  const result = await toResult(() => client.promoteChatMember(target.chatId, userId, rights));
  await botReply(
    ctx,
    result.ok ? `✅ User ${userId} promoted with: ${esc(Object.keys(rights).join(", "))}.` : `❌ ${esc(result.description)}`
  );
}
async function sendTestMessage(ctx, args) {
  const target = await resolveBotChat(ctx, args);
  if (!isTarget(target)) {
    await botReply(ctx, `❌ ${esc(target.error)}`);
    return;
  }
  const text = target.rest || "Test message from Telegram Clone Worker";
  const client = new TelegramClient(target.bot.token);
  const result = await toResult(() => client.sendMessage(target.chatId, text));
  await botReply(
    ctx,
    result.ok ? `✅ Sent as message ${code(result.data.message_id)} in ${esc(target.chatId)}.` : `❌ ${esc(result.description)}`
  );
}
async function latestMessageId(ctx, args) {
  const target = await resolveBotChat(ctx, args);
  if (!isTarget(target)) {
    await botReply(ctx, `❌ ${esc(target.error)}`);
    return;
  }
  const client = new TelegramClient(target.bot.token);
  const result = await toResult(() => resolveLastN(client, target.chatId, 1));
  await botReply(
    ctx,
    result.ok ? `Latest message id: ${code(result.data.endId)}${result.data.cleanupOk ? "" : " (probe message could not be deleted)"}` : `❌ ${esc(result.description)}`
  );
}
async function adHocTestCopy(ctx, args) {
  const bots = await listBotsWithSecrets(ctx.env.DB);
  if (bots.length === 0) {
    await botReply(ctx, "No bots connected yet.");
    return;
  }
  let bot = null;
  let sourceChatId = "";
  let destChatId = "";
  let messageIdArg = "";
  if (args.length >= 3) {
    const found = await resolveBot(ctx.env, args[0]);
    if (found.ok) {
      bot = found.value;
      sourceChatId = args[1];
      destChatId = args[2];
      messageIdArg = args[3] ?? "";
    }
  }
  if (!bot && bots.length === 1 && args.length >= 2) {
    bot = bots[0];
    sourceChatId = args[0];
    destChatId = args[1];
    messageIdArg = args[2] ?? "";
  }
  if (!bot || !sourceChatId || !destChatId) {
    await botReply(ctx, "Usage: /copytest &lt;bot&gt; &lt;sourceChat&gt; &lt;destChat&gt; [messageId]");
    return;
  }
  const client = new TelegramClient(bot.token);
  const result = await toResult(async () => {
    const copyId = Number(messageIdArg) || (await resolveLastN(client, sourceChatId, 1)).endId;
    return { copyId, copy: await client.copyMessage(destChatId, sourceChatId, copyId) };
  });
  await botReply(
    ctx,
    result.ok ? `✅ Copied message ${code(result.data.copyId)} → destination (new message ${code(result.data.copy.message_id)}).` : `❌ ${esc(result.description)}`
  );
}
async function manageMode(ctx, args) {
  if (args.length === 0) {
    const view = await modeView(ctx.env);
    await botSend(ctx, view.text, view.keyboard);
    return;
  }
  const choice = args[0].toLowerCase();
  if (choice === "poll") {
    await ctx.client.deleteWebhook(false).catch(() => void 0);
    await setControllerMode(ctx.env, "poll");
    await botReply(
      ctx,
      "✅ Webhook removed and mode set to <b>poll</b>. The cron poller will pick up commands once a minute."
    );
    return;
  }
  if (choice === "webhook") {
    await botReply(
      ctx,
      "To switch to webhook mode, call the authenticated endpoint:\n<code>POST /api/bot-controller/setup</code>\nIt registers this Worker's URL with Telegram and flips the mode automatically."
    );
    return;
  }
  await botReply(ctx, "Usage: /mode [poll|webhook]");
}
async function manageAdmins(ctx, args) {
  const action = (args[0] ?? "list").toLowerCase();
  if (action === "list") {
    const [admins, envIds] = await Promise.all([getAdminIds(ctx.env), Promise.resolve(envAdminIds(ctx.env))]);
    const lines = ["<b>Controller admins</b>", ""];
    if (admins.length === 0) lines.push("No admins configured.");
    for (const id of admins) {
      lines.push(`• ${code(id)}${envIds.includes(id) ? " · env" : " · stored"}`);
    }
    lines.push("", "Add with /admin add &lt;userId&gt;, remove stored ids with /admin remove &lt;userId&gt;.");
    lines.push("Env ids come from BOT_CONTROLLER_ADMIN_IDS and cannot be removed from chat.");
    await botReply(ctx, lines.join("\n"));
    return;
  }
  const userId = Number(args[1]);
  if (!Number.isInteger(userId) || userId <= 0) {
    await botReply(ctx, "Usage: /admin list | /admin add &lt;userId&gt; | /admin remove &lt;userId&gt;");
    return;
  }
  if (action === "add") {
    const added = await addAdminId(ctx.env, userId);
    await botReply(
      ctx,
      added ? `✅ ${code(userId)} can now control this bot.` : `${code(userId)} is already an admin (env-managed).`
    );
    return;
  }
  if (action === "remove") {
    if (userId === ctx.userId) {
      await botReply(ctx, "You cannot remove yourself. Ask another admin, or clear the env allowlist.");
      return;
    }
    const removed = await removeAdminId(ctx.env, userId);
    await botReply(
      ctx,
      removed ? `✅ Removed ${code(userId)}.` : `Could not remove ${code(userId)} — it is env-managed or not stored.`
    );
    return;
  }
  await botReply(ctx, "Usage: /admin list | /admin add &lt;userId&gt; | /admin remove &lt;userId&gt;");
}
async function setPassword(ctx, rawArgs) {
  const password = rawArgs.trim();
  const auth = await getAuthMode(ctx.env);
  await ctx.client.deleteMessage(ctx.chatId, ctx.messageId).catch(() => void 0);
  if (auth.source === "env") {
    await botReply(ctx, "❌ The password is managed by the ADMIN_PASSWORD secret and cannot be changed from chat.");
    return;
  }
  if (password.length < 4 || password.length > 256) {
    await botReply(ctx, "❌ Password must be 4–256 characters. Send /authset &lt;password&gt; again.");
    return;
  }
  await storeAdminPassword(ctx.env, password);
  await botReply(ctx, "✅ Web console password updated. The message containing it was deleted.");
}
async function removePassword(ctx) {
  const auth = await getAuthMode(ctx.env);
  if (auth.source === "env") {
    await botReply(ctx, "❌ The password is managed by ADMIN_PASSWORD; remove that secret to disable it.");
    return;
  }
  if (auth.source === "none") {
    await botReply(ctx, "The web console is already open (no password).");
    return;
  }
  await askConfirm(
    ctx,
    "authremove",
    {},
    "⚠️ <b>Remove web console password?</b>\n\nAnyone who can reach the Worker URL will be able to manage bots and tasks."
  );
}
async function controllerDashboard(env) {
  const [bots, tasks, admins] = await Promise.all([
    listBotsSummary(env.DB),
    listAllTasksSummary(env.DB),
    getAdminIds(env)
  ]);
  return { bots: bots.length, tasks: tasks.length, admins: admins.length };
}
const WEBHOOK_PATH = "/api/bot-controller/webhook";
const COMMANDS = [
  { command: "start", description: "Controller menu" },
  { command: "menu", description: "Open the button menu" },
  { command: "status", description: "Bots, tasks and throughput" },
  { command: "bots", description: "List connected bots" },
  { command: "tasks", description: "List tasks" },
  { command: "newtask", description: "Create a task step by step" },
  { command: "task", description: "Task details" },
  { command: "pause", description: "Pause a task" },
  { command: "resume", description: "Resume a task" },
  { command: "saved", description: "Saved task templates" },
  { command: "chat", description: "Inspect a chat and bot rights" },
  { command: "config", description: "Effective configuration" },
  { command: "help", description: "Every command" }
];
function json$1(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function handleControllerWebhook(request, env, ctx) {
  if (request.method !== "POST") {
    return json$1({ ok: false, errorCode: 405, description: "method not allowed", reason: "invalid_request" }, 405);
  }
  const token = getControllerToken(env);
  if (!token) {
    return json$1({ ok: false, errorCode: 503, description: "controller bot is not configured", reason: "invalid_request" }, 503);
  }
  const secret = await getWebhookSecret(env);
  if (!secret) {
    return json$1({ ok: false, errorCode: 503, description: "controller webhook secret is not configured", reason: "invalid_request" }, 503);
  }
  const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!safeEqual(provided, secret)) {
    return json$1({ ok: false, errorCode: 401, description: "invalid webhook secret", reason: "unauthorized" }, 401);
  }
  const update = await request.json().catch(() => null);
  if (!update || typeof update.update_id !== "number") {
    return json$1({ ok: false, errorCode: 400, description: "invalid update payload", reason: "invalid_request" }, 400);
  }
  const process = async () => {
    try {
      await handleControllerUpdate(env, update);
    } catch (e) {
      console.error("controller update failed", e);
    }
  };
  if (ctx) ctx.waitUntil(process());
  else await process();
  return json$1({ ok: true, data: null });
}
async function handleControllerStatus(request, env) {
  const authError = await authenticateApiRequest(request, env);
  if (authError) return authError;
  const token = getControllerToken(env);
  const [mode, admins, counts] = await Promise.all([
    getControllerMode(env),
    getAdminIds(env),
    controllerDashboard(env)
  ]);
  let telegram = null;
  if (token) {
    const client = new TelegramClient(token);
    const [me, info] = await Promise.all([
      client.getMe().catch(() => null),
      client.getWebhookInfo().catch(() => null)
    ]);
    telegram = {
      username: me?.username ?? me?.first_name ?? null,
      webhookUrl: info?.url || null,
      pendingUpdates: info?.pending_update_count ?? 0
    };
  }
  return json$1({
    ok: true,
    data: {
      configured: Boolean(token),
      mode,
      webhookPath: WEBHOOK_PATH,
      admins: admins.length,
      adminIds: admins,
      bots: counts.bots,
      tasks: counts.tasks,
      telegram
    }
  });
}
async function handleControllerSetup(request, env, origin) {
  const authError = await authenticateApiRequest(request, env);
  if (authError) return authError;
  const token = getControllerToken(env);
  if (!token) {
    return json$1(
      { ok: false, errorCode: 400, description: "BOT_CONTROLLER_TOKEN is not configured", reason: "invalid_request" },
      400
    );
  }
  const body = await request.json().catch(() => ({}));
  const requested = typeof body.url === "string" && body.url.trim() ? body.url.trim() : `${origin}${WEBHOOK_PATH}`;
  let parsed;
  try {
    parsed = new URL(requested);
  } catch {
    return json$1({ ok: false, errorCode: 400, description: "invalid webhook URL", reason: "invalid_request" }, 400);
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !loopback) {
    return json$1(
      { ok: false, errorCode: 400, description: "webhook URL must be https (Telegram requirement)", reason: "invalid_request" },
      400
    );
  }
  const client = new TelegramClient(token);
  const secret = await ensureWebhookSecret(env);
  const result = await toResult(async () => {
    const me = await client.getMe();
    await client.setWebhook(parsed.toString(), secret);
    return me;
  });
  if (!result.ok) {
    return json$1(result, 400);
  }
  await client.setMyCommands(COMMANDS).catch(() => void 0);
  await setControllerMode(env, "webhook");
  return json$1({
    ok: true,
    data: {
      mode: "webhook",
      url: parsed.toString(),
      username: result.data.username ?? result.data.first_name
    }
  });
}
async function handleControllerDisableWebhook(request, env) {
  const authError = await authenticateApiRequest(request, env);
  if (authError) return authError;
  const token = getControllerToken(env);
  if (!token) {
    return json$1(
      { ok: false, errorCode: 400, description: "BOT_CONTROLLER_TOKEN is not configured", reason: "invalid_request" },
      400
    );
  }
  const client = new TelegramClient(token);
  const result = await toResult(async () => {
    await client.deleteWebhook(false);
    return client.getWebhookInfo().catch(() => null);
  });
  if (!result.ok) {
    return json$1(result, 400);
  }
  await setControllerMode(env, "poll");
  return json$1({
    ok: true,
    data: { mode: "poll", pendingUpdates: result.data?.pending_update_count ?? 0 }
  });
}
const MAX_UPDATES_PER_TICK = 50;
async function runControllerPoll(env) {
  const token = getControllerToken(env);
  if (!token) return;
  if (await getControllerMode(env) === "webhook") return;
  const client = new TelegramClient(token);
  const offset = await getControllerOffset(env);
  const result = await toResult(
    () => client.getUpdates({
      offset: offset > 0 ? offset : void 0,
      limit: MAX_UPDATES_PER_TICK,
      allowed_updates: ["message", "callback_query"],
      timeout: 0
    })
  );
  if (!result.ok) return;
  for (const update of result.data) {
    try {
      await handleControllerUpdate(env, update);
    } catch (e) {
      console.error("controller poll update failed", update.update_id, e);
    }
    if (update.update_id >= offset) {
      await setControllerOffset(env, update.update_id + 1);
    }
  }
  await purgeStaleSessions(env);
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
const index = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "api") {
      await ensureDatabaseBootstrap(env.DB);
      if (parts[1] === "health") {
        return json({ ok: true, data: { status: "up" } });
      }
      if (parts[1] === "bot-controller" && parts[2] === "webhook" && parts.length === 3) {
        return handleControllerWebhook(request, env, ctx);
      }
      if (parts[1] === "auth") {
        if (parts[2] === "status" && request.method === "GET") {
          return handleAuthStatus(request, env);
        }
        if (parts[2] === "login" && request.method === "POST") {
          return handleAuthLogin(request, env);
        }
        if (parts[2] === "setup" && request.method === "POST") {
          return handleAuthSetup(request, env);
        }
        if (parts[2] === "remove" && request.method === "POST") {
          return handleAuthRemove(request, env);
        }
        return json({ ok: false, errorCode: 404, description: "not found", reason: "invalid_request" }, 404);
      }
      const authError = await authenticateApiRequest(request, env);
      if (authError) return authError;
      if (parts[1] === "bot-controller") {
        if (parts.length === 2 && request.method === "GET") return handleControllerStatus(request, env);
        if (parts[2] === "setup" && parts.length === 3 && request.method === "POST") {
          return handleControllerSetup(request, env, url.origin);
        }
        if (parts[2] === "disable-webhook" && parts.length === 3 && request.method === "POST") {
          return handleControllerDisableWebhook(request, env);
        }
        return json({ ok: false, errorCode: 404, description: "not found", reason: "invalid_request" }, 404);
      }
      const botId = url.searchParams.get("botId") ?? "";
      const botToken = url.searchParams.get("token") ?? "";
      const botTelegramId = url.searchParams.get("botTelegramId") ?? "";
      if (parts[1] === "bots" && parts.length === 2) {
        if (request.method === "GET") return handleListBots(env);
      }
      if (parts[1] === "bots" && parts[2] === "sync-webhooks" && parts.length === 3 && request.method === "POST") {
        return handleSyncWebhooks(request, env);
      }
      if (parts[1] === "bots" && parts[2] === "verify" && parts.length === 3 && request.method === "POST") {
        return handleVerifyBot(request, env);
      }
      if (parts[1] === "bots" && parts[2] === "inspect" && parts.length === 3 && request.method === "POST") {
        return handleInspectBot(request, env);
      }
      if (parts[1] === "bots" && parts[2] === "disconnect-webhook" && parts.length === 3 && request.method === "POST") {
        return handleDisconnectBotWebhook(request, env);
      }
      if (parts[1] === "bots" && parts.length === 3 && request.method === "DELETE") {
        return handleDeleteBot(env, parts[2]);
      }
      if (parts[1] === "bots" && parts.length === 3 && request.method === "PATCH") {
        return handleUpdateBot(request, env, parts[2]);
      }
      if (parts[1] === "bots" && parts[3] === "tasks" && parts.length === 4) {
        if (request.method === "GET") return handleListTasks(env, parts[2]);
        if (request.method === "POST") return handleCreateTask(request, env, parts[2], url.origin);
      }
      if (parts[1] === "bots" && parts[3] === "tasks" && parts.length === 5) {
        if (request.method === "PATCH") return handlePatchTask(request, env, parts[4]);
        if (request.method === "DELETE") return handleDeleteTask(env, parts[4]);
      }
      if (parts[1] === "bots" && parts[3] === "tasks" && parts[5] === "test-copy" && parts.length === 6 && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        return handleTestCopy(env, parts[2], parts[4], body.messageId);
      }
      if (parts[1] === "tasks" && parts.length === 2 && request.method === "GET") {
        return handleListAllTasks(env);
      }
      if (parts[1] === "tasks" && parts.length === 3 && request.method === "GET") {
        return handleGetTaskById(env, parts[2]);
      }
      if (parts[1] === "tasks" && parts[3] === "activity" && parts.length === 4 && request.method === "GET") {
        return handleGetTaskActivity(env, parts[2]);
      }
      if (parts[1] === "tasks" && parts.length === 3) {
        if (request.method === "PATCH") return handlePatchTask(request, env, parts[2]);
        if (request.method === "DELETE") return handleDeleteTask(env, parts[2]);
      }
      if (parts[1] === "chats" && parts.length === 3 && request.method === "GET") {
        return handleGetChat(env, decodeURIComponent(parts[2]), botId, botToken, botTelegramId);
      }
      if (parts[1] === "chats" && parts[3] === "latest-message-id" && parts.length === 4 && request.method === "GET") {
        return handleLatestMessageId(env, decodeURIComponent(parts[2]), botId, botToken);
      }
      if (parts[1] === "chats" && parts.length === 4 && request.method === "POST") {
        const chatId = decodeURIComponent(parts[2]);
        const action = parts[3];
        if (action === "invite-link") return handleInviteLink(env, chatId, botId, botToken);
        if (action === "ban" || action === "unban") {
          const body = await request.json();
          return action === "ban" ? handleBan(env, chatId, botId, body.userId, botToken) : handleUnban(env, chatId, botId, body.userId, botToken);
        }
        if (action === "promote") {
          const body = await request.json();
          return handlePromote(env, chatId, botId, body.userId, body.rights, botToken);
        }
        if (action === "send-test-message") {
          const body = await request.json();
          return handleSendTestMessage(env, chatId, botId, body.text ?? ".", botToken);
        }
        if (action === "test-copy") {
          const body = await request.json();
          return handleAdHocTestCopy(env, chatId, botId, body.destChatId, botToken, body.messageId);
        }
        if (action === "revoke-invite-link") {
          const body = await request.json();
          return handleRevokeInviteLink(env, chatId, botId, body.inviteLink, botToken);
        }
      }
      if (parts[1] === "saved-tasks" && parts.length === 2) {
        if (request.method === "GET") return handleListSavedTasks(env);
        if (request.method === "POST") return handleCreateSavedTask(request, env);
      }
      if (parts[1] === "saved-tasks" && parts.length === 3) {
        if (request.method === "GET") return handleGetSavedTask(env, parts[2]);
        if (request.method === "DELETE") return handleDeleteSavedTask(env, parts[2]);
      }
      return json({ ok: false, errorCode: 404, description: "not found", reason: "invalid_request" }, 404);
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(_controller, env, _ctx) {
    await ensureDatabaseBootstrap(env.DB);
    try {
      await runTick(env);
    } finally {
      try {
        await runControllerPoll(env);
      } catch (e) {
        console.error("controller poll failed", e);
      }
    }
  }
};
const workerEntry = index ?? {};
export {
  workerEntry as default
};
