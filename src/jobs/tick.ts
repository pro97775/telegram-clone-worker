import { TelegramClient } from "../telegram/client";
import { TelegramApiError } from "../telegram/errors";
import type { TelegramMessage } from "../telegram/types";
import {
  advanceTaskProgress,
  appendActivityLog,
  claimTask,
  deletePendingMessages,
  getBotWithSecrets,
  hasPendingMessages,
  incrementLiveCounters,
  insertPendingMessage,
  listActiveSyncTasks,
  listPendingMessages,
  markBackfillComplete,
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
  isServiceMessage,
} from "../shared/messageFilter";

// Cloudflare: "Each Worker invocation can have up to six connections
// simultaneously waiting for response headers." Past six, extra fetches are
// silently queued, not rejected — and processOneBatch brackets its
// copyMessages call with Date.now() and writes `took ${ms}ms` into
// task_activity_log (the same series DEFAULT_PACING_BATCH_SIZE was derived
// from, src/routes/api/tasks.ts). A queued fetch would log connection-slot
// wait time as if it were Telegram latency, corrupting that measurement.
// Each bot group holds at most one connection at a time (its own tasks stay
// sequential — see the bot-scoped lease in claimTask), so 6 groups in
// flight = 6 connection slots, exactly at the ceiling. D1 goes over the
// binding RPC channel, not this fetch pool, and CPU isn't a concern —
// wall-clock spent awaiting fetch doesn't count toward the 30s cron CPU
// limit — so 6 is purely about not corrupting the timing log.
const MAX_CONCURRENT_BOTS = 6;

// Telegram's copyMessages accepts at most 100 message_ids per call.
const MAX_BATCH_IDS = 100;

// Fixed crash-recovery backstop (not a per-batch timing budget — doesn't
// scale with pacing_batch_size). ~5x the worst measured batch time
// (src/routes/api/tasks.ts defaultPacingBatchSize comment: up to ~47s),
// long enough to comfortably outlast a legitimate batch, short enough that
// a killed/evicted invocation that never reaches its `finally` self-heals
// within a handful of 1-minute ticks.
const LEASE_SECONDS = 240;

// When a task's copyMessages call comes back rate_limited, pause every
// active task on that bot for this long before the tick job or the live
// webhook will try that bot again — floors/caps Telegram's own
// `retry_after` into a "one or two ticks" window instead of trusting
// whatever gap the next cron minute happens to land on.
export const RATE_LIMIT_COOLDOWN_MIN_SECONDS = 60;
export const RATE_LIMIT_COOLDOWN_MAX_SECONDS = 120;

// getUpdates pages pulled per bot per tick (100 updates each).
const MAX_PULL_PAGES = 5;

// Telegram keeps undelivered updates for up to 24h, so the first poll after a live task is
// created can return posts from before it existed. Those are skipped; the grace window covers
// the gap between the "last N" probe and the task insert, plus clock skew.
const LIVE_BACKLOG_GRACE_SECONDS = 5;

// Queued live messages delivered per task per tick (one copyMessage call each).
const MAX_PENDING_DRAIN_PER_TICK = 60;

// Pruning runs a subquery DELETE, so it's sampled instead of run after every log write.
const ACTIVITY_PRUNE_SAMPLE_RATE = 0.05;

type ActivityKind = "live_forward" | "backfill_batch";

interface WorkOutcome {
  /** The bot was rate-limited or its token is dead — skip its remaining work this tick. */
  haltBot: boolean;
}

interface BatchOutcome extends WorkOutcome {
  backfillComplete: boolean;
}

interface DrainOutcome extends WorkOutcome {
  delivered: number;
}

export async function runTick(env: Env): Promise<void> {
  const tickStartedAtMs = Date.now();
  const tasks = await listActiveSyncTasks(env.DB);

  // Group by bot_id — tasks arrive pre-sorted by bot_id (listActiveSyncTasks'
  // ORDER BY), so a simple adjacent-run grouping is enough.
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
  // If <= 50 bots: Smooth & Stable Mode (all bots run every tick, budget 50s).
  // If > 50 bots: Round-Robin Mode (rotate by minute, budget 38s to prevent timeout).
  const isSmoothMode = totalBots <= 50;
  const MAX_TICK_WALL_TIME_MS = isSmoothMode ? 50_000 : 38_000;

  if (!isSmoothMode && groups.length > 0) {
    const offset = Math.floor(tickStartedAtMs / 60_000) % groups.length;
    groups.push(...groups.splice(0, offset));
  }

  let batchesRun = 0;
  let liveDelivered = 0;
  await runWithConcurrency(groups, MAX_CONCURRENT_BOTS, async (groupTasks) => {
    // In Round-Robin mode, honor the time budget to avoid overlapping next cron
    if (!isSmoothMode && Date.now() - tickStartedAtMs > MAX_TICK_WALL_TIME_MS) {
      return;
    }

    const botId = groupTasks[0].bot_id;
    try {
      const bot = await getBotWithSecrets(env.DB, botId);
      if (!bot) return;
      const client = new TelegramClient(bot.token);

      // 1. Pull new posts into each matching live task's pending queue.
      const poll = await pollLiveUpdates(env, bot, client, groupTasks);
      if (poll.haltBot) return;

      // 2. Copy the next batch of every running backfill.
      for (const task of groupTasks) {
        if (task.backfill_status !== "running" || task.cursor === null || task.end_id === null) continue;
        if (task.cursor > task.end_id) {
          if (await markBackfillComplete(env.DB, task.id)) task.backfill_status = "complete";
          continue;
        }

        const claimed = await claimTask(env.DB, task.id, LEASE_SECONDS, "backfill");
        if (!claimed) continue;
        let outcome: BatchOutcome = { haltBot: false, backfillComplete: false };
        try {
          batchesRun++;
          outcome = await processOneBatch(env, claimed, client);
        } catch (e) {
          console.error(`tick: task ${claimed.id} failed`, e);
        } finally {
          await releaseTaskLease(env.DB, claimed.id);
        }
        if (outcome.haltBot) return;
        if (outcome.backfillComplete) task.backfill_status = "complete";
      }

      // 3. Deliver queued live messages for tasks whose backfill (if any) is out of the way.
      for (const task of groupTasks) {
        if (!task.live_enabled || task.backfill_status === "running") continue;
        if (!(await hasPendingMessages(env.DB, task.id))) continue;

        const claimed = await claimTask(env.DB, task.id, LEASE_SECONDS, "live");
        if (!claimed) continue;
        let outcome: DrainOutcome = { haltBot: false, delivered: 0 };
        try {
          outcome = await drainPendingMessagesForTask(env, claimed, client);
        } catch (e) {
          console.error(`tick: draining pending messages for task ${claimed.id} failed`, e);
        } finally {
          await releaseTaskLease(env.DB, claimed.id);
        }
        liveDelivered += outcome.delivered;
        if (outcome.haltBot) return;
      }
    } catch (e) {
      console.error(`tick: bot ${botId} group failed`, e);
    }
  });

  const wallTimeMs = Date.now() - tickStartedAtMs;
  console.log(
    `tick: ${groups.length} group(s), ${tasks.length} task(s), ${batchesRun} batch(es), ${liveDelivered} live message(s), mode: ${isSmoothMode ? "smooth" : "round-robin"}, ${wallTimeMs}ms`,
  );
}

function rateLimitCooldownSeconds(retryAfter?: number): number {
  return Math.min(Math.max(retryAfter ?? 0, RATE_LIMIT_COOLDOWN_MIN_SECONDS), RATE_LIMIT_COOLDOWN_MAX_SECONDS);
}

function describeMedia(type: string, size?: number | null, name?: string | null): string {
  return [getMediaIcon(type), size ? formatBytes(size) : "", name ? `(${name})` : ""].filter(Boolean).join(" ");
}

/** Failures that mean one of the task's chats is unusable — not just one message — so retrying
 * can't help until access is fixed in Telegram and the task is resumed. */
function isChatLevelFailure(e: TelegramApiError): boolean {
  return (
    e.reason === "bot_not_in_chat" ||
    e.reason === "insufficient_permissions" ||
    e.message.toLowerCase().includes("upgraded to a supergroup")
  );
}

async function maybePruneActivityLog(env: Env, taskId: string, force = false): Promise<void> {
  if (force || Math.random() < ACTIVITY_PRUNE_SAMPLE_RATE) {
    await pruneActivityLog(env.DB, taskId);
  }
}

/** Pauses every active task on the bot after any one of them trips Telegram's rate limit. */
async function pauseBotAfterRateLimit(
  env: Env,
  task: TaskSummary,
  kind: ActivityKind,
  subject: string,
  retryAfter?: number,
): Promise<void> {
  // Honor Telegram's own retry_after when given, but floor/cap it to a "one or two ticks"
  // window rather than trusting whatever gap the next cron minute happens to land on.
  const waitSeconds = rateLimitCooldownSeconds(retryAfter);
  await pauseBotForRateLimit(env.DB, task.bot_id, Math.floor(Date.now() / 1000) + waitSeconds);
  await appendActivityLog(env.DB, {
    task_id: task.id,
    kind,
    detail: `${subject}: rate limited, pausing bot for ${waitSeconds}s`,
    ok: true,
  });
}

/** A revoked/invalid token is fatal for every task on the bot, not just whichever one noticed. */
async function stopBotForUnauthorized(env: Env, botId: string, kind: ActivityKind, error: string): Promise<void> {
  const stopped = await stopTasksForBot(env.DB, botId, "unauthorized");
  for (const t of stopped) {
    await appendActivityLog(env.DB, {
      task_id: t.id,
      kind,
      detail: `bot token unauthorized (401) — task auto-stopped (${t.processed} copied, ${t.failed} failed before stopping). The token may have been revoked or changed in @BotFather.`,
      ok: false,
      error,
    });
  }
}

/** Pulls new posts with getUpdates and queues the ones each live task should forward. */
async function pollLiveUpdates(
  env: Env,
  bot: BotRow,
  client: TelegramClient,
  groupTasks: TaskSummary[],
): Promise<WorkOutcome> {
  const liveTasks = groupTasks.filter((t) => t.live_enabled);
  if (liveTasks.length === 0) return { haltBot: false };

  // getUpdates is one shared stream per bot. Holding the bot-scoped lease while polling keeps
  // two overlapping ticks from reading — and queueing — the same posts twice.
  const lease = await claimTask(env.DB, liveTasks[0].id, LEASE_SECONDS, "live");
  if (!lease) return { haltBot: false };

  try {
    for (let page = 0; page < MAX_PULL_PAGES; page++) {
      const updates = await client.getUpdates({
        offset: bot.last_update_id > 0 ? bot.last_update_id + 1 : undefined,
        limit: 100,
        // Channels deliver posts as channel_post; groups deliver them as message.
        allowed_updates: ["channel_post", "message"],
      });
      if (!updates || updates.length === 0) break;

      let maxUpdateId = bot.last_update_id;
      for (const update of updates) {
        maxUpdateId = Math.max(maxUpdateId, update.update_id);
        const post = update.channel_post ?? update.message;
        if (!post || isServiceMessage(post)) continue;
        const chatId = String(post.chat.id);
        for (const task of liveTasks) {
          if (task.source_chat_id === chatId) await queueLivePost(env, task, post);
        }
      }

      // Persist the offset after every page so a failure on a later page can't replay — and
      // re-queue — posts this page already queued.
      if (maxUpdateId > bot.last_update_id) {
        await updateBotLastUpdateId(env.DB, bot.id, maxUpdateId);
        bot.last_update_id = maxUpdateId;
      }
      if (updates.length < 100) break;
    }
    return { haltBot: false };
  } catch (e) {
    if (e instanceof TelegramApiError && e.reason === "unauthorized") {
      console.warn(`tick: bot ${bot.bot_username} unauthorized (401), stopping its tasks.`);
      await stopBotForUnauthorized(env, bot.id, "live_forward", e.message);
      return { haltBot: true };
    }
    if (e instanceof TelegramApiError && e.reason === "rate_limited") {
      await pauseBotAfterRateLimit(env, lease, "live_forward", "getUpdates", e.retryAfter);
      return { haltBot: true };
    }
    if (e instanceof TelegramApiError && (e.errorCode === 409 || e.message.toLowerCase().includes("webhook"))) {
      // A webhook (or another poller) owns this bot's update stream. Clearing the webhook lets the
      // next tick poll again; backfill and queued deliveries below don't depend on it.
      console.warn(`tick: getUpdates conflict for bot ${bot.bot_username}, calling deleteWebhook to restore polling.`);
      try {
        await client.deleteWebhook();
      } catch (delErr) {
        console.error(`tick: failed to deleteWebhook for bot ${bot.bot_username}:`, delErr);
      }
      return { haltBot: false };
    }
    console.error(`tick: getUpdates failed for bot ${bot.bot_username}`, e);
    return { haltBot: false };
  } finally {
    await releaseTaskLease(env.DB, lease.id);
  }
}

/** Decides what happens to one new source-chat post for one live task: ignore it, record it as
 * filtered out, or add it to the task's pending queue for delivery. */
async function queueLivePost(env: Env, task: TaskSummary, post: TelegramMessage): Promise<void> {
  const coveredByBackfill =
    task.scope === "live_and_backfill" && task.end_id !== null && post.message_id <= task.end_id;
  const predatesTask = post.date < task.created_at - LIVE_BACKLOG_GRACE_SECONDS;
  if (coveredByBackfill || predatesTask) return;

  const meta = extractMessageMetadata(post);
  const mediaDesc = describeMedia(meta.type, meta.size, meta.name);
  const evaluation = evaluateMessageFilter(post, {
    mediaTypes: task.filter_media_types
      ? task.filter_media_types.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined,
    minSizeBytes: task.filter_min_size_bytes,
    maxSizeBytes: task.filter_max_size_bytes,
  });

  if (evaluation.matched) {
    await insertPendingMessage(env.DB, task.id, post.message_id, meta.type, meta.size ?? null, meta.name ?? null);
    if (task.backfill_status !== "running") return;
    await appendActivityLog(env.DB, {
      task_id: task.id,
      kind: "live_forward",
      detail: `⏳ Queued in buffer: ${mediaDesc} · msg #${post.message_id} (waiting for backfill to finish)`,
      ok: true,
    });
  } else {
    await incrementLiveCounters(env.DB, task.id, 0, 0, 1);
    await appendActivityLog(env.DB, {
      task_id: task.id,
      kind: "live_forward",
      detail: `${mediaDesc} · msg #${post.message_id} skipped: ${evaluation.reason}`,
      ok: false,
      error: `Filtered: ${evaluation.reason}`,
    });
  }
  await maybePruneActivityLog(env, task.id);
}

/** Delivers a task's queued live messages oldest-first, one copyMessage call each. */
async function drainPendingMessagesForTask(env: Env, task: TaskSummary, client: TelegramClient): Promise<DrainOutcome> {
  const outcome: DrainOutcome = { haltBot: false, delivered: 0 };
  // Hold the live queue while a backfill runs so the destination keeps chronological order.
  if (task.backfill_status === "running") return outcome;

  const pending = await listPendingMessages(env.DB, task.id, MAX_PENDING_DRAIN_PER_TICK);
  for (const item of pending) {
    const label = `${describeMedia(item.media_type ?? "text", item.file_size, item.file_name)} · msg #${item.message_id}`;
    try {
      await client.copyMessage(task.dest_chat_id, task.source_chat_id, item.message_id);
    } catch (e) {
      if (!(e instanceof TelegramApiError)) {
        // Network failure or a non-JSON response — transient, so keep the message queued.
        console.error(`tick: live delivery for task ${task.id} failed, retrying next tick`, e);
        break;
      }
      if (e.reason === "rate_limited") {
        await pauseBotAfterRateLimit(env, task, "live_forward", `msg #${item.message_id}`, e.retryAfter);
        outcome.haltBot = true;
        break;
      }
      if (e.reason === "unauthorized") {
        await stopBotForUnauthorized(env, task.bot_id, "live_forward", e.message);
        outcome.haltBot = true;
        break;
      }
      if (isChatLevelFailure(e)) {
        // The queue is kept: once access is fixed and the task resumed, delivery picks up here.
        await stopTask(env.DB, task.id, e.reason);
        await appendActivityLog(env.DB, {
          task_id: task.id,
          kind: "live_forward",
          detail: `${label}: ${e.reason} — task auto-stopped, queued messages kept`,
          ok: false,
          error: e.message,
        });
        break;
      }
      if (e.reason === "invalid_request") {
        // Telegram refuses this particular message (deleted from the source, a poll, protected
        // content, …). It can never succeed, so drop it instead of blocking every later message.
        await deletePendingMessages(env.DB, [item.id]);
        await incrementLiveCounters(env.DB, task.id, 0, 1, 0);
        await appendActivityLog(env.DB, {
          task_id: task.id,
          kind: "live_forward",
          detail: `${label}: can't be copied, removed from queue`,
          ok: false,
          error: e.message,
        });
        continue;
      }
      // Telegram-side 5xx or an unclassified error — likely transient, retry next tick.
      await appendActivityLog(env.DB, {
        task_id: task.id,
        kind: "live_forward",
        detail: `${label}: ${e.reason}, retrying next tick`,
        ok: false,
        error: e.message,
      });
      break;
    }

    await deletePendingMessages(env.DB, [item.id]);
    await incrementLiveCounters(env.DB, task.id, 1, 0, 0);
    await appendActivityLog(env.DB, {
      task_id: task.id,
      kind: "live_forward",
      detail: `Copied ${label} (delivered from live queue)`,
      ok: true,
    });
    outcome.delivered++;
  }

  if (pending.length > 0) await maybePruneActivityLog(env, task.id);
  return outcome;
}

/** Copies the next batch of a running backfill with a single bulk copyMessages call. */
async function processOneBatch(env: Env, task: TaskSummary, client: TelegramClient): Promise<BatchOutcome> {
  const keepGoing: BatchOutcome = { haltBot: false, backfillComplete: false };
  if (task.cursor === null || task.end_id === null) return keepGoing;

  const fromCursor = task.cursor;
  const batchStartedAtMs = Date.now();
  const batchEnd = Math.min(fromCursor + task.pacing_batch_size - 1, task.end_id, fromCursor + MAX_BATCH_IDS - 1);
  const range = `ids ${fromCursor}-${batchEnd}`;
  const messageIds: number[] = [];
  for (let id = fromCursor; id <= batchEnd; id++) messageIds.push(id);

  // Bulk copyMessages: one API call per batch, matching the throughput the
  // pacing defaults were diagnosed against. Telegram silently skips ids it
  // can't copy (gaps, service messages) rather than reporting which ones —
  // so we only get an aggregate skipped count here, not per-id attribution.
  let succeeded: number;
  try {
    const results = await client.copyMessages(task.dest_chat_id, task.source_chat_id, messageIds);
    succeeded = results.length;
  } catch (e) {
    if (e instanceof TelegramApiError && e.reason === "rate_limited") {
      // Whole batch rejected — don't advance the cursor, same range retries
      // once the cooldown lifts.
      await pauseBotAfterRateLimit(env, task, "backfill_batch", range, e.retryAfter);
      return { haltBot: true, backfillComplete: false };
    }
    if (e instanceof TelegramApiError && e.reason === "unauthorized") {
      // Token revoked/invalid — stop every task on this bot now instead of retrying forever.
      await stopBotForUnauthorized(env, task.bot_id, "backfill_batch", e.message);
      return { haltBot: true, backfillComplete: false };
    }
    if (
      e instanceof TelegramApiError &&
      (e.message.toLowerCase().includes("no messages to forward") || /failed to send message #\d+\b/i.test(e.message))
    ) {
      // Two ways Telegram tells us a batch can't go through as a whole:
      // either none of the ids were copyable (gap/deleted range — no
      // messages to forward), or it aborted mid-batch because one message
      // in it can't be forwarded (protected content, a poll, etc. —
      // "failed to send message #N"). Telegram doesn't reliably tell us
      // whether anything before #N was actually committed, so skipping
      // just that one id and retrying the rest risks either double-copying
      // or silently dropping real messages depending on what actually
      // happened server-side. Simplest and safest: drop the whole batch as
      // failed, same as the gap case, and move straight to the next batch
      // instead of retrying (or crawling one id at a time through) the
      // same range forever.
      succeeded = 0;
    } else if (e instanceof TelegramApiError && isChatLevelFailure(e)) {
      // Bot lost access to one of this task's chats (kicked, no longer
      // admin, chat migrated) — won't self-heal by retrying. Auto-stop just
      // this task, not the whole bot, since sibling tasks on the same bot
      // may point at unaffected chats. Fixing access in Telegram and
      // resuming from the UI clears stop_reason and picks up from the same
      // cursor.
      await stopTask(env.DB, task.id, e.reason);
      await appendActivityLog(env.DB, {
        task_id: task.id,
        kind: "backfill_batch",
        detail: `${range}: ${e.reason} — task auto-stopped`,
        ok: false,
        error: e.message,
      });
      return keepGoing;
    } else {
      // Any other Telegram-classified reason (invalid_request/unknown) or a
      // non-Telegram error (network, D1, etc.). These can be transient, so
      // log every occurrence but don't advance the cursor or stop the task —
      // just retry next tick.
      const reason = e instanceof TelegramApiError ? e.reason : "unexpected error";
      const message = e instanceof Error ? e.message : String(e);
      await appendActivityLog(env.DB, {
        task_id: task.id,
        kind: "backfill_batch",
        detail: `${range}: ${reason}, resuming next tick`,
        ok: false,
        error: message,
      });
      return keepGoing;
    }
  }

  const batchDurationMs = Date.now() - batchStartedAtMs;
  const skipped = messageIds.length - succeeded;
  const progress = await advanceTaskProgress(env.DB, task.id, {
    fromCursor,
    toCursor: batchEnd + 1,
    processedDelta: succeeded,
    failedDelta: skipped,
  });

  const notes = [
    progress.complete ? "backfill complete" : "",
    progress.applied ? "" : "task was edited mid-batch, kept the edited progress",
  ].filter(Boolean);
  await appendActivityLog(env.DB, {
    task_id: task.id,
    kind: "backfill_batch",
    detail: `${range}: ${succeeded} ok, ${skipped} skipped, took ${batchDurationMs}ms${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`,
    ok: true,
    error: skipped > 0 ? `${skipped} message(s) in this range skipped by Telegram (not found / can't be copied)` : undefined,
  });

  // Prune on completion, otherwise on a small sample of batches.
  await maybePruneActivityLog(env, task.id, progress.complete);
  return { haltBot: false, backfillComplete: progress.complete };
}
