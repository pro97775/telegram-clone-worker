import { TelegramApiError, toResult } from "./errors";
import type { TelegramClient } from "./client";
import { getBotRateLimitStats, listTasksByBot } from "../db/queries";
import type { BotInspectionReport, Result, TaskSummary } from "../shared/rpcTypes";
import { parseTelegramUpdate, type ParsedBotActivity } from "../shared/updateParser";

/** In-depth external activity inspection: probes webhooks, polling conflicts,
 * and recent updates parsed into simple human language. Shared by
 * POST /api/bots/inspect and the controller bot's /botinspect command. */
export async function inspectBot(
  db: D1Database,
  client: TelegramClient,
  existingBotId: string | null,
): Promise<Result<BotInspectionReport>> {
  return toResult(async () => {
    const me = await client.getMe();
    const webhookInfo = await client.getWebhookInfo().catch(() => null);

    let active_tasks: TaskSummary[] = [];
    let rate_limit_info = {
      is_cooling_down: false,
      cooldown_until: null as number | null,
      cooldown_seconds_remaining: 0,
      events_last_24h: 0,
    };

    if (existingBotId) {
      const allTasks = await listTasksByBot(db, existingBotId);
      active_tasks = allTasks.filter(
        (t) => t.live_enabled || t.backfill_status === "running" || t.backfill_status === "paused",
      );
      rate_limit_info = await getBotRateLimitStats(db, existingBotId);
    }

    let conflict_detected = false;
    let conflict_message: string | undefined;
    let recent_activities: ParsedBotActivity[] = [];

    const isWebhookActive = Boolean(webhookInfo?.url);

    // If no webhook is active, probe getUpdates for pending messages or polling conflicts
    if (!isWebhookActive) {
      try {
        const rawUpdates = await client.getUpdates({ limit: 8 });
        if (rawUpdates && rawUpdates.length > 0) {
          recent_activities = rawUpdates.map(parseTelegramUpdate);
        }
      } catch (e) {
        if (e instanceof TelegramApiError && e.errorCode === 409) {
          conflict_detected = true;
          conflict_message =
            e.message ||
            "Conflict: terminated by other getUpdates request (another bot script or Pyrogram session is actively running)";
        }
      }
    }

    return {
      bot_id: me.id,
      bot_username: me.username ?? me.first_name,
      clone_worker_tasks: {
        active_count: active_tasks.length,
        tasks: active_tasks,
      },
      webhook: {
        is_active: isWebhookActive,
        url: webhookInfo?.url || undefined,
        pending_update_count: webhookInfo?.pending_update_count ?? 0,
        last_error_message: webhookInfo?.last_error_message,
        last_error_date: webhookInfo?.last_error_date,
      },
      polling_session: {
        conflict_detected,
        message: conflict_message,
      },
      rate_limits: rate_limit_info,
      recent_activities,
    };
  });
}
