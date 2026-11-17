import { storeAdminPassword } from "../auth/handler";
import { findBotByTokenOrBotId, getBotWithSecrets, updateBotLabel, type BotRow } from "../db/queries";
import { createBotRecord } from "../routes/api/bots";
import { applyTaskPatch } from "../tasks/service";
import { lookupChat } from "../telegram/chatLookup";
import { TelegramClient } from "../telegram/client";
import { toResult } from "../telegram/errors";
import { resolveLastN } from "../jobs/resolveRange";
import { botSend, type BotContext } from "./context";
import { chatPanelKeyboard } from "./keyboards";
import { code, esc } from "./render";
import { addAdminId, dropSession, saveSession, type ActiveSession } from "./store";
import { adminsView, botDetailView, chatInfoView, securityView } from "./views";
import { isBotToken } from "./wizard";

interface ToolData {
  botId?: string;
  chatId?: string;
  chatTitle?: string | null;
}

interface ToolHandle {
  bot: BotRow;
  client: TelegramClient;
  data: ToolData;
}

async function loadTool(ctx: BotContext, data: ToolData): Promise<ToolHandle | null> {
  if (!data.botId) {
    await dropSession(ctx.env, ctx.chatId);
    await botSend(ctx, "That chat session expired — open Chat tools again.");
    return null;
  }
  const bot = await getBotWithSecrets(ctx.env.DB, data.botId);
  if (!bot) {
    await dropSession(ctx.env, ctx.chatId);
    await botSend(ctx, "That bot no longer exists.");
    return null;
  }
  return { bot, client: new TelegramClient(bot.token), data };
}

async function keepPanel(ctx: BotContext, data: ToolData, message: string): Promise<void> {
  await saveSession(ctx.env, ctx.chatId, ctx.userId, "tool:panel", data);
  await botSend(ctx, message, chatPanelKeyboard());
}

/** Handles typed replies for sessions that start with a button. Returns false
 * when the state belongs to the task wizard. */
export async function handleTextSession(ctx: BotContext, session: ActiveSession): Promise<boolean> {
  switch (session.state) {
    case "bot:add": {
      const token = ctx.text.trim();
      if (!isBotToken(token)) {
        await botSend(ctx, "That does not look like a bot token. Send the full token from @BotFather, or tap Cancel.");
        return true;
      }
      await ctx.client.deleteMessage(ctx.chatId, ctx.messageId).catch(() => undefined);
      const existing = await findBotByTokenOrBotId(ctx.env.DB, token);
      if (existing) {
        await dropSession(ctx.env, ctx.chatId);
        const view = await botDetailView(ctx.env, existing.id);
        await botSend(ctx, `That token is already connected as @${esc(existing.bot_username)}.`, view?.keyboard);
        return true;
      }
      const created = await createBotRecord(ctx.env, "", token);
      if (!created.ok) {
        await botSend(ctx, `❌ Telegram rejected the token: ${esc(created.description)}`);
        return true;
      }
      await dropSession(ctx.env, ctx.chatId);
      const view = await botDetailView(ctx.env, created.data.id);
      await botSend(
        ctx,
        `✅ Connected <b>${esc(created.data.label)}</b> @${esc(created.data.bot_username)}.`,
        view?.keyboard,
      );
      return true;
    }

    case "bot:rename": {
      const data = session.data as { botId?: string };
      const label = ctx.text.trim();
      if (!data.botId || !label) {
        await botSend(ctx, "Send a non-empty label, or tap Cancel.");
        return true;
      }
      const bot = await getBotWithSecrets(ctx.env.DB, data.botId);
      if (!bot) {
        await dropSession(ctx.env, ctx.chatId);
        await botSend(ctx, "That bot no longer exists.");
        return true;
      }
      await updateBotLabel(ctx.env.DB, data.botId, label);
      await dropSession(ctx.env, ctx.chatId);
      await botSend(ctx, `✅ @${esc(bot.bot_username)} is now labelled <b>${esc(label)}</b>.`, {
        inline_keyboard: [[{ text: "« Bot", callback_data: `B:${data.botId.slice(0, 8)}` }], [{ text: "« Menu", callback_data: "m" }]],
      });
      return true;
    }

    case "task:label": {
      const data = session.data as { taskId?: string };
      const label = ctx.text.trim();
      if (!data.taskId || !label) {
        await botSend(ctx, "Send a non-empty label, or tap Cancel.");
        return true;
      }
      const result = await applyTaskPatch(ctx.env, data.taskId, { label });
      if (!result.ok) {
        await botSend(ctx, `❌ ${esc(result.description)}`);
        return true;
      }
      await dropSession(ctx.env, ctx.chatId);
      await botSend(ctx, `✅ Task renamed to <b>${esc(label)}</b>.`, {
        inline_keyboard: [[{ text: "« Task", callback_data: `T:${data.taskId.slice(0, 8)}` }], [{ text: "« Menu", callback_data: "m" }]],
      });
      return true;
    }

    case "auth:set": {
      const password = ctx.text.trim();
      await ctx.client.deleteMessage(ctx.chatId, ctx.messageId).catch(() => undefined);
      if (password.length < 4 || password.length > 256) {
        await botSend(ctx, "❌ Password must be 4–256 characters. Tap Set password to try again.");
        return true;
      }
      await storeAdminPassword(ctx.env, password);
      await dropSession(ctx.env, ctx.chatId);
      const view = await securityView(ctx.env);
      await botSend(ctx, `✅ Web console password updated.\n\n${view.text}`, view.keyboard);
      return true;
    }

    case "admin:add": {
      const userId = Number(ctx.text.trim());
      if (!Number.isInteger(userId) || userId <= 0) {
        await botSend(ctx, "Send a numeric Telegram user id, or tap Cancel.");
        return true;
      }
      const added = await addAdminId(ctx.env, userId);
      await dropSession(ctx.env, ctx.chatId);
      const view = await adminsView(ctx.env);
      await botSend(
        ctx,
        added ? `✅ ${code(userId)} can now control this bot.\n\n${view.text}` : `${code(userId)} is already env-managed.`,
        view.keyboard,
      );
      return true;
    }

    case "tool:chat": {
      const tool = await loadTool(ctx, session.data as ToolData);
      if (!tool) return true;
      const lookup = await lookupChat(ctx.env.DB, tool.client, tool.bot.bot_id, ctx.text.trim());
      if (!lookup.ok) {
        await botSend(ctx, `❌ Cannot access ${esc(ctx.text.trim())}: ${esc(lookup.description)}`);
        return true;
      }
      tool.data.chatId = String(lookup.data.chat.id);
      tool.data.chatTitle = lookup.data.chat.title ?? null;
      await saveSession(ctx.env, ctx.chatId, ctx.userId, "tool:panel", tool.data);
      const view = await chatInfoView(ctx.env, tool.bot.id, tool.data.chatId);
      await botSend(ctx, view.text, view.keyboard);
      return true;
    }

    case "tool:revoke":
    case "tool:ban":
    case "tool:unban":
    case "tool:promote":
    case "tool:sendtest":
    case "tool:copytest": {
      const tool = await loadTool(ctx, session.data as ToolData);
      if (!tool) return true;
      const chatId = tool.data.chatId;
      if (!chatId) {
        await dropSession(ctx.env, ctx.chatId);
        await botSend(ctx, "That chat session expired — open Chat tools again.");
        return true;
      }
      const input = ctx.text.trim();

      if (session.state === "tool:revoke") {
        const result = await toResult(() => tool.client.revokeChatInviteLink(chatId, input));
        await keepPanel(
          ctx,
          tool.data,
          result.ok ? `✅ Invite link revoked: ${esc(result.data.invite_link)}` : `❌ ${esc(result.description)}`,
        );
        return true;
      }

      if (session.state === "tool:ban" || session.state === "tool:unban") {
        const userId = Number(input.split(/\s+/)[0]);
        if (!Number.isInteger(userId) || userId <= 0) {
          await botSend(ctx, `Send the numeric user id to ${session.state === "tool:ban" ? "ban" : "unban"}.`);
          return true;
        }
        const ban = session.state === "tool:ban";
        const result = await toResult(() =>
          ban ? tool.client.banChatMember(chatId, userId) : tool.client.unbanChatMember(chatId, userId),
        );
        await keepPanel(
          ctx,
          tool.data,
          result.ok
            ? `✅ User ${userId} ${ban ? "banned" : "unbanned"} in ${esc(chatId)}.`
            : `❌ ${esc(result.description)}`,
        );
        return true;
      }

      if (session.state === "tool:promote") {
        const userId = Number(input.split(/\s+/)[0]);
        if (!Number.isInteger(userId) || userId <= 0) {
          await botSend(ctx, "Send the numeric user id to promote.");
          return true;
        }
        const result = await toResult(() =>
          tool.client.promoteChatMember(chatId, userId, {
            can_delete_messages: true,
            can_invite_users: true,
            can_restrict_members: true,
          }),
        );
        await keepPanel(
          ctx,
          tool.data,
          result.ok ? `✅ User ${userId} promoted (delete, invite, restrict).` : `❌ ${esc(result.description)}`,
        );
        return true;
      }

      if (session.state === "tool:sendtest") {
        const text = input || "Test message from Telegram Clone Worker";
        const result = await toResult(() => tool.client.sendMessage(chatId, text));
        await keepPanel(
          ctx,
          tool.data,
          result.ok ? `✅ Sent as message ${code(result.data.message_id)}.` : `❌ ${esc(result.description)}`,
        );
        return true;
      }

      // tool:copytest — input is the destination chat id.
      const dest = input.split(/\s+/)[0];
      if (!dest) {
        await botSend(ctx, "Send the destination chat id.");
        return true;
      }
      const result = await toResult(async () => {
        const latest = await resolveLastN(tool.client, chatId, 1);
        const copy = await tool.client.copyMessage(dest, chatId, latest.endId);
        return { sourceId: latest.endId, messageId: copy.message_id };
      });
      await keepPanel(
        ctx,
        tool.data,
        result.ok
          ? `✅ Copied message ${code(result.data.sourceId)} → ${esc(dest)} (new message ${code(result.data.messageId)}).`
          : `❌ ${esc(result.description)}`,
      );
      return true;
    }

    case "tool:panel": {
      await botSend(ctx, "Use the chat tool buttons above, or tap Chat tools to start over.", chatPanelKeyboard());
      return true;
    }

    default:
      if (session.state.startsWith("confirm:")) {
        await botSend(ctx, "Tap Confirm or Cancel above, or use /confirm and /cancel.");
        return true;
      }
      return false;
  }
}
