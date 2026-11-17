import { TelegramApiError } from "../telegram/errors";
import type { TelegramClient } from "../telegram/client";
import type {
  TelegramInlineKeyboardButton,
  TelegramInlineKeyboardMarkup,
  TelegramSendMessageOptions,
} from "../telegram/types";

/** Everything a controller command handler needs about one incoming message
 * or button press. */
export interface BotContext {
  env: Env;
  client: TelegramClient;
  chatId: number;
  messageId: number;
  userId: number;
  text: string;
}

const MAX_MESSAGE_LENGTH = 3800;

export function clipHtml(html: string, limit = MAX_MESSAGE_LENGTH): string {
  return html.length > limit ? `${html.slice(0, limit - 1)}…` : html;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
}

function sendOptions(
  keyboard: TelegramInlineKeyboardMarkup | undefined,
  plain = false,
): TelegramSendMessageOptions {
  return {
    ...(plain ? {} : { parse_mode: "HTML" as const }),
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  };
}

/** Sends a message with an optional inline keyboard. If Telegram rejects the
 * markup we retry once with the tags stripped so the admin still sees it. */
export async function botSend(
  ctx: BotContext,
  html: string,
  keyboard?: TelegramInlineKeyboardMarkup,
): Promise<void> {
  const text = clipHtml(html);
  try {
    await ctx.client.sendMessage(ctx.chatId, text, sendOptions(keyboard));
    return;
  } catch (e) {
    if (e instanceof TelegramApiError && e.errorCode !== 400) return;
  }
  try {
    await ctx.client.sendMessage(ctx.chatId, stripHtml(text), sendOptions(keyboard, true));
  } catch {
    // The chat may be gone or the bot was blocked; nothing else to do.
  }
}

/** Edits the message a button belongs to, keeping the chat tidy. Falls back
 * silently when the message is too old to edit or is unchanged. */
export async function botEdit(
  ctx: BotContext,
  messageId: number,
  html: string,
  keyboard?: TelegramInlineKeyboardMarkup,
): Promise<void> {
  const text = clipHtml(html);
  try {
    await ctx.client.editMessageText(ctx.chatId, messageId, text, sendOptions(keyboard));
    return;
  } catch (e) {
    if (e instanceof TelegramApiError) {
      if (e.errorCode === 400 && /not modified/i.test(e.message)) return;
      if (e.errorCode !== 400) return;
    }
  }
  try {
    await ctx.client.editMessageText(ctx.chatId, messageId, stripHtml(text), sendOptions(keyboard, true));
  } catch {
    // Fall back to a fresh message so the buttons remain reachable.
    await botSend(ctx, html, keyboard);
  }
}

export async function botReply(ctx: BotContext, html: string): Promise<void> {
  await botSend(ctx, html);
}

export async function answer(queryId: string, ctx: BotContext, text?: string, alert = false): Promise<void> {
  await ctx.client.answerCallbackQuery(queryId, text, alert).catch(() => undefined);
}

/** Convenience row helper used by every keyboard builder. */
export function btn(text: string, callbackData: string): TelegramInlineKeyboardButton {
  return { text, callback_data: callbackData };
}
