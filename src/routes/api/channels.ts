import { TelegramClient } from "../../telegram/client";
import {
  deleteSavedChannel,
  findSavedChannelByRoleAndChatId,
  getBotWithSecrets,
  insertSavedChannel,
  listBotsWithSecrets,
  listSavedChannels,
  updateSavedChannel,
} from "../../db/queries";
import type { BulkChannelsResult, ChannelRole, SavedChannel } from "../../shared/rpcTypes";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function normalizeChatIdentifier(raw: string): string {
  const trimmed = raw.trim();
  const tmeMatch = trimmed.match(/^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{4,})\/?$/i);
  if (tmeMatch) {
    return `@${tmeMatch[1]}`;
  }
  return trimmed;
}

function isChatIdToken(token: string): boolean {
  const norm = normalizeChatIdentifier(token);
  return /^-?\d{5,}$/.test(norm) || /^@[A-Za-z0-9_]{3,}$/.test(norm);
}

export function parseChannelEntries(rawInput: string): Array<{ chatId: string; label?: string }> {
  const results: Array<{ chatId: string; label?: string }> = [];
  const seen = new Set<string>();

  const lines = rawInput.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // First check if line is comma-separated list of chat IDs (with no custom pipe/colon separator)
    if (line.includes(",") && !line.includes("|")) {
      const commaParts = line
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      if (commaParts.length > 1 && commaParts.every((p) => isChatIdToken(p.split(/\s+/)[0]))) {
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

    // Check if the line consists purely of multiple space-separated chat IDs / @usernames
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

    // Extract single chat ID (-100... or @username or t.me/username) and optional label
    const match = line.match(/((?:https?:\/\/)?t\.me\/[A-Za-z0-9_]{4,}|-?\d{5,}|@[A-Za-z0-9_]{3,})/i);
    if (match) {
      const rawMatched = match[1];
      const chatId = normalizeChatIdentifier(rawMatched);
      const remainder = line
        .replace(rawMatched, "")
        .replace(/^[\s|,\-:()]+|[\s|,\-:()]+$/g, "")
        .trim();
      const key = chatId.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ chatId, label: remainder || undefined });
      }
    } else {
      // Fallback: treat the first token as chatId and rest as label
      const firstToken = normalizeChatIdentifier(spaceTokens[0]);
      const remainder = line
        .slice(spaceTokens[0].length)
        .replace(/^[\s|,\-:()]+|[\s|,\-:()]+$/g, "")
        .trim();
      const key = firstToken.toLowerCase();
      if (firstToken && !seen.has(key)) {
        seen.add(key);
        results.push({ chatId: firstToken, label: remainder || undefined });
      }
    }
  }

  return results;
}

export async function handleListChannels(env: Env, roleParam: string): Promise<Response> {
  const role = roleParam === "source" || roleParam === "target" ? (roleParam as ChannelRole) : undefined;
  const channels = await listSavedChannels(env.DB, role);
  return json({ ok: true, data: channels });
}

export async function handleBulkCreateChannels(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    role?: string;
    rawInput?: string;
    channels?: Array<{ chatId: string; label?: string }>;
    botId?: string;
    botToken?: string;
  };

  if (body.role !== "source" && body.role !== "target") {
    return json(
      { ok: false, errorCode: 400, description: "role must be 'source' or 'target'", reason: "invalid_request" },
      400,
    );
  }
  const role: ChannelRole = body.role;

  const entries =
    Array.isArray(body.channels) && body.channels.length > 0
      ? body.channels
      : parseChannelEntries(body.rawInput ?? "");

  if (entries.length === 0) {
    return json(
      { ok: false, errorCode: 400, description: "At least one channel ID or @username is required", reason: "invalid_request" },
      400,
    );
  }

  // Gather candidate bot tokens for best-effort getChat title resolution
  const candidateTokens: string[] = [];
  if (body.botToken?.trim()) {
    candidateTokens.push(body.botToken.trim());
  }
  if (body.botId?.trim()) {
    const specificBot = await getBotWithSecrets(env.DB, body.botId.trim());
    if (specificBot && !candidateTokens.includes(specificBot.token)) {
      candidateTokens.push(specificBot.token);
    }
  }
  const allBots = await listBotsWithSecrets(env.DB);
  for (const b of allBots) {
    if (candidateTokens.length >= 3) break;
    if (!candidateTokens.includes(b.token)) {
      candidateTokens.push(b.token);
    }
  }

  const saved: SavedChannel[] = [];
  const errors: Array<{ input: string; error: string }> = [];

  for (const entry of entries) {
    const rawChatId = entry.chatId.trim();
    if (!rawChatId) continue;

    let resolvedChatId = rawChatId;
    let resolvedTitle: string | null = null;
    let resolvedUsername: string | null = rawChatId.startsWith("@") ? rawChatId.slice(1) : null;

    // Best-effort lookup of chat title/id via available bots
    for (const token of candidateTokens) {
      try {
        const client = new TelegramClient(token);
        const chat = await client.getChat(rawChatId);
        resolvedChatId = String(chat.id);
        resolvedTitle = chat.title ?? null;
        resolvedUsername = chat.username ?? resolvedUsername;
        break;
      } catch {
        // Ignore if this bot is not in the chat or cannot access it yet
      }
    }

    const lookupIds = [
      rawChatId,
      resolvedChatId,
      resolvedUsername ? `@${resolvedUsername}` : "",
    ].filter(Boolean);

    const existing = await findSavedChannelByRoleAndChatId(env.DB, role, lookupIds);
    const computedLabel =
      entry.label?.trim() ||
      resolvedTitle ||
      existing?.title ||
      (resolvedUsername ? `@${resolvedUsername}` : resolvedChatId);

    if (existing) {
      const updatedLabel =
        entry.label?.trim() ||
        (existing.label === existing.chat_id && resolvedTitle ? resolvedTitle : existing.label);
      await updateSavedChannel(env.DB, existing.id, {
        chat_id: resolvedChatId,
        title: resolvedTitle ?? existing.title,
        username: resolvedUsername ?? existing.username,
        label: updatedLabel,
      });
      saved.push({
        id: existing.id,
        role,
        chat_id: resolvedChatId,
        title: resolvedTitle ?? existing.title,
        username: resolvedUsername ?? existing.username,
        label: updatedLabel,
        created_at: existing.created_at,
      });
    } else {
      const id = crypto.randomUUID();
      const createdAt = Math.floor(Date.now() / 1000);
      await insertSavedChannel(env.DB, {
        id,
        role,
        chat_id: resolvedChatId,
        title: resolvedTitle,
        username: resolvedUsername,
        label: computedLabel,
      });
      saved.push({
        id,
        role,
        chat_id: resolvedChatId,
        title: resolvedTitle,
        username: resolvedUsername,
        label: computedLabel,
        created_at: createdAt,
      });
    }
  }

  return json({ ok: true, data: { saved, errors } satisfies BulkChannelsResult });
}

export async function handleUpdateChannel(request: Request, env: Env, id: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { label?: string };
  if (!body.label?.trim()) {
    return json({ ok: false, errorCode: 400, description: "label is required", reason: "invalid_request" }, 400);
  }
  await updateSavedChannel(env.DB, id, { label: body.label.trim() });
  return json({ ok: true, data: null });
}

export async function handleDeleteChannel(env: Env, id: string): Promise<Response> {
  await deleteSavedChannel(env.DB, id);
  return json({ ok: true, data: null });
}
