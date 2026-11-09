import { TelegramClient } from "../../telegram/client";
import {
  deleteSavedChannel,
  getBotWithSecrets,
  listBotsWithSecrets,
  listSavedChannels,
  updateSavedChannel,
  upsertSavedChannel,
} from "../../db/queries";
import { runWithConcurrency } from "../../shared/concurrencyPool";
import type {
  BulkChannelImportItemResult,
  BulkChannelImportResult,
} from "../../shared/rpcTypes";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export async function handleListChannels(env: Env): Promise<Response> {
  const channels = await listSavedChannels(env.DB);
  return json({ ok: true, data: channels });
}

/** Normalizes raw channel identifier:
 * - https://t.me/c/1234567890/45 -> -1001234567890
 * - https://t.me/channelname/123 -> @channelname
 * - t.me/channelname -> @channelname
 * - -1001234567890 -> -1001234567890
 * - @channelname -> @channelname
 */
export function normalizeChatIdentifier(raw: string): string {
  const trimmed = raw.trim();
  const privateLinkMatch = trimmed.match(/^(?:https?:\/\/)?t\.me\/c\/(\d{5,20})(?:\/\d+)?\/?$/i);
  if (privateLinkMatch) {
    return `-100${privateLinkMatch[1]}`;
  }
  const publicLinkMatch = trimmed.match(/^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{4,64})(?:\/\d+)?\/?$/i);
  if (publicLinkMatch && publicLinkMatch[1].toLowerCase() !== "c") {
    return `@${publicLinkMatch[1]}`;
  }
  return trimmed;
}

const CHAT_ID_TOKEN_REGEX = /^(-?\d{6,20}|@[A-Za-z0-9_]{3,64}|(?:https?:\/\/)?t\.me\/(?:c\/\d{5,20}|[A-Za-z0-9_]{4,64})(?:\/\d+)?\/?)$/i;

/** Parses multi-line or comma-separated channel entries:
 * Supports formats like:
 *   -1001234567890
 *   @mychannel
 *   https://t.me/mychannel
 *   https://t.me/c/1234567890/45
 *   My Channel Title | -1001234567890
 *   -1001234567890 | My Channel Title
 *   -1001234567890 My Channel Title (even if title contains commas!)
 */
function parseChannelEntries(
  rawText?: string,
  channels?: Array<{ chatId: string; title?: string }>,
): Array<{ chatId: string; title?: string }> {
  const parsed: Array<{ chatId: string; title?: string }> = [];
  const seen = new Set<string>();

  if (Array.isArray(channels)) {
    for (const ch of channels) {
      const id = normalizeChatIdentifier(ch.chatId ?? "");
      if (id && !seen.has(id.toLowerCase())) {
        seen.add(id.toLowerCase());
        parsed.push({ chatId: id, title: ch.title?.trim() || undefined });
      }
    }
  }

  if (rawText && rawText.trim()) {
    const lines = rawText.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.includes("|")) {
        const parts = line.split("|").map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 2) {
          const firstIsId = CHAT_ID_TOKEN_REGEX.test(parts[0]);
          const secondIsId = CHAT_ID_TOKEN_REGEX.test(parts[1]);
          const rawId = firstIsId || !secondIsId ? parts[0] : parts[1];
          const rawTitle = firstIsId || !secondIsId ? parts.slice(1).join(" | ") : parts[0];
          const id = normalizeChatIdentifier(rawId);
          if (id && !seen.has(id.toLowerCase())) {
            seen.add(id.toLowerCase());
            parsed.push({ chatId: id, title: rawTitle || undefined });
          }
          continue;
        }
      }

      // Check if line is "-1001234567890 My Channel Label" (single ID followed by label, which may contain commas)
      const leadingIdMatch = line.match(
        /^(-?\d{6,20}|@[A-Za-z0-9_]{3,64}|(?:https?:\/\/)?t\.me\/(?:c\/\d{5,20}|[A-Za-z0-9_]{4,64})(?:\/\d+)?\/?)\s+[-–—:]?\s*(.+)$/i,
      );
      if (leadingIdMatch && !CHAT_ID_TOKEN_REGEX.test(leadingIdMatch[2].split(",")[0].trim())) {
        const id = normalizeChatIdentifier(leadingIdMatch[1]);
        const label = leadingIdMatch[2].trim();
        if (id && !seen.has(id.toLowerCase())) {
          seen.add(id.toLowerCase());
          parsed.push({ chatId: id, title: label || undefined });
        }
        continue;
      }

      // Otherwise split by comma (for comma-separated lists of IDs)
      const tokens = line.split(",").map((s) => s.trim()).filter(Boolean);
      for (const tok of tokens) {
        const spaceMatch = tok.match(
          /^(-?\d{6,20}|@[A-Za-z0-9_]{3,64}|(?:https?:\/\/)?t\.me\/(?:c\/\d{5,20}|[A-Za-z0-9_]{4,64})(?:\/\d+)?\/?)(?:\s+[-–—:]?\s*(.+))?$/i,
        );
        if (spaceMatch) {
          const id = normalizeChatIdentifier(spaceMatch[1]);
          const label = spaceMatch[2]?.trim();
          if (id && !seen.has(id.toLowerCase())) {
            seen.add(id.toLowerCase());
            parsed.push({ chatId: id, title: label || undefined });
          }
        } else {
          const id = normalizeChatIdentifier(tok);
          if (id && !seen.has(id.toLowerCase())) {
            seen.add(id.toLowerCase());
            parsed.push({ chatId: id });
          }
        }
      }
    }
  }

  return parsed;
}

export async function handleBulkSaveChannels(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    rawText?: string;
    channels?: Array<{ chatId: string; title?: string }>;
    botId?: string;
    botToken?: string;
  };

  const entries = parseChannelEntries(body.rawText, body.channels);
  if (entries.length === 0) {
    return json(
      {
        ok: false,
        errorCode: 400,
        description: "No channels provided. Enter one or more channel IDs (e.g. -1001234567890 or @channel).",
        reason: "invalid_request",
      },
      400,
    );
  }

  const clients: TelegramClient[] = [];
  if (body.botToken?.trim()) {
    clients.push(new TelegramClient(body.botToken.trim()));
  } else if (body.botId?.trim()) {
    const bot = await getBotWithSecrets(env.DB, body.botId.trim());
    if (bot) clients.push(new TelegramClient(bot.token));
  } else {
    const allBots = await listBotsWithSecrets(env.DB);
    for (const b of allBots.slice(0, 3)) {
      clients.push(new TelegramClient(b.token));
    }
  }

  const results: BulkChannelImportItemResult[] = new Array(entries.length);
  const indexed = entries.map((entry, idx) => ({ entry, idx }));

  await runWithConcurrency(indexed, 6, async ({ entry, idx }) => {
    let resolvedId = entry.chatId;
    let resolvedTitle = entry.title || entry.chatId;
    let resolvedUsername: string | null = entry.chatId.startsWith("@") ? entry.chatId.slice(1) : null;
    let resolvedType: string | null = "channel";
    let verified = false;

    for (const client of clients) {
      try {
        const chat = await client.getChat(entry.chatId);
        resolvedId = String(chat.id);
        resolvedTitle = entry.title?.trim() || chat.title || chat.username || String(chat.id);
        resolvedUsername = chat.username ?? resolvedUsername;
        resolvedType = chat.type ?? "channel";
        verified = true;
        break;
      } catch {
        // Try next bot client or fall back to saving raw chatId + label
      }
    }

    try {
      const saved = await upsertSavedChannel(env.DB, {
        chat_id: resolvedId,
        title: resolvedTitle,
        username: resolvedUsername,
        chat_type: resolvedType,
      });
      results[idx] = {
        input: entry.chatId,
        status: "saved",
        channel: saved,
        verified_with_telegram: verified,
      };
    } catch (e) {
      results[idx] = {
        input: entry.chatId,
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });

  const savedCount = results.filter((r) => r.status === "saved").length;
  const failedCount = results.filter((r) => r.status === "failed").length;

  const summary: BulkChannelImportResult = {
    total: results.length,
    saved: savedCount,
    failed: failedCount,
    results,
  };

  return json({ ok: true, data: summary }, savedCount > 0 ? 201 : 200);
}

export async function handleUpdateChannel(request: Request, env: Env, id: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { title?: string; chatId?: string };
  if (!body.title?.trim() && !body.chatId?.trim()) {
    return json({ ok: false, errorCode: 400, description: "title or chatId is required", reason: "invalid_request" }, 400);
  }
  const updated = await updateSavedChannel(env.DB, id, {
    title: body.title,
    chat_id: body.chatId ? normalizeChatIdentifier(body.chatId) : undefined,
  });
  if (!updated) {
    return json({ ok: false, errorCode: 404, description: "channel not found", reason: "invalid_request" }, 404);
  }
  return json({ ok: true, data: updated });
}

export async function handleDeleteChannel(env: Env, id: string): Promise<Response> {
  await deleteSavedChannel(env.DB, id);
  return json({ ok: true, data: null });
}
