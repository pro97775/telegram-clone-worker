import { authenticateApiRequest } from "../auth/handler";
import { TelegramClient } from "../telegram/client";
import { toResult } from "../telegram/errors";
import type { TelegramBotCommand, TelegramUpdate } from "../telegram/types";
import { controllerDashboard, handleControllerUpdate } from "./controller";
import {
  ensureWebhookSecret,
  getAdminIds,
  getControllerMode,
  getControllerToken,
  getWebhookSecret,
  setControllerMode,
} from "./store";

const WEBHOOK_PATH = "/api/bot-controller/webhook";

const COMMANDS: TelegramBotCommand[] = [
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
  { command: "help", description: "Every command" },
];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Public Telegram webhook. Authenticated by the per-bot secret header that
 * setWebhook registered, never by the console session. */
export async function handleControllerWebhook(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ ok: false, errorCode: 405, description: "method not allowed", reason: "invalid_request" }, 405);
  }

  const token = getControllerToken(env);
  if (!token) {
    return json({ ok: false, errorCode: 503, description: "controller bot is not configured", reason: "invalid_request" }, 503);
  }

  const secret = await getWebhookSecret(env);
  if (!secret) {
    return json({ ok: false, errorCode: 503, description: "controller webhook secret is not configured", reason: "invalid_request" }, 503);
  }

  const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!safeEqual(provided, secret)) {
    return json({ ok: false, errorCode: 401, description: "invalid webhook secret", reason: "unauthorized" }, 401);
  }

  const update = (await request.json().catch(() => null)) as TelegramUpdate | null;
  if (!update || typeof update.update_id !== "number") {
    return json({ ok: false, errorCode: 400, description: "invalid update payload", reason: "invalid_request" }, 400);
  }

  const process = async () => {
    try {
      await handleControllerUpdate(env, update);
    } catch (e) {
      // A non-2xx makes Telegram retry the same update and duplicate every
      // command, so failures are logged and still acknowledged.
      console.error("controller update failed", e);
    }
  };

  // Acknowledge immediately and keep working: some commands (webhook sync,
  // inspections) fan out to every bot and can outlast Telegram's deadline.
  if (ctx) ctx.waitUntil(process());
  else await process();
  return json({ ok: true, data: null });
}

/** GET /api/bot-controller — configuration and Telegram-side webhook status. */
export async function handleControllerStatus(request: Request, env: Env): Promise<Response> {
  const authError = await authenticateApiRequest(request, env);
  if (authError) return authError;

  const token = getControllerToken(env);
  const [mode, admins, counts] = await Promise.all([
    getControllerMode(env),
    getAdminIds(env),
    controllerDashboard(env),
  ]);

  let telegram: { username: string | null; webhookUrl: string | null; pendingUpdates: number } | null = null;
  if (token) {
    const client = new TelegramClient(token);
    const [me, info] = await Promise.all([
      client.getMe().catch(() => null),
      client.getWebhookInfo().catch(() => null),
    ]);
    telegram = {
      username: me?.username ?? me?.first_name ?? null,
      webhookUrl: info?.url || null,
      pendingUpdates: info?.pending_update_count ?? 0,
    };
  }

  return json({
    ok: true,
    data: {
      configured: Boolean(token),
      mode,
      webhookPath: WEBHOOK_PATH,
      admins: admins.length,
      adminIds: admins,
      bots: counts.bots,
      tasks: counts.tasks,
      telegram,
    },
  });
}

/** POST /api/bot-controller/setup — registers the webhook and switches the
 * controller to instant delivery. Body: { url?: string } (defaults to this
 * Worker's origin). */
export async function handleControllerSetup(request: Request, env: Env, origin: string): Promise<Response> {
  const authError = await authenticateApiRequest(request, env);
  if (authError) return authError;

  const token = getControllerToken(env);
  if (!token) {
    return json(
      { ok: false, errorCode: 400, description: "BOT_CONTROLLER_TOKEN is not configured", reason: "invalid_request" },
      400,
    );
  }

  const body = (await request.json().catch(() => ({}))) as { url?: unknown };
  const requested = typeof body.url === "string" && body.url.trim() ? body.url.trim() : `${origin}${WEBHOOK_PATH}`;

  let parsed: URL;
  try {
    parsed = new URL(requested);
  } catch {
    return json({ ok: false, errorCode: 400, description: "invalid webhook URL", reason: "invalid_request" }, 400);
  }

  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !loopback) {
    return json(
      { ok: false, errorCode: 400, description: "webhook URL must be https (Telegram requirement)", reason: "invalid_request" },
      400,
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
    return json(result, 400);
  }

  // The slash menu is cosmetic; never fail setup over it.
  await client.setMyCommands(COMMANDS).catch(() => undefined);
  await setControllerMode(env, "webhook");

  return json({
    ok: true,
    data: {
      mode: "webhook",
      url: parsed.toString(),
      username: result.data.username ?? result.data.first_name,
    },
  });
}

/** POST /api/bot-controller/disable-webhook — back to cron polling without
 * dropping pending commands. */
export async function handleControllerDisableWebhook(request: Request, env: Env): Promise<Response> {
  const authError = await authenticateApiRequest(request, env);
  if (authError) return authError;

  const token = getControllerToken(env);
  if (!token) {
    return json(
      { ok: false, errorCode: 400, description: "BOT_CONTROLLER_TOKEN is not configured", reason: "invalid_request" },
      400,
    );
  }

  const client = new TelegramClient(token);
  const result = await toResult(async () => {
    await client.deleteWebhook(false);
    return client.getWebhookInfo().catch(() => null);
  });
  if (!result.ok) {
    return json(result, 400);
  }

  await setControllerMode(env, "poll");
  return json({
    ok: true,
    data: { mode: "poll", pendingUpdates: result.data?.pending_update_count ?? 0 },
  });
}
