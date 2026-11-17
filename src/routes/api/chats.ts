import { TelegramClient, type PromoteRights } from "../../telegram/client";
import { toResult } from "../../telegram/errors";
import { getBotWithSecrets } from "../../db/queries";
import { lookupChat } from "../../telegram/chatLookup";
import { resolveLastN } from "../../jobs/resolveRange";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/** botId looks up an already-saved bot's token in the DB; token is the raw
 * token for a bot the task wizard hasn't saved yet (see handleVerifyBot) —
 * exactly one of the two is expected to be set. */
async function loadClient(env: Env, botId: string, token: string): Promise<TelegramClient | null> {
  if (token) return new TelegramClient(token);
  if (!botId) return null;
  const bot = await getBotWithSecrets(env.DB, botId);
  return bot ? new TelegramClient(bot.token) : null;
}

async function loadClientAndBotId(
  env: Env,
  botId: string,
  token: string,
  botTelegramId: string,
): Promise<{ client: TelegramClient; botTelegramId: number } | null> {
  if (token) {
    const telegramId = Number(botTelegramId);
    if (!telegramId) return null;
    return { client: new TelegramClient(token), botTelegramId: telegramId };
  }
  if (!botId) return null;
  const bot = await getBotWithSecrets(env.DB, botId);
  return bot ? { client: new TelegramClient(bot.token), botTelegramId: bot.bot_id } : null;
}

export async function handleGetChat(env: Env, chatId: string, botId: string, token: string, botTelegramId: string): Promise<Response> {
  const loaded = await loadClientAndBotId(env, botId, token, botTelegramId);
  if (!loaded) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await lookupChat(env.DB, loaded.client, loaded.botTelegramId, chatId);
  return json(result, result.ok ? 200 : 400);
}

export async function handleInviteLink(env: Env, chatId: string, botId: string, token: string): Promise<Response> {
  const client = await loadClient(env, botId, token);
  if (!client) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.createChatInviteLink(chatId));
  return json(result, result.ok ? 200 : 400);
}

export async function handleRevokeInviteLink(env: Env, chatId: string, botId: string, inviteLink: string, token: string): Promise<Response> {
  const client = await loadClient(env, botId, token);
  if (!client) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.revokeChatInviteLink(chatId, inviteLink));
  return json(result, result.ok ? 200 : 400);
}

export async function handleBan(env: Env, chatId: string, botId: string, userId: number, token: string): Promise<Response> {
  const client = await loadClient(env, botId, token);
  if (!client) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.banChatMember(chatId, userId));
  return json(result, result.ok ? 200 : 400);
}

export async function handleUnban(env: Env, chatId: string, botId: string, userId: number, token: string): Promise<Response> {
  const client = await loadClient(env, botId, token);
  if (!client) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.unbanChatMember(chatId, userId));
  return json(result, result.ok ? 200 : 400);
}

export async function handlePromote(
  env: Env,
  chatId: string,
  botId: string,
  userId: number,
  rights: PromoteRights,
  token: string,
): Promise<Response> {
  const client = await loadClient(env, botId, token);
  if (!client) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.promoteChatMember(chatId, userId, rights));
  return json(result, result.ok ? 200 : 400);
}

export async function handleSendTestMessage(env: Env, chatId: string, botId: string, text: string, token: string): Promise<Response> {
  const client = await loadClient(env, botId, token);
  if (!client) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  const result = await toResult(() => client.sendMessage(chatId, text));
  return json(result, result.ok ? 200 : 400);
}

/** Probe-and-delete trick: send a throwaway message to learn the chat's
 * current highest message id, then best-effort delete it. Deletion
 * failure is non-fatal — it's logged but doesn't fail the lookup. */
export async function handleLatestMessageId(env: Env, chatId: string, botId: string, token: string): Promise<Response> {
  const client = await loadClient(env, botId, token);
  if (!client) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);

  const result = await toResult(async () => {
    const { endId, cleanupOk } = await resolveLastN(client, chatId, 1);
    return { latestMessageId: endId, cleanupOk };
  });
  return json(result, result.ok ? 200 : 400);
}

/** Wizard dry-run: not tied to a saved task yet — resolves the source
 * chat's latest message and copies it to the given destination once, so
 * the user can validate the pipeline before committing. */
export async function handleAdHocTestCopy(
  env: Env,
  sourceChatId: string,
  botId: string,
  destChatId: string,
  token: string,
  messageId?: number
): Promise<Response> {
  const client = await loadClient(env, botId, token);
  if (!client) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);

  const result = await toResult(async () => {
    let copyId = messageId;
    if (!copyId) {
      const latest = await resolveLastN(client, sourceChatId, 1);
      copyId = latest.endId;
    }
    return client.copyMessage(destChatId, sourceChatId, copyId);
  });
  return json(result, result.ok ? 200 : 400);
}
