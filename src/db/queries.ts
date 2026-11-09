import type {
  BackfillStatus,
  BotSummary,
  ErrorReason,
  SavedChannel,
  SavedTaskSummary,
  SavedTaskWithToken,
  SourceTaskHistory,
  TaskDetail,
  TaskScope,
  TaskSummary,
} from "../shared/rpcTypes";

// Bots — every SELECT here is column-scoped on purpose. Never `SELECT *`
// on this table from an API-facing path; the token must never serialize
// into a response.

export interface BotRow extends BotSummary {
  token: string;
  webhook_secret: string;
  last_update_id: number;
}

export async function insertBot(
  db: D1Database,
  row: { id: string; token: string; bot_id: number; bot_username: string; label: string; webhook_secret: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bots (id, token, bot_id, bot_username, label, webhook_secret, last_update_id) VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .bind(row.id, row.token, row.bot_id, row.bot_username, row.label, row.webhook_secret)
    .run();
}

export async function updateExistingBotDetails(
  db: D1Database,
  id: string,
  patch: { token: string; bot_username: string; label?: string },
): Promise<void> {
  if (patch.label) {
    await db
      .prepare(`UPDATE bots SET token = ?, bot_username = ?, label = ? WHERE id = ?`)
      .bind(patch.token, patch.bot_username, patch.label, id)
      .run();
  } else {
    await db
      .prepare(`UPDATE bots SET token = ?, bot_username = ? WHERE id = ?`)
      .bind(patch.token, patch.bot_username, id)
      .run();
  }
}

export async function listBotsSummary(db: D1Database): Promise<BotSummary[]> {
  const { results } = await db
    .prepare(`SELECT id, bot_id, bot_username, label, created_at FROM bots ORDER BY created_at DESC`)
    .all<BotSummary>();
  return results;
}

export async function listBotsWithSecrets(db: D1Database): Promise<BotRow[]> {
  const { results } = await db
    .prepare(`SELECT id, token, bot_id, bot_username, label, webhook_secret, last_update_id, created_at FROM bots ORDER BY created_at DESC`)
    .all<BotRow>();
  return results;
}

export async function updateBotLastUpdateId(db: D1Database, botId: string, lastUpdateId: number): Promise<void> {
  await db.prepare(`UPDATE bots SET last_update_id = ? WHERE id = ?`).bind(lastUpdateId, botId).run();
}

export async function countActiveLiveTasksForBot(db: D1Database, botId: string, excludeTaskId?: string): Promise<number> {
  let query = "SELECT COUNT(*) as c FROM tasks WHERE bot_id = ? AND live_enabled = 1";
  if (excludeTaskId) query += " AND id != ?";
  const stmt = excludeTaskId ? db.prepare(query).bind(botId, excludeTaskId) : db.prepare(query).bind(botId);
  const row = await stmt.first<{ c: number }>();
  return row?.c ?? 0;
}

export async function getBotWithSecrets(db: D1Database, id: string): Promise<BotRow | null> {
  const row = await db
    .prepare(`SELECT id, token, bot_id, bot_username, label, webhook_secret, last_update_id, created_at FROM bots WHERE id = ?`)
    .bind(id)
    .first<BotRow>();
  return row ?? null;
}

export async function findBotByWebhookSecret(db: D1Database, id: string, secret: string): Promise<BotRow | null> {
  const row = await db
    .prepare(
      `SELECT id, token, bot_id, bot_username, label, webhook_secret, created_at FROM bots WHERE id = ? AND webhook_secret = ?`,
    )
    .bind(id, secret)
    .first<BotRow>();
  return row ?? null;
}

export async function findBotByTokenOrBotId(
  db: D1Database,
  token: string,
  botTelegramId?: number,
): Promise<BotRow | null> {
  if (botTelegramId) {
    const row = await db
      .prepare(
        `SELECT id, token, bot_id, bot_username, label, webhook_secret, last_update_id, created_at FROM bots WHERE token = ? OR bot_id = ?`,
      )
      .bind(token, botTelegramId)
      .first<BotRow>();
    return row ?? null;
  }
  const row = await db
    .prepare(
      `SELECT id, token, bot_id, bot_username, label, webhook_secret, last_update_id, created_at FROM bots WHERE token = ?`,
    )
    .bind(token)
    .first<BotRow>();
  return row ?? null;
}

export async function updateBotLabel(db: D1Database, id: string, label: string): Promise<void> {
  await db.prepare(`UPDATE bots SET label = ? WHERE id = ?`).bind(label, id).run();
}

export async function deleteBot(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM bots WHERE id = ?`).bind(id).run();
}

// Saved Channels

export async function listSavedChannels(db: D1Database): Promise<SavedChannel[]> {
  const { results } = await db
    .prepare(`SELECT id, chat_id, title, username, chat_type, created_at FROM saved_channels ORDER BY created_at DESC, title ASC`)
    .all<SavedChannel>();
  return results;
}

export async function getSavedChannel(db: D1Database, id: string): Promise<SavedChannel | null> {
  const row = await db
    .prepare(`SELECT id, chat_id, title, username, chat_type, created_at FROM saved_channels WHERE id = ?`)
    .bind(id)
    .first<SavedChannel>();
  return row ?? null;
}

export async function findSavedChannelsMatching(
  db: D1Database,
  chatId: string,
  username?: string | null,
): Promise<SavedChannel[]> {
  if (username) {
    const cleanUser = username.replace(/^@/, "").toLowerCase();
    const { results } = await db
      .prepare(
        `SELECT id, chat_id, title, username, chat_type, created_at FROM saved_channels
         WHERE LOWER(chat_id) = LOWER(?) OR LOWER(chat_id) = ? OR LOWER(username) = ?`,
      )
      .bind(chatId, `@${cleanUser}`, cleanUser)
      .all<SavedChannel>();
    return results;
  }
  const { results } = await db
    .prepare(`SELECT id, chat_id, title, username, chat_type, created_at FROM saved_channels WHERE LOWER(chat_id) = LOWER(?)`)
    .bind(chatId)
    .all<SavedChannel>();
  return results;
}

export async function upsertSavedChannel(
  db: D1Database,
  input: {
    chat_id: string;
    title: string;
    username?: string | null;
    chat_type?: string | null;
    preserveCustomTitle?: boolean;
  },
): Promise<SavedChannel> {
  const matches = await findSavedChannelsMatching(db, input.chat_id, input.username);
  if (matches.length > 0) {
    // Prefer the row that already has the exact chat_id so UPDATE never collides with UNIQUE(chat_id)
    const primary = matches.find((m) => m.chat_id === input.chat_id) ?? matches[0];
    const duplicatesToRemove = matches.filter((m) => m.id !== primary.id);
    for (const dup of duplicatesToRemove) {
      await db.prepare(`DELETE FROM saved_channels WHERE id = ?`).bind(dup.id).run();
    }

    // Also preserve any custom title set on either the primary or alias row
    const customTitleRow = matches.find((m) => m.title && m.title !== m.chat_id && m.title !== `@${m.username}`);
    const nextTitle =
      input.preserveCustomTitle && customTitleRow
        ? customTitleRow.title
        : input.title || primary.title;
    const nextUsername =
      input.username !== undefined
        ? input.username
          ? input.username.replace(/^@/, "")
          : primary.username
        : primary.username;
    const nextType = input.chat_type ?? primary.chat_type;

    await db
      .prepare(`UPDATE saved_channels SET chat_id = ?, title = ?, username = ?, chat_type = ? WHERE id = ?`)
      .bind(input.chat_id, nextTitle, nextUsername ?? null, nextType ?? null, primary.id)
      .run();

    return {
      ...primary,
      chat_id: input.chat_id,
      title: nextTitle,
      username: nextUsername ?? null,
      chat_type: nextType ?? null,
    };
  }

  const id = crypto.randomUUID();
  const created_at = Math.floor(Date.now() / 1000);
  const cleanUsername = input.username ? input.username.replace(/^@/, "") : null;
  const title = input.title || input.chat_id;
  await db
    .prepare(
      `INSERT INTO saved_channels (id, chat_id, title, username, chat_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         title = excluded.title,
         username = COALESCE(excluded.username, saved_channels.username),
         chat_type = COALESCE(excluded.chat_type, saved_channels.chat_type)`,
    )
    .bind(id, input.chat_id, title, cleanUsername, input.chat_type ?? null, created_at)
    .run();

  const savedMatches = await findSavedChannelsMatching(db, input.chat_id, cleanUsername);
  return (
    savedMatches[0] ?? {
      id,
      chat_id: input.chat_id,
      title,
      username: cleanUsername,
      chat_type: input.chat_type ?? null,
      created_at,
    }
  );
}

export async function updateSavedChannel(
  db: D1Database,
  id: string,
  patch: { title?: string; chat_id?: string },
): Promise<SavedChannel | null> {
  const existing = await getSavedChannel(db, id);
  if (!existing) return null;
  const nextTitle = patch.title?.trim() || existing.title;
  const nextChatId = patch.chat_id?.trim() || existing.chat_id;

  // If changing chat_id to one that already exists on another row, remove the other row first to avoid UNIQUE collision
  if (nextChatId !== existing.chat_id) {
    await db
      .prepare(`DELETE FROM saved_channels WHERE LOWER(chat_id) = LOWER(?) AND id != ?`)
      .bind(nextChatId, id)
      .run();
  }

  await db
    .prepare(`UPDATE saved_channels SET title = ?, chat_id = ? WHERE id = ?`)
    .bind(nextTitle, nextChatId, id)
    .run();
  return getSavedChannel(db, id);
}

export async function deleteSavedChannel(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM saved_channels WHERE id = ?`).bind(id).run();
}

// Tasks

function rowToTask(row: Record<string, unknown>): TaskSummary {
  return {
    id: row.id as string,
    bot_id: row.bot_id as string,
    label: row.label as string,
    source_chat_id: row.source_chat_id as string,
    source_chat_title: (row.source_chat_title as string) ?? null,
    dest_chat_id: row.dest_chat_id as string,
    dest_chat_title: (row.dest_chat_title as string) ?? null,
    scope: row.scope as TaskScope,
    live_enabled: Boolean(row.live_enabled),
    backfill_mode: (row.backfill_mode as "range" | "lastN" | null) ?? null,
    start_id: (row.start_id as number) ?? null,
    end_id: (row.end_id as number) ?? null,
    cursor: (row.cursor as number) ?? null,
    total: (row.total as number) ?? null,
    processed: row.processed as number,
    failed: row.failed as number,
    live_processed: ((row.live_processed as number) ?? 0),
    live_failed: ((row.live_failed as number) ?? 0),
    live_skipped: ((row.live_skipped as number) ?? 0),
    filter_media_types: (row.filter_media_types as string) ?? null,
    filter_min_size_bytes: (row.filter_min_size_bytes as number) ?? null,
    filter_max_size_bytes: (row.filter_max_size_bytes as number) ?? null,
    pending_count: row.pending_count != null ? Number(row.pending_count) : undefined,
    backfill_status: row.backfill_status as BackfillStatus,
    pacing_batch_size: row.pacing_batch_size as number,
    stop_reason: (row.stop_reason as ErrorReason) ?? null,
    stopped_at: (row.stopped_at as number) ?? null,
    rate_limited_until: (row.rate_limited_until as number) ?? null,
    created_at: row.created_at as number,
  };
}

export interface NewTask {
  id: string;
  bot_id: string;
  label: string;
  source_chat_id: string;
  source_chat_title: string | null;
  dest_chat_id: string;
  dest_chat_title: string | null;
  scope: TaskScope;
  live_enabled: boolean;
  backfill_mode: "range" | "lastN" | null;
  start_id: number | null;
  end_id: number | null;
  cursor: number | null;
  total: number | null;
  backfill_status: BackfillStatus;
  pacing_batch_size: number;
  filter_media_types?: string | null;
  filter_min_size_bytes?: number | null;
  filter_max_size_bytes?: number | null;
}

export async function insertTask(db: D1Database, t: NewTask): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tasks (
        id, bot_id, label, source_chat_id, source_chat_title, dest_chat_id, dest_chat_title,
        scope, live_enabled, backfill_mode, start_id, end_id, cursor, total, backfill_status, pacing_batch_size,
        filter_media_types, filter_min_size_bytes, filter_max_size_bytes
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
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
      t.filter_max_size_bytes ?? null,
    )
    .run();
}

export async function listTasksByBot(db: D1Database, botId: string): Promise<TaskSummary[]> {
  const { results } = await db
    .prepare(`SELECT * FROM tasks WHERE bot_id = ? ORDER BY created_at DESC`)
    .bind(botId)
    .all();
  return results.map(rowToTask);
}

export async function listAllTasksSummary(db: D1Database): Promise<TaskSummary[]> {
  const { results } = await db
    .prepare(`SELECT * FROM tasks ORDER BY created_at DESC`)
    .all();
  return results.map(rowToTask);
}

export async function getTask(db: D1Database, id: string): Promise<TaskSummary | null> {
  const row = await db.prepare(`SELECT * FROM tasks WHERE id = ?`).bind(id).first();
  return row ? rowToTask(row) : null;
}

export async function getTaskWithBot(db: D1Database, id: string): Promise<TaskDetail | null> {
  const row = await db
    .prepare(
      `SELECT tasks.*,
              COALESCE(bots.bot_username, 'unknown') as bot_username,
              (SELECT COUNT(*) FROM task_pending_messages WHERE task_id = tasks.id) as pending_count
       FROM tasks
       LEFT JOIN bots ON bots.id = tasks.bot_id
       WHERE tasks.id = ?`,
    )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    ...rowToTask(row),
    bot_username: (row.bot_username as string) ?? "unknown",
  };
}

export async function listTasksForSourceChat(db: D1Database, chatIds: string[]): Promise<SourceTaskHistory[]> {
  if (chatIds.length === 0) return [];
  const placeholders = chatIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT
         tasks.*,
         COALESCE(bots.bot_username, 'unknown') as bot_username,
         COALESCE(bots.label, 'Bot') as bot_label,
         (SELECT MAX(at) FROM task_activity_log WHERE task_id = tasks.id) AS last_activity_at
       FROM tasks
       LEFT JOIN bots ON bots.id = tasks.bot_id
       WHERE tasks.source_chat_id IN (${placeholders})
       ORDER BY tasks.created_at DESC`,
    )
    .bind(...chatIds)
    .all<Record<string, unknown>>();

  return results.map((row) => {
    const task = rowToTask(row);
    const resolvedLastId = (task.cursor != null && task.cursor > 1 ? task.cursor - 1 : null) ?? task.end_id ?? null;
    return {
      ...task,
      bot_username: (row.bot_username as string) ?? "unknown",
      bot_label: (row.bot_label as string) ?? "Bot",
      last_copied_message_id: resolvedLastId,
      last_activity_at: row.last_activity_at != null ? Number(row.last_activity_at) : null,
    };
  });
}

export async function incrementTaskProcessed(db: D1Database, taskId: string): Promise<void> {
  await db.prepare(`UPDATE tasks SET processed = processed + 1 WHERE id = ?`).bind(taskId).run();
}

export async function findDuplicateTask(
  db: D1Database,
  botId: string,
  sourceChatId: string,
  destChatId: string,
): Promise<TaskSummary | null> {
  const row = await db
    .prepare(`SELECT * FROM tasks WHERE bot_id = ? AND source_chat_id = ? AND dest_chat_id = ?`)
    .bind(botId, sourceChatId, destChatId)
    .first();
  return row ? rowToTask(row) : null;
}

export async function findLiveTasksForChat(db: D1Database, botId: string, sourceChatId: string): Promise<TaskSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM tasks WHERE bot_id = ? AND source_chat_id = ? AND live_enabled = 1
       AND scope IN ('live', 'live_and_backfill')`,
    )
    .bind(botId, sourceChatId)
    .all();
  return results.map(rowToTask);
}

export async function listRunningBackfillTasks(db: D1Database): Promise<TaskSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM tasks WHERE backfill_status = 'running'
       AND (rate_limited_until IS NULL OR rate_limited_until <= unixepoch())
       ORDER BY bot_id, created_at, id`,
    )
    .all();
  return results.map(rowToTask);
}

export async function listActiveSyncTasks(db: D1Database): Promise<TaskSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM tasks 
       WHERE (backfill_status = 'running' OR live_enabled = 1)
       AND (rate_limited_until IS NULL OR rate_limited_until <= unixepoch())
       AND stop_reason IS NULL
       ORDER BY bot_id, created_at, id`,
    )
    .all();
  return results.map(rowToTask);
}

export async function updateTaskStatus(
  db: D1Database,
  id: string,
  patch: Partial<Pick<TaskSummary, "live_enabled" | "backfill_status">>,
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.live_enabled !== undefined) {
    sets.push("live_enabled = ?");
    binds.push(patch.live_enabled ? 1 : 0);
  }
  if (patch.backfill_status !== undefined) {
    sets.push("backfill_status = ?");
    binds.push(patch.backfill_status);
    if (patch.backfill_status === "cancelled") sets.push("stopped_at = unixepoch()");
  }
  if (patch.live_enabled === true || patch.backfill_status === "running" || patch.backfill_status === "paused") {
    sets.push("stop_reason = NULL", "stopped_at = NULL");
  }
  if (sets.length === 0) return;
  binds.push(id);
  await db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
}

export interface UpdateTaskConfig {
  label?: string;
  scope?: TaskScope;
  live_enabled?: boolean;
  backfill_mode?: "range" | "lastN" | null;
  backfill_status?: BackfillStatus;
  start_id?: number | null;
  end_id?: number | null;
  cursor?: number | null;
  total?: number | null;
  reset_progress?: boolean;
  filter_media_types?: string | null;
  filter_min_size_bytes?: number | null;
  filter_max_size_bytes?: number | null;
  clear_pending?: boolean;
}

export async function updateTaskConfig(
  db: D1Database,
  id: string,
  config: UpdateTaskConfig,
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];

  if (config.label !== undefined) {
    sets.push("label = ?");
    binds.push(config.label);
  }
  if (config.scope !== undefined) {
    sets.push("scope = ?");
    binds.push(config.scope);
  }
  if (config.live_enabled !== undefined) {
    sets.push("live_enabled = ?");
    binds.push(config.live_enabled ? 1 : 0);
  }
  if (config.backfill_mode !== undefined) {
    sets.push("backfill_mode = ?");
    binds.push(config.backfill_mode);
  }
  if (config.backfill_status !== undefined) {
    sets.push("backfill_status = ?");
    binds.push(config.backfill_status);
    if (config.backfill_status === "cancelled") sets.push("stopped_at = unixepoch()");
  }
  if (config.start_id !== undefined) {
    sets.push("start_id = ?");
    binds.push(config.start_id);
  }
  if (config.end_id !== undefined) {
    sets.push("end_id = ?");
    binds.push(config.end_id);
  }
  if (config.cursor !== undefined) {
    sets.push("cursor = ?");
    binds.push(config.cursor);
  }
  if (config.total !== undefined) {
    sets.push("total = ?");
    binds.push(config.total);
  }
  if (config.reset_progress) {
    sets.push("processed = 0", "failed = 0");
  }
  if (config.filter_media_types !== undefined) {
    sets.push("filter_media_types = ?");
    binds.push(config.filter_media_types);
  }
  if (config.filter_min_size_bytes !== undefined) {
    sets.push("filter_min_size_bytes = ?");
    binds.push(config.filter_min_size_bytes);
  }
  if (config.filter_max_size_bytes !== undefined) {
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

export async function extendTaskEndId(db: D1Database, taskId: string, messageId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE tasks
       SET end_id = MAX(COALESCE(end_id, 0), ?),
           cursor = CASE WHEN cursor IS NULL THEN ? ELSE cursor END,
           total = CASE WHEN backfill_status != 'complete' AND start_id IS NOT NULL THEN MAX(COALESCE(end_id, 0), ?) - start_id + 1 ELSE total END
       WHERE id = ?`,
    )
    .bind(messageId, messageId, messageId, taskId)
    .run();
}

export async function advanceTaskProgress(
  db: D1Database,
  id: string,
  patch: {
    cursor: number;
    processed: number;
    failed: number;
    live_processed?: number;
    live_failed?: number;
    backfill_status?: BackfillStatus;
  },
): Promise<{ backfill_status: BackfillStatus; complete: boolean }> {
  const row = await db
    .prepare(
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
       RETURNING backfill_status, end_id`,
    )
    .bind(
      patch.cursor,
      patch.processed,
      patch.failed,
      patch.live_processed ?? null,
      patch.live_failed ?? null,
      patch.backfill_status ?? null,
      patch.cursor,
      patch.backfill_status ?? null,
      patch.cursor,
      id,
    )
    .first<{ backfill_status: BackfillStatus; end_id: number | null }>();

  const isComplete = row?.backfill_status === "complete";
  return { backfill_status: row?.backfill_status ?? "running", complete: isComplete };
}

export async function incrementLiveCounters(
  db: D1Database,
  taskId: string,
  processedDelta = 1,
  failedDelta = 0,
  skippedDelta = 0,
): Promise<void> {
  await db
    .prepare(
      `UPDATE tasks
       SET live_processed = live_processed + ?,
           live_failed = live_failed + ?,
           live_skipped = live_skipped + ?
       WHERE id = ?`,
    )
    .bind(processedDelta, failedDelta, skippedDelta, taskId)
    .run();
}

export async function deleteTask(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM tasks WHERE id = ?`).bind(id).run();
}

export async function stopTasksForBot(
  db: D1Database,
  botId: string,
  reason: ErrorReason,
): Promise<{ id: string; processed: number; failed: number }[]> {
  const { results } = await db
    .prepare(
      `UPDATE tasks
       SET live_enabled = 0,
           backfill_status = CASE WHEN backfill_status IN ('running','paused') THEN 'failed' ELSE backfill_status END,
           stop_reason = ?,
           stopped_at = unixepoch()
       WHERE bot_id = ?
         AND stop_reason IS NULL
         AND (live_enabled = 1 OR backfill_status IN ('running','paused'))
       RETURNING id, processed, failed`,
    )
    .bind(reason, botId)
    .all<{ id: string; processed: number; failed: number }>();
  return results;
}

export async function stopTask(db: D1Database, id: string, reason: ErrorReason): Promise<void> {
  await db
    .prepare(
      `UPDATE tasks
       SET live_enabled = 0,
           backfill_status = CASE WHEN backfill_status IN ('running','paused') THEN 'failed' ELSE backfill_status END,
           stop_reason = ?,
           stopped_at = unixepoch()
       WHERE id = ? AND stop_reason IS NULL`,
    )
    .bind(reason, id)
    .run();
}

export async function claimTask(db: D1Database, id: string, leaseSeconds: number): Promise<TaskSummary | null> {
  const row = await db
    .prepare(
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
       RETURNING *`,
    )
    .bind(leaseSeconds, id)
    .first();
  return row ? rowToTask(row) : null;
}

export async function pauseBotForRateLimit(db: D1Database, botId: string, until: number): Promise<void> {
  await db
    .prepare(
      `UPDATE tasks SET rate_limited_until = ?
       WHERE bot_id = ? AND (backfill_status = 'running' OR live_enabled = 1)`,
    )
    .bind(until, botId)
    .run();
}

export interface BotRateLimitStats {
  is_cooling_down: boolean;
  cooldown_until: number | null;
  cooldown_seconds_remaining: number;
  events_last_24h: number;
}

export async function getBotRateLimitStats(db: D1Database, botId: string): Promise<BotRateLimitStats> {
  const now = Math.floor(Date.now() / 1000);

  const cooldownRow = await db
    .prepare(
      `SELECT MAX(rate_limited_until) as max_until
       FROM tasks
       WHERE bot_id = ? AND rate_limited_until > ?`,
    )
    .bind(botId, now)
    .first<{ max_until: number | null }>();

  const maxUntil = cooldownRow?.max_until ?? null;

  const historyRow = await db
    .prepare(
      `SELECT COUNT(*) as c
       FROM task_activity_log tal
       JOIN tasks t ON t.id = tal.task_id
       WHERE t.bot_id = ? AND tal.detail LIKE '%rate limited%' AND tal.at >= ?`,
    )
    .bind(botId, now - 86400)
    .first<{ c: number }>();

  return {
    is_cooling_down: maxUntil !== null && maxUntil > now,
    cooldown_until: maxUntil,
    cooldown_seconds_remaining: maxUntil ? Math.max(0, maxUntil - now) : 0,
    events_last_24h: historyRow?.c ?? 0,
  };
}

export async function releaseTaskLease(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE tasks SET lease_expires_at = NULL WHERE id = ?`).bind(id).run();
}

// Activity log

export async function appendActivityLog(
  db: D1Database,
  entry: { task_id: string; kind: "live_forward" | "backfill_batch"; detail?: string; ok: boolean; error?: string },
): Promise<void> {
  await db
    .prepare(`INSERT INTO task_activity_log (task_id, kind, detail, ok, error) VALUES (?,?,?,?,?)`)
    .bind(entry.task_id, entry.kind, entry.detail ?? null, entry.ok ? 1 : 0, entry.error ?? null)
    .run();
}

export async function listActivityLog(db: D1Database, taskId: string, limit = 50) {
  const { results } = await db
    .prepare(`SELECT * FROM task_activity_log WHERE task_id = ? ORDER BY at DESC LIMIT ?`)
    .bind(taskId, limit)
    .all();
  return results;
}

const ACTIVITY_LOG_KEEP_PER_TASK = 100;

export async function pruneActivityLog(db: D1Database, taskId: string, keepLimit = ACTIVITY_LOG_KEEP_PER_TASK): Promise<void> {
  await db
    .prepare(
      `DELETE FROM task_activity_log WHERE task_id = ? AND id NOT IN (
         SELECT id FROM task_activity_log WHERE task_id = ? ORDER BY at DESC LIMIT ?
       )`,
    )
    .bind(taskId, taskId, keepLimit)
    .run();
}

export async function pruneAllActivityLogs(db: D1Database, keepLimit = ACTIVITY_LOG_KEEP_PER_TASK): Promise<void> {
  await db
    .prepare(
      `DELETE FROM task_activity_log WHERE id NOT IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY at DESC) as rn
           FROM task_activity_log
         ) WHERE rn <= ?
       )`,
    )
    .bind(keepLimit)
    .run();
}

// Raw update log (debugging)

export async function insertUpdate(db: D1Database, botId: string, updateId: number, payload: unknown): Promise<void> {
  await db
    .prepare(`INSERT INTO updates (bot_id, update_id, payload_json) VALUES (?, ?, ?)`)
    .bind(botId, updateId, JSON.stringify(payload))
    .run();
}

// Saved Tasks

export interface NewSavedTask {
  id: string;
  task_id: string | null;
  bot_token: string;
  bot_label: string;
  bot_username: string;
  source_chat_id: string;
  source_chat_title: string | null;
  dest_chat_id: string;
  dest_chat_title: string | null;
  scope: TaskScope;
  backfill_mode: "range" | "lastN" | null;
  start_id: number | null;
  end_id: number | null;
  n: number | null;
  pacing_batch_size: number;
  filter_media_types?: string | null;
  filter_min_size_bytes?: number | null;
  filter_max_size_bytes?: number | null;
}

export async function insertSavedTask(db: D1Database, t: NewSavedTask): Promise<void> {
  await db
    .prepare(
      `INSERT INTO saved_tasks (
        id, task_id, bot_token, bot_label, bot_username,
        source_chat_id, source_chat_title, dest_chat_id, dest_chat_title,
        scope, backfill_mode, start_id, end_id, n, pacing_batch_size,
        filter_media_types, filter_min_size_bytes, filter_max_size_bytes
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
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
      t.filter_max_size_bytes ?? null,
    )
    .run();
}

export async function listSavedTasks(db: D1Database): Promise<SavedTaskSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT id, task_id, bot_label, bot_username,
              substr(bot_token, 1, 6) || '…' || substr(bot_token, -4) AS token_preview,
              source_chat_id, source_chat_title, dest_chat_id, dest_chat_title,
              scope, backfill_mode, start_id, end_id, n, pacing_batch_size,
              filter_media_types, filter_min_size_bytes, filter_max_size_bytes,
              created_at
       FROM saved_tasks ORDER BY created_at DESC`,
    )
    .all<SavedTaskSummary>();
  return results;
}

export async function getSavedTask(db: D1Database, id: string): Promise<SavedTaskWithToken | null> {
  const row = await db
    .prepare(
      `SELECT id, task_id, bot_token, bot_label, bot_username,
              substr(bot_token, 1, 6) || '…' || substr(bot_token, -4) AS token_preview,
              source_chat_id, source_chat_title, dest_chat_id, dest_chat_title,
              scope, backfill_mode, start_id, end_id, n, pacing_batch_size,
              filter_media_types, filter_min_size_bytes, filter_max_size_bytes,
              created_at
       FROM saved_tasks WHERE id = ?`,
    )
    .bind(id)
    .first<SavedTaskWithToken>();
  return row ?? null;
}

export async function deleteSavedTask(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM saved_tasks WHERE id = ?`).bind(id).run();
}

// Pending messages queue

export interface PendingMessageRow {
  id: number;
  task_id: string;
  message_id: number;
  media_type?: string | null;
  file_size?: number | null;
  file_name?: string | null;
  created_at: number;
}

export async function insertPendingMessage(
  db: D1Database,
  taskId: string,
  messageId: number,
  mediaType?: string | null,
  fileSize?: number | null,
  fileName?: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO task_pending_messages (task_id, message_id, media_type, file_size, file_name)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(taskId, messageId, mediaType ?? null, fileSize ?? null, fileName ?? null)
    .run();
}

export async function listPendingMessages(db: D1Database, taskId: string, limit = 50): Promise<PendingMessageRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM task_pending_messages WHERE task_id = ? ORDER BY id ASC LIMIT ?`)
    .bind(taskId, limit)
    .all<PendingMessageRow>();
  return results;
}

export async function countPendingMessages(db: D1Database, taskId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as count FROM task_pending_messages WHERE task_id = ?`)
    .bind(taskId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function deletePendingMessages(db: D1Database, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  await db.prepare(`DELETE FROM task_pending_messages WHERE id IN (${placeholders})`).bind(...ids).run();
}

export async function listTasksWithPendingMessages(db: D1Database): Promise<TaskSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT tasks.* FROM tasks
       JOIN task_pending_messages ON task_pending_messages.task_id = tasks.id
       WHERE (tasks.rate_limited_until IS NULL OR tasks.rate_limited_until <= unixepoch())
         AND (tasks.lease_expires_at IS NULL OR tasks.lease_expires_at < unixepoch())
         AND tasks.live_enabled = 1
         AND tasks.stop_reason IS NULL
         AND tasks.backfill_status != 'running'
       ORDER BY tasks.bot_id, tasks.created_at, tasks.id`,
    )
    .all();
  return results.map(rowToTask);
}
