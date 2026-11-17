import {
  clearBotControllerSession,
  deleteAppSetting,
  getAppSetting,
  getBotControllerSession,
  pruneBotControllerSessions,
  setAppSetting,
  setBotControllerSession,
} from "../db/queries";

export type ControllerMode = "webhook" | "poll";

const MODE_KEY = "bot_controller_mode";
const OFFSET_KEY = "bot_controller_offset";
const SECRET_KEY = "bot_controller_webhook_secret";
const ADMINS_KEY = "bot_controller_admins";

export const SESSION_TTL_SECONDS = 15 * 60;

export function getControllerToken(env: Env): string | null {
  const token = env.BOT_CONTROLLER_TOKEN?.trim();
  return token ? token : null;
}

export async function getControllerMode(env: Env): Promise<ControllerMode> {
  const value = await getAppSetting(env.DB, MODE_KEY);
  return value === "webhook" ? "webhook" : "poll";
}

export async function setControllerMode(env: Env, mode: ControllerMode): Promise<void> {
  await setAppSetting(env.DB, MODE_KEY, mode);
}

export async function getControllerOffset(env: Env): Promise<number> {
  const value = await getAppSetting(env.DB, OFFSET_KEY);
  const offset = Number(value ?? 0);
  return Number.isFinite(offset) && offset > 0 ? offset : 0;
}

export async function setControllerOffset(env: Env, nextUpdateOffset: number): Promise<void> {
  await setAppSetting(env.DB, OFFSET_KEY, String(nextUpdateOffset));
}

/** Uses the env secret when provided, otherwise persists a generated one so
 * webhook registration and verification agree across deployments. */
export async function ensureWebhookSecret(env: Env): Promise<string> {
  const fromEnv = env.BOT_CONTROLLER_WEBHOOK_SECRET?.trim();
  if (fromEnv) return fromEnv;

  const existing = await getAppSetting(env.DB, SECRET_KEY);
  if (existing) return existing;

  const candidate = crypto.randomUUID().replace(/-/g, "");
  await env.DB
    .prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)`)
    .bind(SECRET_KEY, candidate)
    .run();
  return (await getAppSetting(env.DB, SECRET_KEY)) ?? candidate;
}

export async function getWebhookSecret(env: Env): Promise<string | null> {
  const fromEnv = env.BOT_CONTROLLER_WEBHOOK_SECRET?.trim();
  if (fromEnv) return fromEnv;
  return getAppSetting(env.DB, SECRET_KEY);
}

export function envAdminIds(env: Env): number[] {
  return (env.BOT_CONTROLLER_ADMIN_IDS ?? "")
    .split(/[,\s]+/)
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
}

async function storedAdminIds(env: Env): Promise<number[]> {
  const raw = await getAppSetting(env.DB, ADMINS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is number => Number.isInteger(id) && (id as number) > 0);
  } catch {
    return [];
  }
}

export async function getAdminIds(env: Env): Promise<number[]> {
  const ids = new Set<number>([...envAdminIds(env), ...(await storedAdminIds(env))]);
  return [...ids];
}

export async function isControllerAdmin(env: Env, userId: number): Promise<boolean> {
  return (await getAdminIds(env)).includes(userId);
}

/** Adds an admin to D1. Returns false when the id is already managed by the
 * read-only env allowlist. */
export async function addAdminId(env: Env, userId: number): Promise<boolean> {
  if (envAdminIds(env).includes(userId)) return false;
  const ids = await storedAdminIds(env);
  if (!ids.includes(userId)) {
    await setAppSetting(env.DB, ADMINS_KEY, JSON.stringify([...ids, userId]));
  }
  return true;
}

/** Removes a D1-managed admin. Env-managed ids cannot be removed here. */
export async function removeAdminId(env: Env, userId: number): Promise<boolean> {
  if (envAdminIds(env).includes(userId)) return false;
  const ids = await storedAdminIds(env);
  if (!ids.includes(userId)) return false;
  const next = ids.filter((id) => id !== userId);
  if (next.length === 0) await deleteAppSetting(env.DB, ADMINS_KEY);
  else await setAppSetting(env.DB, ADMINS_KEY, JSON.stringify(next));
  return true;
}

export interface ActiveSession {
  state: string;
  data: Record<string, unknown>;
  updatedAt: number;
}

export async function getSession(env: Env, chatId: number): Promise<ActiveSession | null> {
  const row = await getBotControllerSession(env.DB, chatId);
  if (!row) return null;

  const now = Math.floor(Date.now() / 1000);
  if (now - row.updated_at > SESSION_TTL_SECONDS) {
    await clearBotControllerSession(env.DB, chatId);
    return null;
  }

  try {
    const parsed = JSON.parse(row.data) as unknown;
    return {
      state: row.state,
      data: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {},
      updatedAt: row.updated_at,
    };
  } catch {
    await clearBotControllerSession(env.DB, chatId);
    return null;
  }
}

export async function saveSession(
  env: Env,
  chatId: number,
  userId: number,
  state: string,
  data: object,
): Promise<void> {
  await setBotControllerSession(env.DB, chatId, userId, state, data);
}

export async function dropSession(env: Env, chatId: number): Promise<void> {
  await clearBotControllerSession(env.DB, chatId);
}

export async function purgeStaleSessions(env: Env): Promise<void> {
  await pruneBotControllerSessions(env.DB, SESSION_TTL_SECONDS);
}
