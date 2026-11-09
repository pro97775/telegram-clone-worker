import { TelegramClient } from "../telegram/client";
import { TelegramApiError } from "../telegram/errors";
import {
  advanceTaskProgress,
  appendActivityLog,
  claimTask,
  deletePendingMessages,
  getBotWithSecrets,
  incrementLiveCounters,
  insertPendingMessage,
  listActiveSyncTasks,
  listPendingMessages,
  listTasksWithPendingMessages,
  pauseBotForRateLimit,
  pruneActivityLog,
  releaseTaskLease,
  stopTask,
  stopTasksForBot,
  updateBotLastUpdateId,
  type BotRow,
} from "../db/queries";
import type { TaskSummary } from "../shared/rpcTypes";
import { runWithConcurrency } from "../shared/concurrencyPool";
import {
  evaluateMessageFilter,
  extractMessageMetadata,
  formatBytes,
  getMediaIcon,
} from "../shared/messageFilter";

const MAX_CONCURRENT_BOTS = 6;
const MAX_BATCH_IDS = 100;
const LEASE_SECONDS = 240;

export const RATE_LIMIT_COOLDOWN_MIN_SECONDS = 60;
export const RATE_LIMIT_COOLDOWN_MAX_SECONDS = 120;

export async function runTick(env: Env): Promise<void> {
  const tickStartedAtMs = Date.now();
  const tasks = await listActiveSyncTasks(env.DB);

  // Group by bot_id — tasks arrive pre-sorted by bot_id
  const groups: TaskSummary[][] = [];
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
  const MAX_TICK_WALL_TIME_MS = isSmoothMode ? 50_000 : 38_000;

  if (!isSmoothMode && groups.length > 0) {
    const offset = Math.floor(tickStartedAtMs / 60_000) % groups.length;
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

      // 1. Pull-based Auto-Sync: Check for new Telegram updates once per bot and fan out to all matching target tasks
      const hasLive = groupTasks.some((t) => t.live_enabled);
      if (hasLive) {
        try {
          const MAX_PULL_PAGES = 5;
          let page = 0;
          let currentOffset = bot.last_update_id > 0 ? bot.last_update_id + 1 : undefined;
          let maxUpdateId = bot.last_update_id;

          while (page < MAX_PULL_PAGES) {
            page++;
            const updates = await client.getUpdates({
              offset: currentOffset,
              limit: 100,
              allowed_updates: ["channel_post"],
            });
            if (!updates || updates.length === 0) break;

            for (const update of updates) {
              if (update.update_id > maxUpdateId) maxUpdateId = update.update_id;
              const post = update.channel_post;
              if (!post) continue;
              const chatStr = String(post.chat.id);
              const chatUsername = post.chat.username ? `@${post.chat.username.toLowerCase()}` : null;
              const matchingTasks = groupTasks.filter(
                (t) =>
                  t.live_enabled &&
                  (t.source_chat_id === chatStr ||
                    (chatUsername && t.source_chat_id.toLowerCase() === chatUsername)),
              );
              if (matchingTasks.length === 0) continue;

              const meta = extractMessageMetadata(post);
              const icon = getMediaIcon(meta.type);
              const sizeStr = meta.size ? formatBytes(meta.size) : "";
              const fileDesc = [icon, sizeStr, meta.name ? `(${meta.name})` : ""].filter(Boolean).join(" ");

              for (const t of matchingTasks) {
                if (t.cursor === null && t.backfill_status === "not_applicable") {
                  t.cursor = post.message_id;
                }

                const filterMediaTypes = t.filter_media_types
                  ? t.filter_media_types.split(",").map((s) => s.trim()).filter(Boolean)
                  : undefined;
                const evalResult = evaluateMessageFilter(post, {
                  mediaTypes: filterMediaTypes,
                  minSizeBytes: t.filter_min_size_bytes,
                  maxSizeBytes: t.filter_max_size_bytes,
                });

                if (!evalResult.matched) {
                  await incrementLiveCounters(env.DB, t.id, 0, 0, 1);
                  t.live_skipped = (t.live_skipped ?? 0) + 1;
                  await appendActivityLog(env.DB, {
                    task_id: t.id,
                    kind: "live_forward",
                    detail: `${fileDesc} · msg #${post.message_id} skipped: ${evalResult.reason}`,
                    ok: false,
                    error: `Filtered: ${evalResult.reason}`,
                  });
                  continue;
                }

                await insertPendingMessage(
                  env.DB,
                  t.id,
                  post.message_id,
                  meta.type,
                  meta.size ?? null,
                  meta.name ?? null,
                );

                if (t.backfill_status === "running") {
                  await appendActivityLog(env.DB, {
                    task_id: t.id,
                    kind: "live_forward",
                    detail: `⏳ Queued in buffer: ${fileDesc} · msg #${post.message_id} (waiting for backfill to finish)`,
                    ok: true,
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
                  error: "401 Unauthorized",
                });
              }
              return;
            }
            if (e.errorCode === 409 || (typeof e.message === "string" && e.message.toLowerCase().includes("webhook"))) {
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

      // 2. Process tasks that have messages to copy (cursor <= end_id).
      // When 1 bot is backfilling to multiple target channels simultaneously, share the
      // per-minute bot batch quota evenly across active backfill tasks on that bot so all
      // target channels advance every tick without tripping Telegram's 60 msg/min per-bot limit.
      const activeBackfillTasksInGroup = groupTasks.filter(
        (t) => t.cursor !== null && t.end_id !== null && t.cursor <= t.end_id,
      );
      const concurrentBackfillCount = Math.max(1, activeBackfillTasksInGroup.length);

      for (const task of groupTasks) {
        if (task.backfill_status === "running" && task.cursor !== null && task.end_id !== null && task.cursor > task.end_id) {
          const res = await advanceTaskProgress(env.DB, task.id, {
            cursor: task.cursor,
            processed: task.processed,
            failed: task.failed,
            backfill_status: "complete",
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
          const effectiveBatchSize =
            concurrentBackfillCount > 1
              ? Math.max(10, Math.floor(claimed.pacing_batch_size / concurrentBackfillCount))
              : claimed.pacing_batch_size;
          const skipBotForRest = await processOneBatch(env, claimed, bot, client, effectiveBatchSize);
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

  // Also drain pending messages for live-enabled tasks that are not rate-limited
  const tasksWithPending = await listTasksWithPendingMessages(env.DB);
  const pausedOrStoppedBots = new Set<string>();
  for (const pTask of tasksWithPending) {
    if (pausedOrStoppedBots.has(pTask.bot_id)) continue;
    try {
      const botPaused = await drainPendingMessagesForTask(env, pTask);
      if (botPaused) pausedOrStoppedBots.add(pTask.bot_id);
    } catch (e) {
      console.error(`tick: draining pending messages for task ${pTask.id} failed`, e);
    }
  }

  const wallTimeMs = Date.now() - tickStartedAtMs;
  console.log(`tick: ${groups.length} group(s), ${tasks.length} task(s), ${batchesRun} batch(es), mode: ${isSmoothMode ? "smooth" : "round-robin"}, ${wallTimeMs}ms`);
}

/** Drains buffered live messages in chronological order once backfill completes. */
async function drainPendingMessagesForTask(env: Env, task: TaskSummary): Promise<boolean> {
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
        ok: true,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (e instanceof TelegramApiError && e.reason === "rate_limited") {
        const waitSeconds = Math.min(
          Math.max(e.retryAfter ?? 0, RATE_LIMIT_COOLDOWN_MIN_SECONDS),
          RATE_LIMIT_COOLDOWN_MAX_SECONDS,
        );
        await pauseBotForRateLimit(env.DB, task.bot_id, Math.floor(Date.now() / 1000) + waitSeconds);
        return true;
      }
      if (e instanceof TelegramApiError && e.reason === "unauthorized") {
        await stopTasksForBot(env.DB, task.bot_id, "unauthorized");
        return true;
      }
      if (
        e instanceof TelegramApiError &&
        (e.message.toLowerCase().includes("not found") ||
          e.message.toLowerCase().includes("message to forward not found") ||
          e.message.toLowerCase().includes("message to copy not found"))
      ) {
        await deletePendingMessages(env.DB, [item.id]);
        await appendActivityLog(env.DB, {
          task_id: task.id,
          kind: "live_forward",
          detail: `msg #${item.message_id}: not found in source, removed from queue`,
          ok: false,
          error,
        });
      }
      break;
    }
  }
  return false;
}

async function processOneBatch(
  env: Env,
  task: TaskSummary,
  botParam?: BotRow,
  clientParam?: TelegramClient,
  batchSizeOverride?: number,
): Promise<boolean> {
  if (task.cursor === null || task.end_id === null) return false;
  const bot = botParam ?? (await getBotWithSecrets(env.DB, task.bot_id));
  if (!bot) return false;
  const client = clientParam ?? new TelegramClient(bot.token);

  const pacingSize = batchSizeOverride ?? task.pacing_batch_size;
  const batchStartedAtMs = Date.now();
  const batchEnd = Math.min(task.cursor + pacingSize - 1, task.end_id, task.cursor + MAX_BATCH_IDS - 1);
  const messageIds: number[] = [];
  for (let id = task.cursor; id <= batchEnd; id++) messageIds.push(id);

  let succeeded: number;
  try {
    const results = await client.copyMessages(task.dest_chat_id, task.source_chat_id, messageIds);
    succeeded = results.length;
  } catch (e) {
    if (e instanceof TelegramApiError && e.reason === "rate_limited") {
      const waitSeconds = Math.min(
        Math.max(e.retryAfter ?? 0, RATE_LIMIT_COOLDOWN_MIN_SECONDS),
        RATE_LIMIT_COOLDOWN_MAX_SECONDS,
      );
      await pauseBotForRateLimit(env.DB, task.bot_id, Math.floor(Date.now() / 1000) + waitSeconds);
      await appendActivityLog(env.DB, {
        task_id: task.id,
        kind: "backfill_batch",
        detail: `ids ${task.cursor}-${batchEnd}: rate limited, pausing bot for ${waitSeconds}s`,
        ok: true,
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
          error: e.message,
        });
      }
      return true;
    }
    if (
      e instanceof TelegramApiError &&
      (e.message.toLowerCase().includes("no messages to forward") || /failed to send message #\d+\b/i.test(e.message))
    ) {
      succeeded = 0;
    } else if (e instanceof TelegramApiError && (e.reason === "bot_not_in_chat" || e.reason === "insufficient_permissions")) {
      await stopTask(env.DB, task.id, e.reason);
      await appendActivityLog(env.DB, {
        task_id: task.id,
        kind: "backfill_batch",
        detail: `ids ${task.cursor}-${batchEnd}: ${e.reason} — task auto-stopped`,
        ok: false,
        error: e.message,
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
        error: message,
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
    live_failed: newLiveFailed,
  });

  const justCompletedBackfill = wasBackfilling && progressResult.complete;
  const isLiveScope = task.scope === "live" || (task.scope === "live_and_backfill" && !wasBackfilling);
  await appendActivityLog(env.DB, {
    task_id: task.id,
    kind: isLiveScope ? "live_forward" : "backfill_batch",
    detail: `ids ${task.cursor}-${batchEnd}: ${succeeded} ok, ${skipped} skipped, took ${batchDurationMs}ms${justCompletedBackfill ? " (backfill complete)" : ""}`,
    ok: true,
    error: skipped > 0 ? `${skipped} message(s) in this range skipped by Telegram (not found / can't be copied)` : undefined,
  });

  if (progressResult.complete || Math.random() < 0.05) {
    await pruneActivityLog(env.DB, task.id);
  }
  return false;
}
