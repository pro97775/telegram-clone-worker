import { clearAdminPassword } from "../auth/handler";
import { deleteBot, deleteSavedTask, deleteTask, getBotWithSecrets, getTask } from "../db/queries";
import { TelegramClient } from "../telegram/client";
import { toResult } from "../telegram/errors";
import { botSend, type BotContext } from "./context";
import { confirmKeyboard } from "./keyboards";
import { esc } from "./render";
import { dropSession, getSession, saveSession } from "./store";

export async function askConfirm(
  ctx: BotContext,
  action: string,
  payload: Record<string, unknown>,
  text: string,
): Promise<void> {
  await saveSession(ctx.env, ctx.chatId, ctx.userId, `confirm:${action}`, payload);
  await botSend(ctx, `${text}\n\nConfirm or cancel.`, confirmKeyboard("cy", "Confirm", "cn"));
}

export async function cancelConfirmation(ctx: BotContext): Promise<void> {
  await dropSession(ctx.env, ctx.chatId);
  await botSend(ctx, "Cancelled.");
}

export async function runConfirmation(ctx: BotContext): Promise<void> {
  const session = await getSession(ctx.env, ctx.chatId);
  if (!session || !session.state.startsWith("confirm:")) {
    await botSend(ctx, "Nothing to confirm.");
    return;
  }
  const action = session.state.slice("confirm:".length);
  await dropSession(ctx.env, ctx.chatId);

  if (action === "taskdelete") {
    const taskId = String(session.data.taskId ?? "");
    const task = await getTask(ctx.env.DB, taskId);
    if (!task) {
      await botSend(ctx, "That task no longer exists.");
      return;
    }
    await deleteTask(ctx.env.DB, taskId);
    await botSend(ctx, `🗑 Deleted <b>${esc(task.label)}</b>.`);
    return;
  }

  if (action === "botremove") {
    const botId = String(session.data.botId ?? "");
    const bot = await getBotWithSecrets(ctx.env.DB, botId);
    if (!bot) {
      await botSend(ctx, "That bot no longer exists.");
      return;
    }
    await toResult(() => new TelegramClient(bot.token).deleteWebhook(false));
    await deleteBot(ctx.env.DB, botId);
    await botSend(ctx, `🗑 Deleted @${esc(bot.bot_username)} and its tasks.`);
    return;
  }

  if (action === "saveddel") {
    const savedId = String(session.data.savedId ?? "");
    await deleteSavedTask(ctx.env.DB, savedId);
    await botSend(ctx, "🗑 Saved template deleted. Running tasks were not touched.");
    return;
  }

  if (action === "authremove") {
    await clearAdminPassword(ctx.env);
    await botSend(ctx, "🔓 Web console password removed — the console is now open.");
    return;
  }

  await botSend(ctx, "Unknown confirmation.");
}
