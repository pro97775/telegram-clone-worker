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
  revokeChatInviteLink(chatId, inviteLink) {
    return this.call("revokeChatInviteLink", { chat_id: chatId, invite_link: inviteLink });
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
  sendMessage(chatId, text) {
    return this.call("sendMessage", { chat_id: chatId, text });
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
  const { results } = await db.prepare(`SELECT id, bot_id, bot_username, label, created_at FROM bots ORDER BY created_at DESC`).all();
  return results;
}
async function listBotsWithSecrets(db) {
  const { results } = await db.prepare(`SELECT id, token, bot_id, bot_username, label, webhook_secret, last_update_id, created_at FROM bots ORDER BY created_at DESC`).all();
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
async function updateBotTokenAndLabel(db, id, token, botUsername, label) {
  if (label) {
    await db.prepare(`UPDATE bots SET token = ?, bot_username = ?, label = ? WHERE id = ?`).bind(token, botUsername, label, id).run();
  } else {
    await db.prepare(`UPDATE bots SET token = ?, bot_username = ? WHERE id = ?`).bind(token, botUsername, id).run();
  }
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
function insertTaskStatement(db, t) {
  return db.prepare(
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
  );
}
async function insertTasks(db, tasks) {
  if (tasks.length === 0) return;
  await db.batch(tasks.map((task) => insertTaskStatement(db, task)));
}
async function listTasksByBot(db, botId) {
  const { results } = await db.prepare(`SELECT * FROM tasks WHERE bot_id = ? ORDER BY created_at DESC`).bind(botId).all();
  return results.map(rowToTask);
}
async function listAllTasksSummary(db) {
  const { results } = await db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC`).all();
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
       FROM saved_tasks ORDER BY created_at DESC`
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
async function listSavedChannels(db, role) {
  if (role) {
    const { results: results2 } = await db.prepare(
      `SELECT id, role, chat_id, title, username, label, created_at
         FROM saved_channels
         WHERE role = ?
         ORDER BY created_at DESC`
    ).bind(role).all();
    return results2;
  }
  const { results } = await db.prepare(
    `SELECT id, role, chat_id, title, username, label, created_at
       FROM saved_channels
       ORDER BY created_at DESC`
  ).all();
  return results;
}
async function findSavedChannelByRoleAndChatId(db, role, chatIds) {
  const valid = chatIds.filter(Boolean).map((c) => c.toLowerCase());
  if (valid.length === 0) return null;
  const placeholders = valid.map(() => "?").join(", ");
  const row = await db.prepare(
    `SELECT id, role, chat_id, title, username, label, created_at
       FROM saved_channels
       WHERE role = ? AND LOWER(chat_id) IN (${placeholders})
       LIMIT 1`
  ).bind(role, ...valid).first();
  return row ?? null;
}
async function insertSavedChannel(db, row) {
  await db.prepare(
    `INSERT INTO saved_channels (id, role, chat_id, title, username, label)
       VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(row.id, row.role, row.chat_id, row.title ?? null, row.username ?? null, row.label).run();
}
async function updateSavedChannel(db, id, patch) {
  const sets = [];
  const binds = [];
  if (patch.chat_id !== void 0) {
    sets.push("chat_id = ?");
    binds.push(patch.chat_id);
  }
  if (patch.title !== void 0) {
    sets.push("title = ?");
    binds.push(patch.title ?? null);
  }
  if (patch.username !== void 0) {
    sets.push("username = ?");
    binds.push(patch.username ?? null);
  }
  if (patch.label !== void 0) {
    sets.push("label = ?");
    binds.push(patch.label);
  }
  if (sets.length === 0) return;
  binds.push(id);
  await db.prepare(`UPDATE saved_channels SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
}
async function enrichSavedChannelsByChatId(db, lookupIdentifiers, resolvedChatId, title, username) {
  const valid = lookupIdentifiers.filter(Boolean).map((c) => c.toLowerCase());
  if (valid.length === 0) return;
  const placeholders = valid.map(() => "?").join(", ");
  const { results } = await db.prepare(
    `SELECT id, chat_id, title, username, label
       FROM saved_channels
       WHERE LOWER(chat_id) IN (${placeholders})`
  ).bind(...valid).all();
  for (const row of results) {
    const newTitle = title ?? row.title;
    const newUsername = username ?? row.username;
    const isDefaultLabel = row.label === row.chat_id || row.label === `@${row.username}`;
    const newLabel = isDefaultLabel && newTitle ? newTitle : row.label;
    await updateSavedChannel(db, row.id, {
      chat_id: resolvedChatId || row.chat_id,
      title: newTitle,
      username: newUsername,
      label: newLabel
    });
  }
}
async function deleteSavedChannel(db, id) {
  await db.prepare(`DELETE FROM saved_channels WHERE id = ?`).bind(id).run();
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
    const chatTitle2 = mem.chat.title ?? (mem.chat.username ? `@${mem.chat.username}` : `Chat #${mem.chat.id}`);
    return {
      update_id: update.update_id,
      kind: "member_event",
      icon: "👤",
      summary: `Bot permissions changed to '${mem.new_chat_member.status}' by ${actor}`,
      chat_name: chatTitle2,
      chat_type: mem.chat.type,
      sender_name: actor,
      date_iso: mem.date ? new Date(mem.date * 1e3).toISOString() : void 0
    };
  }
  if (update.chat_member) {
    const mem = update.chat_member;
    const targetUser = mem.new_chat_member.user.username ? `@${mem.new_chat_member.user.username}` : mem.new_chat_member.user.first_name;
    const chatTitle2 = mem.chat.title ?? (mem.chat.username ? `@${mem.chat.username}` : `Chat #${mem.chat.id}`);
    return {
      update_id: update.update_id,
      kind: "member_event",
      icon: "👥",
      summary: `User ${targetUser} became '${mem.new_chat_member.status}' in chat`,
      chat_name: chatTitle2,
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
  const chatTitle = msg.chat.title ?? (msg.chat.username ? `@${msg.chat.username}` : `Chat #${msg.chat.id}`);
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
      chat_name: chatTitle,
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
      chat_name: chatTitle,
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
      chat_name: chatTitle,
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
      chat_name: chatTitle,
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
      chat_name: chatTitle,
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
      chat_name: chatTitle,
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
      chat_name: chatTitle,
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
      chat_name: chatTitle,
      chat_type: msg.chat.type,
      date_iso: dateIso
    };
  }
  return {
    update_id: update.update_id,
    kind: "text",
    icon: "💬",
    summary: snippet ? `Message from ${sender}: "${snippet}"` : `Message received from ${sender}`,
    chat_name: chatTitle,
    chat_type: msg.chat.type,
    sender_name: sender,
    date_iso: dateIso
  };
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
  const result = await toResult(async () => {
    const me = await client.getMe();
    const webhookInfo = await client.getWebhookInfo().catch(() => null);
    const existing = existingBotId ? await getBotWithSecrets(env.DB, existingBotId) : await findBotByTokenOrBotId(env.DB, token, me.id);
    let active_tasks = [];
    let rate_limit_info = {
      is_cooling_down: false,
      cooldown_until: null,
      cooldown_seconds_remaining: 0,
      events_last_24h: 0
    };
    if (existing) {
      const allTasks = await listTasksByBot(env.DB, existing.id);
      active_tasks = allTasks.filter(
        (t) => t.live_enabled || t.backfill_status === "running" || t.backfill_status === "paused"
      );
      rate_limit_info = await getBotRateLimitStats(env.DB, existing.id);
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
    const botUsername = me.username ?? me.first_name;
    const existing = await findBotByTokenOrBotId(env.DB, token, me.id);
    if (existing) {
      await updateBotTokenAndLabel(env.DB, existing.id, token, botUsername, label);
      return {
        id: existing.id,
        bot_id: me.id,
        bot_username: botUsername,
        label: label || existing.label,
        created_at: existing.created_at
      };
    }
    const id = crypto.randomUUID();
    const webhookSecret = crypto.randomUUID().replace(/-/g, "");
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
function parseBotTokenInput(rawInput) {
  const entries = [];
  const seen = /* @__PURE__ */ new Set();
  const lines = rawInput.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const tokenMatches = line.match(/\d+:[A-Za-z0-9_-]{20,}/g);
    if (tokenMatches && tokenMatches.length > 1) {
      for (const t of tokenMatches) {
        if (!seen.has(t)) {
          seen.add(t);
          entries.push({ token: t });
        }
      }
    } else if (tokenMatches && tokenMatches.length === 1) {
      const token = tokenMatches[0];
      const remainder = line.replace(token, "").replace(/^[\s|,\-:()]+|[\s|,\-:()]+$/g, "").trim();
      if (!seen.has(token)) {
        seen.add(token);
        entries.push({ token, label: remainder || void 0 });
      }
    } else {
      const parts = line.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
      for (const p of parts) {
        if (!seen.has(p)) {
          seen.add(p);
          entries.push({ token: p });
        }
      }
    }
  }
  return entries;
}
async function handleBulkAddBots(request, env, origin) {
  try {
    const body = await request.json().catch(() => ({}));
    const combinedInput = body.rawInput ?? (Array.isArray(body.tokens) ? body.tokens.join("\n") : "");
    const parsed = parseBotTokenInput(combinedInput);
    if (parsed.length === 0) {
      return json$6(
        { ok: false, errorCode: 400, description: "At least one bot token is required", reason: "invalid_request" },
        400
      );
    }
    const added = [];
    const errors = [];
    for (const item of parsed) {
      const res = await createBotRecord(env, origin, item.token, item.label);
      if (res.ok) {
        added.push(res.data);
      } else {
        const preview = item.token.length > 12 ? `${item.token.slice(0, 6)}…${item.token.slice(-4)}` : item.token;
        errors.push({ tokenPreview: preview, error: res.description });
      }
    }
    if (added.length === 0 && errors.length > 0) {
      return json$6(
        {
          ok: false,
          errorCode: 400,
          description: errors.map((e) => `${e.tokenPreview}: ${e.error}`).join("; "),
          reason: "invalid_request",
          data: { added, errors }
        },
        400
      );
    }
    return json$6({ ok: true, data: { added, errors } });
  } catch (err) {
    return json$6(
      {
        ok: false,
        errorCode: 500,
        description: err instanceof Error ? err.message : String(err),
        reason: "unknown"
      },
      500
    );
  }
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
let bootstrapDone = false;
let savedChannelsVerified = false;
async function ensureSavedChannelsTable(db) {
  if (savedChannelsVerified) return;
  const { results: cols } = await db.prepare("PRAGMA table_info(saved_channels)").all().catch(() => ({ results: [] }));
  const expectedCols = ["id", "role", "chat_id", "title", "username", "label", "created_at"];
  const colNames = cols.map((c) => c.name);
  const schemaMatches = cols.length === expectedCols.length && expectedCols.every((c) => colNames.includes(c));
  if (cols.length > 0 && !schemaMatches) {
    await db.prepare("DROP TABLE IF EXISTS saved_channels").run();
  }
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS saved_channels (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('source', 'target')),
        chat_id TEXT NOT NULL,
        title TEXT,
        username TEXT,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`
  ).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_saved_channels_role ON saved_channels(role, created_at DESC)`).run();
  savedChannelsVerified = true;
}
async function ensureDatabaseBootstrap(db) {
  try {
    await ensureSavedChannelsTable(db);
  } catch (err) {
    console.error("Failed to ensure saved_channels table:", err);
  }
  if (bootstrapDone) return;
  try {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )`
    ).run();
    const existing = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").first();
    if (existing) {
      const { results: botCols } = await db.prepare("PRAGMA table_info(bots)").all().catch(() => ({ results: [] }));
      if (botCols.length > 0 && !botCols.some((c) => c.name === "last_update_id")) {
        await db.prepare("ALTER TABLE bots ADD COLUMN last_update_id INTEGER NOT NULL DEFAULT 0").run().catch(() => {
        });
      }
      bootstrapDone = true;
      return;
    }
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
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
function json$5(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
function normalizeChatIdentifier(raw) {
  const trimmed = raw.trim();
  const tmeMatch = trimmed.match(/^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{4,})\/?$/i);
  if (tmeMatch) {
    return `@${tmeMatch[1]}`;
  }
  return trimmed;
}
function isChatIdToken(token) {
  const norm = normalizeChatIdentifier(token);
  return /^-?\d{5,}$/.test(norm) || /^@[A-Za-z0-9_]{3,}$/.test(norm);
}
function parseChannelEntries(rawInput) {
  const results = [];
  const seen = /* @__PURE__ */ new Set();
  const lines = rawInput.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.includes(",") && !line.includes("|")) {
      const commaParts = line.split(",").map((p) => p.trim()).filter(Boolean);
      if (commaParts.length > 1 && commaParts.every((p) => isChatIdToken(p.split(/\s+/)[0] ?? ""))) {
        for (const part of commaParts) {
          const sub = parseChannelEntries(part);
          for (const item of sub) {
            const key = item.chatId.toLowerCase();
            if (!seen.has(key)) {
              seen.add(key);
              results.push(item);
            }
          }
        }
        continue;
      }
    }
    const spaceTokens = line.split(/\s+/).filter(Boolean);
    if (spaceTokens.length > 1 && spaceTokens.every(isChatIdToken)) {
      for (const tok of spaceTokens) {
        const chatId = normalizeChatIdentifier(tok);
        const key = chatId.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ chatId });
        }
      }
      continue;
    }
    const match = line.match(/((?:https?:\/\/)?t\.me\/[A-Za-z0-9_]{4,}|-?\d{5,}|@[A-Za-z0-9_]{3,})/i);
    if (match) {
      const rawMatched = match[1];
      const chatId = normalizeChatIdentifier(rawMatched);
      const remainder = line.replace(rawMatched, "").replace(/^[\s|,\-:()]+|[\s|,\-:()]+$/g, "").trim();
      const key = chatId.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ chatId, label: remainder || void 0 });
      }
    } else if (spaceTokens.length > 0) {
      const firstToken = normalizeChatIdentifier(spaceTokens[0]);
      const remainder = line.slice(spaceTokens[0].length).replace(/^[\s|,\-:()]+|[\s|,\-:()]+$/g, "").trim();
      const key = firstToken.toLowerCase();
      if (firstToken && !seen.has(key)) {
        seen.add(key);
        results.push({ chatId: firstToken, label: remainder || void 0 });
      }
    }
  }
  return results;
}
async function handleListChannels(env, roleParam) {
  try {
    await ensureSavedChannelsTable(env.DB);
    const role = roleParam === "source" || roleParam === "target" ? roleParam : void 0;
    const channels = await listSavedChannels(env.DB, role);
    return json$5({ ok: true, data: channels });
  } catch (err) {
    return json$5(
      {
        ok: false,
        errorCode: 500,
        description: err instanceof Error ? err.message : String(err),
        reason: "unknown"
      },
      500
    );
  }
}
async function handleBulkCreateChannels(request, env) {
  try {
    await ensureSavedChannelsTable(env.DB);
    const body = await request.json().catch(() => ({}));
    if (body.role !== "source" && body.role !== "target") {
      return json$5(
        { ok: false, errorCode: 400, description: "role must be 'source' or 'target'", reason: "invalid_request" },
        400
      );
    }
    const role = body.role;
    const entries = Array.isArray(body.channels) && body.channels.length > 0 ? body.channels : parseChannelEntries(body.rawInput ?? "");
    if (entries.length === 0) {
      return json$5(
        {
          ok: false,
          errorCode: 400,
          description: "At least one channel ID or @username is required",
          reason: "invalid_request"
        },
        400
      );
    }
    const candidateTokens = [];
    if (entries.length <= 5) {
      try {
        if (body.botToken?.trim()) {
          candidateTokens.push(body.botToken.trim());
        }
        if (body.botId?.trim()) {
          const specificBot = await getBotWithSecrets(env.DB, body.botId.trim());
          if (specificBot && !candidateTokens.includes(specificBot.token)) {
            candidateTokens.push(specificBot.token);
          }
        }
        if (candidateTokens.length === 0) {
          const allBots = await listBotsWithSecrets(env.DB);
          for (const b of allBots) {
            if (candidateTokens.length >= 2) break;
            if (b.token && !candidateTokens.includes(b.token)) {
              candidateTokens.push(b.token);
            }
          }
        }
      } catch {
      }
    }
    const saved = [];
    const errors = [];
    for (const entry of entries) {
      const rawChatId = (entry.chatId ?? "").trim();
      if (!rawChatId) continue;
      let resolvedChatId = rawChatId;
      let resolvedTitle = null;
      let resolvedUsername = rawChatId.startsWith("@") ? rawChatId.slice(1) : null;
      for (const token of candidateTokens) {
        try {
          const client = new TelegramClient(token);
          const chat = await client.getChat(rawChatId);
          resolvedChatId = String(chat.id);
          resolvedTitle = chat.title ?? null;
          resolvedUsername = chat.username ?? resolvedUsername;
          break;
        } catch {
        }
      }
      const lookupIds = [
        rawChatId,
        resolvedChatId,
        resolvedUsername ? `@${resolvedUsername}` : ""
      ].filter(Boolean);
      const existing = await findSavedChannelByRoleAndChatId(env.DB, role, lookupIds);
      const computedLabel = entry.label?.trim() || resolvedTitle || existing?.title || (resolvedUsername ? `@${resolvedUsername}` : resolvedChatId);
      if (existing) {
        const updatedLabel = entry.label?.trim() || (existing.label === existing.chat_id && resolvedTitle ? resolvedTitle : existing.label);
        const nextTitle = resolvedTitle ?? existing.title ?? null;
        const nextUsername = resolvedUsername ?? existing.username ?? null;
        await updateSavedChannel(env.DB, existing.id, {
          chat_id: resolvedChatId,
          title: nextTitle,
          username: nextUsername,
          label: updatedLabel
        });
        saved.push({
          id: existing.id,
          role,
          chat_id: resolvedChatId,
          title: nextTitle,
          username: nextUsername,
          label: updatedLabel,
          created_at: existing.created_at
        });
      } else {
        const id = crypto.randomUUID();
        const createdAt = Math.floor(Date.now() / 1e3);
        await insertSavedChannel(env.DB, {
          id,
          role,
          chat_id: resolvedChatId,
          title: resolvedTitle ?? null,
          username: resolvedUsername ?? null,
          label: computedLabel
        });
        saved.push({
          id,
          role,
          chat_id: resolvedChatId,
          title: resolvedTitle ?? null,
          username: resolvedUsername ?? null,
          label: computedLabel,
          created_at: createdAt
        });
      }
    }
    return json$5({ ok: true, data: { saved, errors } });
  } catch (err) {
    return json$5(
      {
        ok: false,
        errorCode: 500,
        description: err instanceof Error ? err.message : String(err),
        reason: "unknown"
      },
      500
    );
  }
}
async function handleUpdateChannel(request, env, id) {
  try {
    await ensureSavedChannelsTable(env.DB);
    const body = await request.json().catch(() => ({}));
    if (!body.label?.trim()) {
      return json$5({ ok: false, errorCode: 400, description: "label is required", reason: "invalid_request" }, 400);
    }
    await updateSavedChannel(env.DB, id, { label: body.label.trim() });
    return json$5({ ok: true, data: null });
  } catch (err) {
    return json$5(
      {
        ok: false,
        errorCode: 500,
        description: err instanceof Error ? err.message : String(err),
        reason: "unknown"
      },
      500
    );
  }
}
async function handleDeleteChannel(env, id) {
  try {
    await ensureSavedChannelsTable(env.DB);
    await deleteSavedChannel(env.DB, id);
    return json$5({ ok: true, data: null });
  } catch (err) {
    return json$5(
      {
        ok: false,
        errorCode: 500,
        description: err instanceof Error ? err.message : String(err),
        reason: "unknown"
      },
      500
    );
  }
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
function json$4(data, status = 200) {
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
  if (!loaded) return json$4({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const { client, botTelegramId: telegramId } = loaded;
  const result = await toResult(async () => {
    const chat = await client.getChat(chatId);
    const member = await client.getChatMember(chatId, telegramId);
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
    const pastTasks = await listTasksForSourceChat(env.DB, [chatId, String(chat.id)]);
    try {
      await enrichSavedChannelsByChatId(
        env.DB,
        [chatId, String(chat.id), chat.username ? `@${chat.username}` : ""],
        String(chat.id),
        chat.title,
        chat.username
      );
    } catch {
    }
    return {
      chat: { id: chat.id, type: chat.type, title: chat.title, username: chat.username },
      botStatus: member.status,
      capabilities: deriveCapabilities(member, chat.type),
      memberCount,
      admins,
      pastTasks
    };
  });
  return json$4(result, result.ok ? 200 : 400);
}
async function handleInviteLink(env, chatId, botId, token) {
  const client = await loadClient(env, botId, token);
  if (!client) return json$4({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.createChatInviteLink(chatId));
  return json$4(result, result.ok ? 200 : 400);
}
async function handleRevokeInviteLink(env, chatId, botId, inviteLink, token) {
  const client = await loadClient(env, botId, token);
  if (!client) return json$4({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.revokeChatInviteLink(chatId, inviteLink));
  return json$4(result, result.ok ? 200 : 400);
}
async function handleBan(env, chatId, botId, userId, token) {
  const client = await loadClient(env, botId, token);
  if (!client) return json$4({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.banChatMember(chatId, userId));
  return json$4(result, result.ok ? 200 : 400);
}
async function handleUnban(env, chatId, botId, userId, token) {
  const client = await loadClient(env, botId, token);
  if (!client) return json$4({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.unbanChatMember(chatId, userId));
  return json$4(result, result.ok ? 200 : 400);
}
async function handlePromote(env, chatId, botId, userId, rights, token) {
  const client = await loadClient(env, botId, token);
  if (!client) return json$4({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.promoteChatMember(chatId, userId, rights));
  return json$4(result, result.ok ? 200 : 400);
}
async function handleSendTestMessage(env, chatId, botId, text, token) {
  const client = await loadClient(env, botId, token);
  if (!client) return json$4({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.sendMessage(chatId, text));
  return json$4(result, result.ok ? 200 : 400);
}
async function handleLatestMessageId(env, chatId, botId, token) {
  const client = await loadClient(env, botId, token);
  if (!client) return json$4({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(async () => {
    const { endId, cleanupOk } = await resolveLastN(client, chatId, 1);
    return { latestMessageId: endId, cleanupOk };
  });
  return json$4(result, result.ok ? 200 : 400);
}
async function handleAdHocTestCopy(env, sourceChatId, botId, destChatId, token, messageId) {
  const client = await loadClient(env, botId, token);
  if (!client) return json$4({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(async () => {
    let copyId = messageId;
    if (!copyId) {
      const latest = await resolveLastN(client, sourceChatId, 1);
      copyId = latest.endId;
    }
    return client.copyMessage(destChatId, sourceChatId, copyId);
  });
  return json$4(result, result.ok ? 200 : 400);
}
const NEW_BOT_SENTINEL = "new";
function json$3(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
async function handleListAllTasks(env) {
  const tasks = await listAllTasksSummary(env.DB);
  return json$3({ ok: true, data: tasks });
}
async function handleListTasks(env, botId) {
  const tasks = await listTasksByBot(env.DB, botId);
  return json$3({ ok: true, data: tasks });
}
async function handleGetTaskById(env, taskId) {
  const task = await getTaskWithBot(env.DB, taskId);
  if (!task) return json$3({ ok: false, errorCode: 404, description: "task not found", reason: "invalid_request" }, 404);
  return json$3({ ok: true, data: task });
}
async function handleGetTaskActivity(env, taskId) {
  const log = await listActivityLog(env.DB, taskId);
  return json$3({ ok: true, data: log });
}
const DEFAULT_PACING_BATCH_SIZE = 60;
const MAX_DESTINATIONS_PER_TASK_CREATION = 25;
async function handleCreateTask(request, env, botId, origin) {
  const body = await request.json();
  if (body.destinations !== void 0 && !Array.isArray(body.destinations)) {
    return json$3({ ok: false, errorCode: 0, description: "destinations must be an array", reason: "invalid_request" }, 400);
  }
  const requestedDestinations = body.destinations?.length ? body.destinations : typeof body.destChatId === "string" ? [{ chatId: body.destChatId, title: body.destChatTitle, type: body.destChatType }] : [];
  if (requestedDestinations.some((destination) => !destination || typeof destination.chatId !== "string")) {
    return json$3({ ok: false, errorCode: 0, description: "each destination requires a chatId string", reason: "invalid_request" }, 400);
  }
  const destinations = requestedDestinations.map((destination) => ({ ...destination, chatId: destination.chatId.trim() })).filter((destination) => destination.chatId).filter(
    (destination, index2, all) => all.findIndex((candidate) => candidate.chatId.toLowerCase() === destination.chatId.toLowerCase()) === index2
  );
  if (destinations.length === 0) {
    return json$3({ ok: false, errorCode: 0, description: "at least one destination is required", reason: "invalid_request" }, 400);
  }
  if (destinations.length > MAX_DESTINATIONS_PER_TASK_CREATION) {
    return json$3(
      { ok: false, errorCode: 0, description: `a maximum of ${MAX_DESTINATIONS_PER_TASK_CREATION} destinations can be created at once`, reason: "invalid_request" },
      400
    );
  }
  let resolvedBotId = botId;
  if (botId === NEW_BOT_SENTINEL) {
    if (!body.botToken) {
      return json$3({ ok: false, errorCode: 0, description: "botToken is required", reason: "invalid_request" }, 400);
    }
    const created = await createBotRecord(env, origin, body.botToken, body.botLabel);
    if (!created.ok) return json$3(created, 400);
    resolvedBotId = created.data.id;
  }
  const bot = await getBotWithSecrets(env.DB, resolvedBotId);
  if (!bot) return json$3({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const duplicates = await Promise.all(
    destinations.map((destination) => findDuplicateTask(env.DB, resolvedBotId, body.sourceChatId, destination.chatId))
  );
  const duplicate = duplicates.find((task) => task !== null) ?? null;
  if (duplicate && !body.allowDuplicate) {
    return json$3(
      {
        ok: false,
        errorCode: 0,
        description: "a task with this source and one of the destinations already exists",
        reason: "invalid_request",
        duplicateTaskId: duplicate.id
      },
      409
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
    const pacingBatchSize = body.pacingBatchSize ?? DEFAULT_PACING_BATCH_SIZE;
    const tasks = destinations.map((destination) => {
      const id = crypto.randomUUID();
      const label = body.label ? destinations.length === 1 ? body.label : `${body.label} → ${destination.title ?? destination.chatId}` : `${body.sourceChatTitle ?? body.sourceChatId} → ${destination.title ?? destination.chatId}`;
      return {
        id,
        bot_id: resolvedBotId,
        label,
        source_chat_id: body.sourceChatId,
        source_chat_title: body.sourceChatTitle ?? null,
        dest_chat_id: destination.chatId,
        dest_chat_title: destination.title ?? null,
        scope: body.scope,
        live_enabled: wantsLive,
        backfill_mode: wantsBackfill ? body.backfillMode ?? "range" : null,
        start_id: startId,
        end_id: endId,
        cursor: wantsBackfill ? startId : null,
        total: wantsBackfill && startId !== null && endId !== null ? endId - startId + 1 : null,
        backfill_status: wantsBackfill ? "running" : "not_applicable",
        pacing_batch_size: pacingBatchSize,
        filter_media_types: body.filterMediaTypes ?? null,
        filter_min_size_bytes: body.filterMinSizeBytes ?? null,
        filter_max_size_bytes: body.filterMaxSizeBytes ?? null
      };
    });
    await insertTasks(env.DB, tasks);
    if (body.saveTemplate) {
      for (const task of tasks) {
        try {
          const destination = destinations.find((item) => item.chatId === task.dest_chat_id);
          await insertSavedTask(env.DB, {
            id: crypto.randomUUID(),
            task_id: task.id,
            bot_token: bot.token,
            bot_label: bot.label,
            bot_username: bot.bot_username,
            source_chat_id: body.sourceChatId,
            source_chat_title: body.sourceChatTitle ?? null,
            dest_chat_id: destination.chatId,
            dest_chat_title: destination.title ?? null,
            scope: body.scope,
            backfill_mode: wantsBackfill ? body.backfillMode ?? "range" : null,
            start_id: startId,
            end_id: endId,
            n: wantsBackfill && body.backfillMode === "lastN" ? body.n ?? null : null,
            pacing_batch_size: pacingBatchSize,
            filter_media_types: body.filterMediaTypes ?? null,
            filter_min_size_bytes: body.filterMinSizeBytes ?? null,
            filter_max_size_bytes: body.filterMaxSizeBytes ?? null
          });
        } catch (e) {
          console.error("saved_tasks write failed", e);
        }
      }
    }
    return await Promise.all(tasks.map((task) => getTask(env.DB, task.id)));
  });
  return json$3(result, result.ok ? 201 : 400);
}
async function handlePatchTask(request, env, taskId) {
  const currentTask = await getTask(env.DB, taskId);
  if (!currentTask) {
    return json$3({ ok: false, errorCode: 404, description: "task not found", reason: "invalid_request" }, 404);
  }
  const body = await request.json();
  const targetScope = body.scope ?? currentTask.scope;
  let liveEnabled = body.liveEnabled;
  let backfillStatus = body.backfillStatus;
  if (body.scope !== void 0) {
    if (body.scope === "live") {
      liveEnabled = liveEnabled !== void 0 ? liveEnabled : true;
      backfillStatus = "not_applicable";
    } else if (body.scope === "backfill_only") {
      liveEnabled = false;
      if (!backfillStatus) {
        backfillStatus = currentTask.backfill_status === "not_applicable" ? "running" : currentTask.backfill_status;
      }
    } else if (body.scope === "live_and_backfill") {
      liveEnabled = liveEnabled !== void 0 ? liveEnabled : true;
      if (!backfillStatus) {
        backfillStatus = currentTask.backfill_status === "not_applicable" ? "running" : currentTask.backfill_status;
      }
    }
  }
  let startId = body.startId !== void 0 ? body.startId : currentTask.start_id;
  let endId = body.endId !== void 0 ? body.endId : currentTask.end_id;
  let cursor = body.cursor !== void 0 ? body.cursor : currentTask.cursor;
  let total = currentTask.total;
  if (targetScope !== "live") {
    if (startId !== null && endId !== null) {
      if (startId > endId) {
        return json$3(
          { ok: false, errorCode: 400, description: "startId cannot be greater than endId", reason: "invalid_request" },
          400
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
  let filterMediaTypes = body.filterMediaTypes !== void 0 ? body.filterMediaTypes : currentTask.filter_media_types;
  let filterMinSizeBytes = body.filterMinSizeBytes !== void 0 ? body.filterMinSizeBytes : currentTask.filter_min_size_bytes;
  let filterMaxSizeBytes = body.filterMaxSizeBytes !== void 0 ? body.filterMaxSizeBytes : currentTask.filter_max_size_bytes;
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
    filter_max_size_bytes: filterMaxSizeBytes
  });
  const task = await getTask(env.DB, taskId);
  return json$3({ ok: true, data: task });
}
async function handleDeleteTask(env, taskId) {
  await deleteTask(env.DB, taskId);
  return json$3({ ok: true, data: null });
}
async function handleTestCopy(env, botId, taskId, messageId) {
  const bot = await getBotWithSecrets(env.DB, botId);
  const task = await getTask(env.DB, taskId);
  if (!bot || !task) return json$3({ ok: false, errorCode: 404, description: "not found", reason: "invalid_request" }, 404);
  const client = new TelegramClient(bot.token);
  const result = await toResult(async () => {
    let copyId = messageId;
    if (!copyId) {
      const latest = await resolveLastN(client, task.source_chat_id, 1);
      copyId = latest.endId;
    }
    return client.copyMessage(task.dest_chat_id, task.source_chat_id, copyId);
  });
  return json$3(result, result.ok ? 200 : 400);
}
function json$2(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
async function handleListSavedTasks(env) {
  const saved = await listSavedTasks(env.DB);
  return json$2({ ok: true, data: saved });
}
async function handleGetSavedTask(env, id) {
  const saved = await getSavedTask(env.DB, id);
  if (!saved) return json$2({ ok: false, errorCode: 404, description: "saved task not found", reason: "invalid_request" }, 404);
  return json$2({ ok: true, data: saved });
}
async function handleCreateSavedTask(request, env) {
  const body = await request.json();
  const id = crypto.randomUUID();
  await insertSavedTask(env.DB, { ...body, id });
  return json$2({ ok: true, data: { id } }, 201);
}
async function handleDeleteSavedTask(env, id) {
  await deleteSavedTask(env.DB, id);
  return json$2({ ok: true, data: null });
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
function json$1(data, status = 200) {
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
  return json$1({ ok: true, data: statusData });
}
async function handleAuthLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const inputPassword = typeof body.password === "string" ? body.password : "";
  if (!inputPassword) {
    return json$1({ ok: false, errorCode: 400, description: "Password is required", reason: "invalid_request" }, 400);
  }
  if (inputPassword.length > 256) {
    return json$1({ ok: false, errorCode: 400, description: "Password exceeds maximum length (256 characters)", reason: "invalid_request" }, 400);
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
    return json$1({ ok: false, errorCode: 401, description: "Invalid password", reason: "unauthorized" }, 401);
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
  return json$1({ ok: true, data: { token } });
}
async function handleAuthSetup(request, env) {
  const { mode, source } = await getAuthMode(env);
  if (source === "env") {
    return json$1(
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
      return json$1(
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
    return json$1(
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
    return json$1(
      {
        ok: false,
        errorCode: 400,
        description: "Password exceeds maximum length (256 characters)",
        reason: "invalid_request"
      },
      400
    );
  }
  const salt = generateSalt();
  const hash = await hashPassword(newPassword, salt);
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('admin_password_hash', ?)").bind(hash),
    env.DB.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('admin_password_salt', ?)").bind(salt)
  ]);
  const secret = await getSigningSecret(env);
  const token = await signSessionToken(
    {
      sub: "admin",
      iat: Date.now(),
      exp: Date.now() + 30 * 24 * 60 * 60 * 1e3
    },
    secret
  );
  return json$1({ ok: true, data: { token } });
}
async function handleAuthRemove(request, env) {
  const { source } = await getAuthMode(env);
  if (source === "env") {
    return json$1(
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
    return json$1(
      { ok: false, errorCode: 401, description: "Authentication required", reason: "unauthorized" },
      401
    );
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM app_settings WHERE key = 'admin_password_hash'"),
    env.DB.prepare("DELETE FROM app_settings WHERE key = 'admin_password_salt'")
  ]);
  return json$1({ ok: true, data: { status: "removed" } });
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
  return json$1(
    {
      ok: false,
      errorCode: 401,
      description: "Admin authentication required",
      reason: "unauthorized"
    },
    401
  );
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
const index = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "api") {
      await ensureDatabaseBootstrap(env.DB);
      if (parts[1] === "health") {
        return json({ ok: true, data: { status: "up" } });
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
      const botId = url.searchParams.get("botId") ?? "";
      const botToken = url.searchParams.get("token") ?? "";
      const botTelegramId = url.searchParams.get("botTelegramId") ?? "";
      if (parts[1] === "bots" && parts.length === 2) {
        if (request.method === "GET") return handleListBots(env);
        if (request.method === "POST") return handleBulkAddBots(request, env, url.origin);
      }
      if (parts[1] === "bots" && parts[2] === "bulk" && parts.length === 3 && request.method === "POST") {
        return handleBulkAddBots(request, env, url.origin);
      }
      if (parts[1] === "channels" && parts.length === 2) {
        if (request.method === "GET") return handleListChannels(env, url.searchParams.get("role") ?? "");
        if (request.method === "POST") return handleBulkCreateChannels(request, env);
      }
      if (parts[1] === "channels" && parts[2] === "bulk" && parts.length === 3 && request.method === "POST") {
        return handleBulkCreateChannels(request, env);
      }
      if (parts[1] === "channels" && parts.length === 3) {
        if (request.method === "PATCH") return handleUpdateChannel(request, env, parts[2]);
        if (request.method === "DELETE") return handleDeleteChannel(env, parts[2]);
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
    await runTick(env);
  }
};
const workerEntry = index ?? {};
export {
  workerEntry as default
};
