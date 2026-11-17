import { clearAdminPassword } from "../auth/handler";
import {
  deleteBot,
  deleteSavedTask,
  deleteTask,
  getBotWithSecrets,
  getTask,
  listBotsSummary,
  listSavedTasks,
  listTasksByBot,
} from "../db/queries";
import { resolveLastN } from "../jobs/resolveRange";
import { startTaskFromSaved } from "../tasks/saved";
import { performTaskAction, type TaskAction } from "../tasks/actions";
import type { TelegramCallbackQuery } from "../telegram/types";
import { TelegramClient } from "../telegram/client";
import { toResult } from "../telegram/errors";
import { botEdit, botSend, type BotContext } from "./context";
import { runConfirmation, cancelConfirmation } from "./confirmations";
import { confirmKeyboard } from "./keyboards";
import { esc, shortId } from "./render";
import { resolveBot, resolveTask } from "./resolve";
import {
  dropSession,
  getControllerToken,
  getSession,
  isControllerAdmin,
  removeAdminId,
  saveSession,
  setControllerMode,
  type ActiveSession,
} from "./store";
import {
  adminsView,
  botDetailView,
  botInspectView,
  botsView,
  botTasksView,
  chatInfoView,
  configView,
  filterPromptView,
  mainMenuView,
  modeView,
  savedView,
  securityView,
  statusView,
  taskActivityView,
  taskDetailView,
  tasksView,
  toolsBotsView,
  type View,
} from "./views";
import {
  completeEditTask,
  completeNewTask,
  editTargetScope,
  promptEditConfirm,
  promptEditEnd,
  promptEditCursor,
  promptEditFilter,
  promptEditReset,
  promptEditStart,
  promptConfirm,
  promptFilter,
  promptLastN,
  promptMode,
  promptPacing,
  promptRange,
  promptSource,
  startEditTaskWizard,
  startNewTaskWizard,
  wizardDataOf,
  type WizardData,
} from "./wizard";

export async function handleControllerCallback(env: Env, query: TelegramCallbackQuery): Promise<void> {
  const token = getControllerToken(env);
  if (!token) return;
  const client = new TelegramClient(token);

  if (!query.message) {
    await client.answerCallbackQuery(query.id).catch(() => undefined);
    return;
  }

  const ctx: BotContext = {
    env,
    client,
    chatId: query.message.chat.id,
    messageId: query.message.message_id,
    userId: query.from.id,
    text: "",
  };

  if (!(await isControllerAdmin(env, query.from.id))) {
    await client.answerCallbackQuery(query.id, "Not authorized", true).catch(() => undefined);
    return;
  }

  // Acknowledge immediately so the button spinner stops even when the action
  // underneath takes a few Telegram round-trips.
  await client.answerCallbackQuery(query.id).catch(() => undefined);

  try {
    await route(ctx, query.data ?? "");
  } catch (e) {
    console.error("controller callback failed", query.data, e);
    await botSend(ctx, `❌ ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function viewOrError(ctx: BotContext, view: View | null, message = "Not found."): Promise<void> {
  if (!view) {
    await botEdit(ctx, ctx.messageId, `❌ ${message}`, {
      inline_keyboard: [[{ text: "« Menu", callback_data: "m" }]],
    });
    return;
  }
  await botEdit(ctx, ctx.messageId, view.text, view.keyboard);
}

async function currentSession(ctx: BotContext): Promise<ActiveSession | null> {
  return getSession(ctx.env, ctx.chatId);
}

async function requireNewTaskData(ctx: BotContext): Promise<WizardData | null> {
  const session = await currentSession(ctx);
  if (!session || !session.state.startsWith("newtask:")) {
    await botSend(ctx, "That wizard expired — tap New task to start again.", {
      inline_keyboard: [[{ text: "➕ New task", callback_data: "n" }], [{ text: "« Menu", callback_data: "m" }]],
    });
    return null;
  }
  return wizardDataOf(session);
}

async function saveAndEdit(ctx: BotContext, state: string, data: WizardData, view: View): Promise<void> {
  await saveSession(ctx.env, ctx.chatId, ctx.userId, state, data);
  await botEdit(ctx, ctx.messageId, view.text, view.keyboard);
}

async function taskForEdit(ctx: BotContext, data: WizardData): Promise<Awaited<ReturnType<typeof getTask>> | null> {
  if (!data.taskId) return null;
  return getTask(ctx.env.DB, data.taskId);
}

async function route(ctx: BotContext, data: string): Promise<void> {
  const [kind, a, b] = data.split(":");

  switch (kind) {
    case "m":
      return viewOrError(ctx, await mainMenuView(ctx.env));
    case "s":
      return viewOrError(ctx, await statusView(ctx.env));
    case "b":
      return viewOrError(ctx, await botsView(ctx.env));
    case "Ba": {
      await saveSession(ctx.env, ctx.chatId, ctx.userId, "bot:add", {});
      return botEdit(
        ctx,
        ctx.messageId,
        "<b>Add bot</b>\n\nSend the bot token from @BotFather. The message is deleted after it is processed.",
        { inline_keyboard: [[{ text: "« Bots", callback_data: "b" }], [{ text: "✖️ Cancel", callback_data: "x" }]] },
      );
    }
    case "cfg":
      return viewOrError(ctx, await configView(ctx.env));
    case "mode":
      return viewOrError(ctx, await modeView(ctx.env));
    case "mp": {
      await ctx.client.deleteWebhook(false).catch(() => undefined);
      await setControllerMode(ctx.env, "poll");
      return viewOrError(ctx, await modeView(ctx.env));
    }
    case "mw":
      await botSend(
        ctx,
        "To switch to webhook mode, call the authenticated endpoint <code>POST /api/bot-controller/setup</code>. It registers this Worker's URL with Telegram and flips the mode.",
      );
      return;
    case "x": {
      await dropSession(ctx.env, ctx.chatId);
      return viewOrError(ctx, await mainMenuView(ctx.env));
    }
    case "cy": {
      await runConfirmation(ctx);
      return viewOrError(ctx, await mainMenuView(ctx.env));
    }
    case "cn": {
      await cancelConfirmation(ctx);
      return viewOrError(ctx, await mainMenuView(ctx.env));
    }

    case "B": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) {
        return botEdit(ctx, ctx.messageId, `❌ ${bot.error}`, { inline_keyboard: [[{ text: "« Bots", callback_data: "b" }]] });
      }
      return viewOrError(ctx, await botDetailView(ctx.env, bot.value.id));
    }
    case "Bi": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) {
        return botEdit(ctx, ctx.messageId, `❌ ${bot.error}`, { inline_keyboard: [[{ text: "« Bots", callback_data: "b" }]] });
      }
      return viewOrError(ctx, await botInspectView(ctx.env, bot.value.id));
    }
    case "Bu": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) return;
      await toResult(() => new TelegramClient(bot.value.token).deleteWebhook(false));
      return viewOrError(ctx, await botDetailView(ctx.env, bot.value.id));
    }
    case "Bd": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) return;
      const tasks = await listTasksByBot(ctx.env.DB, bot.value.id);
      return botEdit(
        ctx,
        ctx.messageId,
        `<b>Delete @${bot.value.bot_username}?</b>\n\nThis disconnects its webhook and permanently deletes <b>${tasks.length}</b> task${
          tasks.length === 1 ? "" : "s"
        } that use it.`,
        confirmKeyboard(`Bdc:${shortId(bot.value.id)}`, "Delete bot", "b"),
      );
    }
    case "Bdc": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) return;
      await toResult(() => new TelegramClient(bot.value.token).deleteWebhook(false));
      await deleteBot(ctx.env.DB, bot.value.id);
      return viewOrError(ctx, await botsView(ctx.env));
    }
    case "Br": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) return;
      await saveSession(ctx.env, ctx.chatId, ctx.userId, "bot:rename", { botId: bot.value.id });
      return botEdit(
        ctx,
        ctx.messageId,
        `<b>Rename @${esc(bot.value.bot_username)}</b>\n\nCurrent label: ${esc(bot.value.label)}\nSend the new label.`,
        { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: `B:${shortId(bot.value.id)}` }]] },
      );
    }
    case "Bt": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) return;
      const [tasks, bots] = await Promise.all([listTasksByBot(ctx.env.DB, bot.value.id), listBotsSummary(ctx.env.DB)]);
      return viewOrError(ctx, botTasksView(bots, bot.value.id, tasks));
    }

    case "t":
    case "tf":
      return viewOrError(ctx, await tasksView(ctx.env, a || "active", Number(b) || 0));

    case "T": {
      const task = await resolveTask(ctx.env, a);
      if (!task.ok) {
        return botEdit(ctx, ctx.messageId, `❌ ${task.error}`, { inline_keyboard: [[{ text: "« Tasks", callback_data: "t:active:0" }]] });
      }
      return viewOrError(ctx, await taskDetailView(ctx.env, task.value.id));
    }
    case "Tp":
    case "Tr":
    case "Ts": {
      const task = await resolveTask(ctx.env, a);
      if (!task.ok) return;
      const action: TaskAction = kind === "Tp" ? "pause" : kind === "Tr" ? "resume" : "stop";
      const result = await performTaskAction(ctx.env, task.value, action);
      if (!result.ok) {
        await botSend(ctx, `❌ ${esc(result.description)}`);
      }
      return viewOrError(ctx, await taskDetailView(ctx.env, task.value.id));
    }
    case "Tt": {
      const task = await resolveTask(ctx.env, a);
      if (!task.ok) return;
      const bot = await getBotWithSecrets(ctx.env.DB, task.value.bot_id);
      if (!bot) {
        await botSend(ctx, "That task's bot row is missing.");
        return;
      }
      const client = new TelegramClient(bot.token);
      const result = await toResult(async () => {
        const latest = await resolveLastN(client, task.value.source_chat_id, 1);
        const copy = await client.copyMessage(task.value.dest_chat_id, task.value.source_chat_id, latest.endId);
        return { sourceId: latest.endId, messageId: copy.message_id };
      });
      await botSend(
        ctx,
        result.ok
          ? `✅ Copied message ${result.data.sourceId} → destination (new message ${result.data.messageId}).`
          : `❌ ${esc(result.description)}`,
      );
      return viewOrError(ctx, await taskDetailView(ctx.env, task.value.id));
    }
    case "Ta": {
      const task = await resolveTask(ctx.env, a);
      if (!task.ok) return;
      return viewOrError(ctx, await taskActivityView(ctx.env, task.value.id));
    }
    case "Te": {
      const task = await resolveTask(ctx.env, a);
      if (!task.ok) return;
      return startEditTaskWizard(ctx, task.value, ctx.messageId);
    }
    case "Td": {
      const task = await resolveTask(ctx.env, a);
      if (!task.ok) return;
      return botEdit(
        ctx,
        ctx.messageId,
        `<b>Delete "${esc(task.value.label)}"?</b>\n\nThis removes the task and its activity log permanently. The bot and chats stay untouched.`,
        confirmKeyboard(`Tdc:${shortId(task.value.id)}`, "Delete task", "t:active:0"),
      );
    }
    case "Tdc": {
      const task = await resolveTask(ctx.env, a);
      if (!task.ok) return;
      await deleteTask(ctx.env.DB, task.value.id);
      return viewOrError(ctx, await tasksView(ctx.env, "active", 0));
    }
    case "Tl": {
      const task = await resolveTask(ctx.env, a);
      if (!task.ok) return;
      await saveSession(ctx.env, ctx.chatId, ctx.userId, "task:label", { taskId: task.value.id });
      return botEdit(
        ctx,
        ctx.messageId,
        `<b>Rename task</b>\n\nCurrent: ${esc(task.value.label)}\nSend the new label.`,
        { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: `T:${shortId(task.value.id)}` }]] },
      );
    }

    case "n":
      return startNewTaskWizard(ctx, ctx.messageId);
    case "Nb": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) return;
      const session = await currentSession(ctx);
      const data: WizardData =
        session && session.state.startsWith("newtask:") ? wizardDataOf(session) : {};
      data.botId = bot.value.id;
      data.botUsername = bot.value.bot_username;
      return promptSource(ctx, data, ctx.messageId);
    }
    case "Nbt": {
      await saveSession(ctx.env, ctx.chatId, ctx.userId, "newtask:bot", {});
      return botEdit(
        ctx,
        ctx.messageId,
        "<b>New task · add bot</b>\n\nSend the bot token from @BotFather. The message is deleted after it is processed.",
        { inline_keyboard: [[{ text: "« Back", callback_data: "n" }], [{ text: "✖️ Cancel", callback_data: "x" }]] },
      );
    }
    case "Ns": {
      const data = await requireNewTaskData(ctx);
      if (!data) return;
      data.scope = a === "live" ? "live" : a === "both" ? "live_and_backfill" : "backfill_only";
      if (data.scope === "live") return promptPacing(ctx, data, ctx.messageId);
      return promptMode(ctx, data, ctx.messageId);
    }
    case "Nm": {
      const data = await requireNewTaskData(ctx);
      if (!data) return;
      data.backfillMode = a === "lastN" ? "lastN" : "range";
      if (data.backfillMode === "range") return promptRange(ctx, data, ctx.messageId);
      return promptLastN(ctx, data, ctx.messageId);
    }
    case "Nn": {
      const data = await requireNewTaskData(ctx);
      if (!data) return;
      data.n = Number(a);
      return promptPacing(ctx, data, ctx.messageId);
    }
    case "Np": {
      const data = await requireNewTaskData(ctx);
      if (!data) return;
      data.pacingBatchSize = a === "default" ? undefined : Number(a);
      if (data.scope === "backfill_only") return promptConfirm(ctx, data, ctx.messageId);
      return promptFilter(ctx, data, ctx.messageId);
    }
    case "Nf": {
      const data = await requireNewTaskData(ctx);
      if (!data) return;
      if (a === "m" && b) {
        toggleMedia(data, b);
      } else if (a === "min") {
        data.filterMinSizeBytes = mbToBytes(Number(b));
        if (data.filterMinSizeBytes === null) {
          // Clearing the minimum is independent of the maximum.
          data.filterMinSizeBytes = null;
        }
      } else if (a === "max") {
        data.filterMaxSizeBytes = mbToBytes(Number(b));
      } else if (a === "done") {
        return promptConfirm(ctx, data, ctx.messageId);
      }
      return saveAndEdit(ctx, "newtask:filter", data, filterPromptView("Nf", data));
    }
    case "Nc": {
      const session = await currentSession(ctx);
      if (!session || !session.state.startsWith("newtask:")) return;
      const data = wizardDataOf(session);
      if (a === "again") data.allowDuplicate = true;
      return completeNewTask(ctx, data, a === "save");
    }

    case "Es": {
      const session = await currentSession(ctx);
      if (!session || !session.state.startsWith("taskedit:")) return;
      const data = wizardDataOf(session);
      const task = await taskForEdit(ctx, data);
      if (!task) return;
      if (a !== "keep") data.scope = a === "live" ? "live" : a === "both" ? "live_and_backfill" : "backfill_only";
      if (editTargetScope(data, task) === "live") return promptEditFilter(ctx, data, task, ctx.messageId);
      return promptEditStart(ctx, data, task, ctx.messageId);
    }
    case "Ekeep": {
      const session = await currentSession(ctx);
      if (!session || !session.state.startsWith("taskedit:")) return;
      const data = wizardDataOf(session);
      const task = await taskForEdit(ctx, data);
      if (!task) return;
      if (a === "start") return promptEditEnd(ctx, data, task, ctx.messageId);
      if (a === "end") return promptEditCursor(ctx, data, task, ctx.messageId);
      return promptEditReset(ctx, data, ctx.messageId);
    }
    case "Er": {
      const session = await currentSession(ctx);
      if (!session || !session.state.startsWith("taskedit:")) return;
      const data = wizardDataOf(session);
      const task = await taskForEdit(ctx, data);
      if (!task) return;
      data.resetProgress = a === "yes";
      return promptEditFilter(ctx, data, task, ctx.messageId);
    }
    case "Ef": {
      const session = await currentSession(ctx);
      if (!session || !session.state.startsWith("taskedit:")) return;
      const data = wizardDataOf(session);
      const task = await taskForEdit(ctx, data);
      if (!task) return;
      if (a === "m" && b) {
        toggleMedia(data, b);
        data.filtersTouched = true;
      } else if (a === "min" || a === "max") {
        const value = mbToBytes(Number(b));
        if (a === "min") data.filterMinSizeBytes = value;
        else data.filterMaxSizeBytes = value;
        data.filtersTouched = true;
      } else if (a === "done") {
        return promptEditConfirm(ctx, data, task, ctx.messageId);
      }
      return saveAndEdit(ctx, "taskedit:filter", data, filterPromptView("Ef", data));
    }
    case "Ec": {
      const session = await currentSession(ctx);
      if (!session || !session.state.startsWith("taskedit:")) return;
      const data = wizardDataOf(session);
      const task = await taskForEdit(ctx, data);
      if (!task) return;
      return completeEditTask(ctx, data, task);
    }

    case "p":
      return viewOrError(ctx, await savedView(ctx.env));
    case "Pr": {
      const saved = await findSaved(ctx, a);
      if (!saved) return;
      const result = await startTaskFromSaved(ctx.env, saved);
      await botSend(
        ctx,
        result.ok && result.data
          ? `✅ Started <b>${result.data.label}</b> from the template.`
          : `❌ ${result.ok ? "Task started but could not be re-read." : esc(result.description)}`,
        result.ok && result.data
          ? { inline_keyboard: [[{ text: "📋 Open task", callback_data: `T:${shortId(result.data.id)}` }], [{ text: "« Templates", callback_data: "p" }]] }
          : { inline_keyboard: [[{ text: "« Templates", callback_data: "p" }]] },
      );
      return;
    }
    case "Pd": {
      const saved = await findSaved(ctx, a);
      if (!saved) return;
      return botEdit(
        ctx,
        ctx.messageId,
        "Delete this saved template? Running bots and tasks are not affected.",
        confirmKeyboard(`Pdc:${saved}`, "Delete template", "p"),
      );
    }
    case "Pdc": {
      const id = await findSaved(ctx, a);
      if (!id) return;
      await deleteSavedTask(ctx.env.DB, id);
      return viewOrError(ctx, await savedView(ctx.env));
    }

    case "o":
      return viewOrError(ctx, await toolsBotsView(ctx.env));
    case "O": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) return;
      await saveSession(ctx.env, ctx.chatId, ctx.userId, "tool:chat", { botId: bot.value.id });
      return botEdit(
        ctx,
        ctx.messageId,
        `<b>Chat tools · @${bot.value.bot_username}</b>\n\nSend the chat id or @username to inspect.`,
        { inline_keyboard: [[{ text: "« Tools", callback_data: "o" }], [{ text: "✖️ Cancel", callback_data: "x" }]] },
      );
    }
    case "oc": {
      const session = await currentSession(ctx);
      if (!session || session.state !== "tool:panel") {
        await botSend(ctx, "Open the chat tools menu again.", {
          inline_keyboard: [[{ text: "🛠 Chat tools", callback_data: "o" }]],
        });
        return;
      }
      const data = session.data as { botId?: string; chatId?: string };
      if (!data.botId || !data.chatId) return;
      const action = a;

      if (action === "info") {
        return viewOrError(ctx, await chatInfoView(ctx.env, data.botId, data.chatId));
      }
      if (action === "invite") {
        const bot = await getBotWithSecrets(ctx.env.DB, data.botId);
        if (!bot) return;
        const result = await toResult(() => new TelegramClient(bot.token).createChatInviteLink(data.chatId!));
        await botSend(
          ctx,
          result.ok ? `✅ Invite link: ${esc(result.data.invite_link)}` : `❌ ${esc(result.description)}`,
          {
            inline_keyboard: [
              [{ text: "« Chat panel", callback_data: `Ch:${data.botId.slice(0, 8)}:${data.chatId}` }],
              [{ text: "🛠 Chat tools", callback_data: "o" }],
            ],
          },
        );
        return;
      }
      if (action === "latest") {
        const bot = await getBotWithSecrets(ctx.env.DB, data.botId);
        if (!bot) return;
        const result = await toResult(() => resolveLastN(new TelegramClient(bot.token), data.chatId!, 1));
        await botSend(
          ctx,
          result.ok ? `Latest message id: ${result.data.endId}` : `❌ ${esc(result.description)}`,
          { inline_keyboard: [[{ text: "🛠 Chat tools", callback_data: "o" }]] },
        );
        return;
      }
      if (["revoke", "ban", "unban", "promote", "sendtest", "copytest"].includes(action)) {
        await saveSession(ctx.env, ctx.chatId, ctx.userId, `tool:${action}`, data);
        const prompts: Record<string, string> = {
          revoke: "Send the invite link to revoke.",
          ban: "Send the numeric user id to ban.",
          unban: "Send the numeric user id to unban.",
          promote: "Send the numeric user id to promote (delete, invite, restrict).",
          sendtest: "Send the test message text.",
          copytest: "Send the destination chat id for the test copy.",
        };
        return botEdit(ctx, ctx.messageId, `<b>Chat tools</b>\n\n${prompts[action]}`, {
          inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "o" }]],
        });
      }
      return;
    }
    case "Ch": {
      const bot = await resolveBot(ctx.env, a);
      if (!bot.ok) return;
      return viewOrError(ctx, await chatInfoView(ctx.env, bot.value.id, b ?? ""));
    }

    case "sec":
      return viewOrError(ctx, await securityView(ctx.env));
    case "sa":
      return viewOrError(ctx, await securityView(ctx.env));
    case "sp": {
      await saveSession(ctx.env, ctx.chatId, ctx.userId, "auth:set", {});
      return botEdit(
        ctx,
        ctx.messageId,
        "<b>Set web console password</b>\n\nSend the new password (4–256 characters). Your message is deleted after it is processed.",
        { inline_keyboard: [[{ text: "« Security", callback_data: "sec" }], [{ text: "✖️ Cancel", callback_data: "x" }]] },
      );
    }
    case "sr":
      return botEdit(
        ctx,
        ctx.messageId,
        "⚠️ <b>Remove web console password?</b>\n\nAnyone who can reach the Worker URL will be able to manage bots and tasks.",
        confirmKeyboard("srd", "Remove password", "sec"),
      );
    case "srd": {
      await clearAdminPassword(ctx.env);
      return viewOrError(ctx, await securityView(ctx.env));
    }
    case "adm":
      return viewOrError(ctx, await adminsView(ctx.env));
    case "adma": {
      await saveSession(ctx.env, ctx.chatId, ctx.userId, "admin:add", {});
      return botEdit(
        ctx,
        ctx.messageId,
        "<b>Add controller admin</b>\n\nSend the numeric Telegram user id to allow.",
        { inline_keyboard: [[{ text: "« Admins", callback_data: "adm" }], [{ text: "✖️ Cancel", callback_data: "x" }]] },
      );
    }
    case "admr": {
      if (Number(a) === ctx.userId) {
        await botSend(ctx, "You cannot remove yourself. Ask another admin, or clear the env allowlist.");
      } else if (a) {
        await removeAdminId(ctx.env, Number(a));
      }
      return viewOrError(ctx, await adminsView(ctx.env));
    }
  }
}

async function findSaved(ctx: BotContext, ref: string): Promise<string | null> {
  const saved = await listSavedTasks(ctx.env.DB);
  if (/^\d+$/.test(ref)) {
    const index = Number(ref);
    if (index >= 1 && index <= saved.length) return saved[index - 1].id;
  }
  const exact = saved.filter((s) => s.id === ref);
  if (exact.length === 1) return exact[0].id;
  const prefix = saved.filter((s) => ref.length >= 4 && s.id.startsWith(ref));
  if (prefix.length === 1) return prefix[0].id;
  return null;
}

function toggleMedia(data: WizardData, type: string): void {
  const current = (data.filterMediaTypes ?? "").split(",").filter(Boolean);
  const next = current.includes(type) ? current.filter((t) => t !== type) : [...current, type];
  data.filterMediaTypes = next.length > 0 ? next.join(",") : null;
}

function mbToBytes(mb: number): number | null {
  if (!Number.isFinite(mb) || mb <= 0) return null;
  return Math.round(mb * 1024 * 1024);
}
