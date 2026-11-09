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
  updateBotTokenAndLabel,
} from "../../db/queries";
import type {
  BotInspectionReport,
  BotSummary,
  BotVerifyResult,
  BulkBotsResult,
  TaskSummary,
} from "../../shared/rpcTypes";
import { parseTelegramUpdate, type ParsedBotActivity } from "../../shared/updateParser";

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
    // dropPendingUpdates: false ensures pending commands to copy files or user messages are preserved!
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

/** Persists a verified token as a bot row.
 * Only called once something durable actually needs the bot to exist (e.g. task creation).
 * Live updates are polled via getUpdates in scheduled cron (no webhooks). */
export async function createBotRecord(env: Env, _origin: string, token: string, label?: string): Promise<Result<BotSummary>> {
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
        created_at: existing.created_at,
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
      webhook_secret: webhookSecret,
    });
    return { id, bot_id: me.id, bot_username: botUsername, label: botLabel, created_at: Math.floor(Date.now() / 1000) };
  });
}

function parseBotTokenInput(rawInput: string): Array<{ token: string; label?: string }> {
  const entries: Array<{ token: string; label?: string }> = [];
  const seen = new Set<string>();
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
      const remainder = line
        .replace(token, "")
        .replace(/^[\s|,\-:()]+|[\s|,\-:()]+$/g, "")
        .trim();
      if (!seen.has(token)) {
        seen.add(token);
        entries.push({ token, label: remainder || undefined });
      }
    } else {
      const parts = line
        .split(/[\s,]+/)
        .map((p) => p.trim())
        .filter(Boolean);
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

export async function handleBulkAddBots(request: Request, env: Env, origin: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    rawInput?: string;
    tokens?: string[];
  };

  const combinedInput = body.rawInput ?? (Array.isArray(body.tokens) ? body.tokens.join("\n") : "");
  const parsed = parseBotTokenInput(combinedInput);

  if (parsed.length === 0) {
    return json(
      { ok: false, errorCode: 400, description: "At least one bot token is required", reason: "invalid_request" },
      400,
    );
  }

  const added: BotSummary[] = [];
  const errors: Array<{ tokenPreview: string; error: string }> = [];

  for (const item of parsed) {
    const res = await createBotRecord(env, origin, item.token, item.label);
    if (res.ok) {
      added.push(res.data);
    } else {
      const preview =
        item.token.length > 12 ? `${item.token.slice(0, 6)}…${item.token.slice(-4)}` : item.token;
      errors.push({ tokenPreview: preview, error: res.description });
    }
  }

  if (added.length === 0 && errors.length > 0) {
    return json(
      {
        ok: false,
        errorCode: 400,
        description: errors.map((e) => `${e.tokenPreview}: ${e.error}`).join("; "),
        reason: "invalid_request",
        data: { added, errors } satisfies BulkBotsResult,
      },
      400,
    );
  }

  return json({ ok: true, data: { added, errors } satisfies BulkBotsResult });
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
