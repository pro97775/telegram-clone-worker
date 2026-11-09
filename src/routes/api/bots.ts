import { TelegramClient } from "../../telegram/client";
import { TelegramApiError, toResult, type Result } from "../../telegram/errors";
import {
  deleteBot,
  findBotByTokenOrBotId,
  getBotRateLimitStats,
  getBotWithSecrets,
  insertBot,
  listBotsSummary,
  listBotsWithSecrets,
  listTasksByBot,
  updateBotLabel,
  updateExistingBotDetails,
} from "../../db/queries";
import type {
  BotInspectionReport,
  BotSummary,
  BotVerifyResult,
  BulkBotImportItemResult,
  BulkBotImportResult,
  TaskSummary,
} from "../../shared/rpcTypes";
import { parseTelegramUpdate, type ParsedBotActivity } from "../../shared/updateParser";
import { runWithConcurrency } from "../../shared/concurrencyPool";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export async function handleListBots(env: Env): Promise<Response> {
  const bots = await listBotsSummary(env.DB);
  return json({ ok: true, data: bots });
}

/** Permanently disables webhooks across all registered bots so Telegram
 * stops sending HTTP webhook requests to Cloudflare (pure Cron Auto-Sync).
 */
export async function handleSyncWebhooks(request: Request, env: Env): Promise<Response> {
  const bots = await listBotsWithSecrets(env.DB);
  let webhooksDeleted = 0;
  const errors: string[] = [];

  for (const bot of bots) {
    const client = new TelegramClient(bot.token);
    try {
      await client.deleteWebhook(false);
      webhooksDeleted++;
    } catch (e) {
      errors.push(`@${bot.bot_username}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return json({
    ok: true,
    data: {
      totalBots: bots.length,
      webhooksDeleted,
      errors: errors.length > 0 ? errors : undefined,
    },
  });
}

/** Validates a token against Telegram (getMe) and checks if the bot already
 * exists in our database, returning active workloads, rate limits, and webhook status. */
export async function handleVerifyBot(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { token?: string; botId?: string };
  let token = body.token?.trim();
  let existingBotId: string | null = null;

  if (!token && body.botId) {
    const saved = await getBotWithSecrets(env.DB, body.botId);
    if (!saved) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
    token = saved.token;
    existingBotId = saved.id;
  }

  if (!token) {
    return json({ ok: false, errorCode: 0, description: "token or botId is required", reason: "invalid_request" }, 400);
  }

  const client = new TelegramClient(token);
  const result: Result<BotVerifyResult> = await toResult(async () => {
    const [me, webhookInfo] = await Promise.all([
      client.getMe(),
      client.getWebhookInfo().catch(() => null),
    ]);

    const existing = existingBotId
      ? await getBotWithSecrets(env.DB, existingBotId)
      : await findBotByTokenOrBotId(env.DB, token!, me.id);

    let active_tasks: TaskSummary[] = [];
    let total_tasks_count = 0;
    let rate_limit_info = {
      is_cooling_down: false,
      cooldown_until: null as number | null,
      cooldown_seconds_remaining: 0,
      events_last_24h: 0,
    };

    if (existing) {
      existingBotId = existing.id;
      const allTasks = await listTasksByBot(env.DB, existing.id);
      total_tasks_count = allTasks.length;
      active_tasks = allTasks.filter(
        (t) => t.live_enabled || t.backfill_status === "running" || t.backfill_status === "paused",
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
        url: webhookInfo?.url || undefined,
        pending_update_count: webhookInfo?.pending_update_count ?? 0,
        last_error_message: webhookInfo?.last_error_message,
        last_error_date: webhookInfo?.last_error_date,
      },
      rate_limit_info,
    };
  });

  return json(result, result.ok ? 200 : 400);
}

/** In-depth external activity inspection: probes webhooks, polling conflicts,
 * and recent updates parsed into simple human language. */
export async function handleInspectBot(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { token?: string; botId?: string };
  let token = body.token?.trim();
  let existingBotId: string | null = null;

  if (!token && body.botId) {
    const saved = await getBotWithSecrets(env.DB, body.botId);
    if (!saved) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
    token = saved.token;
    existingBotId = saved.id;
  }

  if (!token) {
    return json({ ok: false, errorCode: 0, description: "token or botId is required", reason: "invalid_request" }, 400);
  }

  const client = new TelegramClient(token);
  const result: Result<BotInspectionReport> = await toResult(async () => {
    const me = await client.getMe();
    const webhookInfo = await client.getWebhookInfo().catch(() => null);

    const existing = existingBotId
      ? await getBotWithSecrets(env.DB, existingBotId)
      : await findBotByTokenOrBotId(env.DB, token!, me.id);

    let active_tasks: TaskSummary[] = [];
    let rate_limit_info = {
      is_cooling_down: false,
      cooldown_until: null as number | null,
      cooldown_seconds_remaining: 0,
      events_last_24h: 0,
    };

    if (existing) {
      const allTasks = await listTasksByBot(env.DB, existing.id);
      active_tasks = allTasks.filter(
        (t) => t.live_enabled || t.backfill_status === "running" || t.backfill_status === "paused",
      );
      rate_limit_info = await getBotRateLimitStats(env.DB, existing.id);
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
          conflict_message = e.message || "Conflict: terminated by other getUpdates request (another bot script or Pyrogram session is actively running)";
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

  return json(result, result.ok ? 200 : 400);
}

/** Disconnects any active webhook without dropping pending updates,
 * preventing unwanted Cloudflare Worker HTTP invocations while keeping user copy commands intact. */
export async function handleDisconnectBotWebhook(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { token?: string; botId?: string };
  let token = body.token?.trim();

  if (!token && body.botId) {
    const saved = await getBotWithSecrets(env.DB, body.botId);
    if (!saved) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
    token = saved.token;
  }

  if (!token) {
    return json({ ok: false, errorCode: 0, description: "token or botId is required", reason: "invalid_request" }, 400);
  }

  const client = new TelegramClient(token);
  const result = await toResult(async () => {
    await client.deleteWebhook(false);
    const webhookInfo = await client.getWebhookInfo().catch(() => null);
    return {
      disconnected: true,
      pending_updates_preserved: true,
      pending_update_count: webhookInfo?.pending_update_count ?? 0,
    };
  });

  return json(result, result.ok ? 200 : 400);
}

/** Persists a verified token as a bot row, or returns/updates the existing row if already saved. */
export async function createBotRecord(env: Env, _origin: string, token: string, label?: string): Promise<Result<BotSummary>> {
  const client = new TelegramClient(token);
  return toResult(async () => {
    const me = await client.getMe();
    const botUsername = me.username ?? me.first_name;
    const existing = await findBotByTokenOrBotId(env.DB, token, me.id);
    if (existing) {
      const updatedLabel = label?.trim() || existing.label || botUsername;
      await updateExistingBotDetails(env.DB, existing.id, {
        token,
        bot_username: botUsername,
        label: label?.trim() ? updatedLabel : undefined,
      });
      return {
        id: existing.id,
        bot_id: me.id,
        bot_username: botUsername,
        label: updatedLabel,
        created_at: existing.created_at,
      };
    }

    const id = crypto.randomUUID();
    const webhookSecret = crypto.randomUUID().replace(/-/g, "");
    const botLabel = label?.trim() || botUsername;
    await insertBot(env.DB, {
      id,
      token,
      bot_id: me.id,
      bot_username: botUsername,
      label: botLabel,
      webhook_secret: webhookSecret,
    });
    return { id, bot_id: me.id, bot_username: botUsername, label: botLabel, created_at: Math.floor(Date.now() / 1000) };
  });
}

function maskToken(token: string): string {
  if (token.length <= 12) return token;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

/** Parses multi-line or comma/space-separated bot tokens, with optional labels:
 * e.g.
 *   123456789:ABCdef...
 *   My Bot Label | 987654321:ZYXwvu...
 *   123456789:ABCdef... # My Bot
 */
function parseBotTokensFromInput(
  rawText?: string,
  items?: Array<{ token: string; label?: string }>,
): Array<{ token: string; label?: string }> {
  const parsed: Array<{ token: string; label?: string }> = [];
  const seen = new Set<string>();

  if (Array.isArray(items)) {
    for (const item of items) {
      const t = item.token?.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        parsed.push({ token: t, label: item.label?.trim() || undefined });
      }
    }
  }

  if (rawText && rawText.trim()) {
    const lines = rawText.split(/\r?\n/);
    const tokenRegex = /(\d{5,16}:[A-Za-z0-9_-]{20,80})/g;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const matches = Array.from(line.matchAll(tokenRegex)).map((m) => m[1]);
      if (matches.length === 1) {
        const token = matches[0];
        if (!seen.has(token)) {
          seen.add(token);
          const remainder = line
            .replace(token, "")
            .replace(/^[|\-–—:#,\s()[\]]+|[|\-–—:#,\s()[\]]+$/g, "")
            .trim();
          parsed.push({ token, label: remainder || undefined });
        }
      } else if (matches.length > 1) {
        for (const token of matches) {
          if (!seen.has(token)) {
            seen.add(token);
            parsed.push({ token });
          }
        }
      } else {
        // Fallback if token doesn't match standard regex: split by comma/whitespace
        const tokens = line.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
        for (const token of tokens) {
          if (token.includes(":") && !seen.has(token)) {
            seen.add(token);
            parsed.push({ token });
          }
        }
      }
    }
  }

  return parsed;
}

/** Bulk-verifies and saves multiple Telegram bot tokens at once. */
export async function handleBulkCreateBots(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    rawText?: string;
    tokens?: Array<{ token: string; label?: string }>;
  };

  const entries = parseBotTokensFromInput(body.rawText, body.tokens);
  if (entries.length === 0) {
    return json(
      {
        ok: false,
        errorCode: 400,
        description: "No valid bot tokens found. Paste one or more tokens (e.g. 123456789:ABCdef...).",
        reason: "invalid_request",
      },
      400,
    );
  }

  const results: BulkBotImportItemResult[] = new Array(entries.length);
  const indexedEntries = entries.map((entry, idx) => ({ entry, idx }));

  await runWithConcurrency(indexedEntries, 6, async ({ entry, idx }) => {
    const client = new TelegramClient(entry.token);
    const verifyRes = await toResult(async () => {
      const me = await client.getMe();
      const botUsername = me.username ?? me.first_name;
      const existing = await findBotByTokenOrBotId(env.DB, entry.token, me.id);
      if (existing) {
        const nextLabel = entry.label?.trim() || existing.label || botUsername;
        await updateExistingBotDetails(env.DB, existing.id, {
          token: entry.token,
          bot_username: botUsername,
          label: entry.label?.trim() ? nextLabel : undefined,
        });
        return {
          status: "existing" as const,
          bot: {
            id: existing.id,
            bot_id: me.id,
            bot_username: botUsername,
            label: nextLabel,
            created_at: existing.created_at,
          },
        };
      }

      const id = crypto.randomUUID();
      const webhookSecret = crypto.randomUUID().replace(/-/g, "");
      const botLabel = entry.label?.trim() || botUsername;
      const createdAt = Math.floor(Date.now() / 1000);
      await insertBot(env.DB, {
        id,
        token: entry.token,
        bot_id: me.id,
        bot_username: botUsername,
        label: botLabel,
        webhook_secret: webhookSecret,
      });
      return {
        status: "created" as const,
        bot: {
          id,
          bot_id: me.id,
          bot_username: botUsername,
          label: botLabel,
          created_at: createdAt,
        },
      };
    });

    if (verifyRes.ok) {
      results[idx] = {
        token_preview: maskToken(entry.token),
        status: verifyRes.data.status,
        bot: verifyRes.data.bot,
      };
    } else {
      results[idx] = {
        token_preview: maskToken(entry.token),
        status: "failed",
        error: verifyRes.description,
      };
    }
  });

  const created = results.filter((r) => r.status === "created").length;
  const existing = results.filter((r) => r.status === "existing").length;
  const failed = results.filter((r) => r.status === "failed").length;

  const summary: BulkBotImportResult = {
    total: results.length,
    created,
    existing,
    failed,
    results,
  };

  return json({ ok: true, data: summary }, created > 0 ? 201 : 200);
}

export async function handleUpdateBot(request: Request, env: Env, id: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { label?: string };
  if (!body.label) {
    return json({ ok: false, errorCode: 0, description: "label is required", reason: "invalid_request" }, 400);
  }
  await updateBotLabel(env.DB, id, body.label);
  return json({ ok: true, data: null });
}

export async function handleDeleteBot(env: Env, id: string): Promise<Response> {
  const bot = await getBotWithSecrets(env.DB, id);
  if (!bot) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);

  const client = new TelegramClient(bot.token);
  await toResult(() => client.deleteWebhook(false));
  await deleteBot(env.DB, id);
  return json({ ok: true, data: null });
}
