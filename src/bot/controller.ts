import { getAuthMode, storeAdminPassword } from "../auth/handler";
import {
  findBotByTokenOrBotId,
  getBotRateLimitStats,
  getBotWithSecrets,
  getTaskWithBot,
  listActivityLog,
  listAllTasksSummary,
  listBotsSummary,
  listBotsWithSecrets,
  listSavedTasks,
  listTasksByBot,
  updateBotLabel,
  type BotRow,
} from "../db/queries";
import { resolveLastN } from "../jobs/resolveRange";
import { createBotRecord } from "../routes/api/bots";
import type { CapabilityEntry } from "../shared/rpcTypes";
import { applyTaskPatch } from "../tasks/service";
import { performTaskAction } from "../tasks/actions";
import { startTaskFromSaved } from "../tasks/saved";
import type { TelegramUpdate } from "../telegram/types";
import { lookupChat } from "../telegram/chatLookup";
import { TelegramClient, type PromoteRights } from "../telegram/client";
import { inspectBot } from "../telegram/diagnostics";
import { toResult } from "../telegram/errors";
import { botReply, botSend, type BotContext } from "./context";
import {
  code,
  esc,
  fmtTime,
  shortId,
  taskDetailHtml,
  taskLine,
  taskState,
  unauthorizedHtml,
} from "./render";
import { resolveBot, resolveTask, splitLead } from "./resolve";
import {
  addAdminId,
  dropSession,
  envAdminIds,
  getAdminIds,
  getControllerToken,
  getSession,
  isControllerAdmin,
  removeAdminId,
  setControllerMode,
} from "./store";
import { advanceWizard, startEditTaskWizard, startNewTaskWizard } from "./wizard";
import { handleControllerCallback } from "./callbacks";
import { handleTextSession } from "./inputSessions";
import { askConfirm, runConfirmation } from "./confirmations";
import {
  botsView,
  configView,
  mainMenuView,
  modeView,
  savedView,
  securityView,
  statusView,
  tasksView,
} from "./views";

interface ParsedCommand {
  name: string;
  args: string[];
  rawArgs: string;
}

function parseCommand(text: string): ParsedCommand | null {
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const rawArgs = (match[2] ?? "").trim();
  return {
    name: match[1].toLowerCase(),
    args: rawArgs ? rawArgs.split(/\s+/) : [],
    rawArgs,
  };
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handleControllerUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  const token = getControllerToken(env);
  if (!token) return;

  if (update.callback_query) {
    await handleControllerCallback(env, update.callback_query);
    return;
  }

  // Edited messages are ignored: editing an old command would otherwise
  // execute it a second time in webhook mode.
  const message = update.message;
  const from = message?.from;
  if (!message || !message.text || !from || from.is_bot) return;

  const ctx: BotContext = {
    env,
    client: new TelegramClient(token),
    chatId: message.chat.id,
    messageId: message.message_id,
    userId: from.id,
    text: message.text.trim(),
  };

  if (!(await isControllerAdmin(env, from.id))) {
    if (await handleClaim(ctx)) return;
    // Answer /start once so a new operator can learn their user id, but stay
    // silent for everything else so unauthorised traffic cannot make the bot
    // spam replies (and burn its Telegram quota).
    if (!/^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(ctx.text)) return;
    const admins = await getAdminIds(env);
    const claimAvailable = admins.length === 0 && Boolean(env.BOT_CONTROLLER_CLAIM_CODE?.trim());
    await botReply(ctx, unauthorizedHtml(from.id, claimAvailable));
    return;
  }

  const command = parseCommand(ctx.text);
  if (command) {
    await dispatchCommand(ctx, command);
    return;
  }

  const session = await getSession(env, ctx.chatId);
  if (session) {
    if (await handleTextSession(ctx, session)) return;
    await advanceWizard(ctx, session);
    return;
  }

  await botReply(ctx, "Send /help for the command list, or /newtask to create a task.");
}

async function handleClaim(ctx: BotContext): Promise<boolean> {
  const match = /^\/claim(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?$/.exec(ctx.text);
  if (!match) return false;

  const admins = await getAdminIds(ctx.env);
  if (admins.length > 0) return false;

  const expected = ctx.env.BOT_CONTROLLER_CLAIM_CODE?.trim();
  if (!expected) {
    await botReply(
      ctx,
      "This controller has no admin configured.\nSet the BOT_CONTROLLER_ADMIN_IDS secret to your Telegram user id, or set BOT_CONTROLLER_CLAIM_CODE and send /claim &lt;code&gt;.",
    );
    return true;
  }
  if (!match[1] || !safeEqual(match[1], expected)) {
    await botReply(ctx, "❌ Wrong claim code.");
    return true;
  }

  await addAdminId(ctx.env, ctx.userId);
  await botReply(ctx, `✅ You are now a controller admin (user id ${code(ctx.userId)}).\nSend /help to see every command.`);
  return true;
}

async function dispatchCommand(ctx: BotContext, command: ParsedCommand): Promise<void> {
  if (!["cancel", "confirm"].includes(command.name)) {
    await dropSession(ctx.env, ctx.chatId);
  }

  switch (command.name) {
    case "start":
    case "menu":
      return showMainMenu(ctx);
    case "help":
      return sendHelp(ctx);
    case "status":
    case "dashboard":
      return showStatusView(ctx);
    case "config":
      return showConfigView(ctx);
    case "bots":
      return showBotsView(ctx);
    case "bot":
      return sendBotDetail(ctx, command.args[0]);
    case "botadd":
      return addBot(ctx, command);
    case "botrename":
      return renameBot(ctx, command);
    case "botremove":
      return removeBot(ctx, command.args[0]);
    case "botinspect":
      return inspectConnectedBot(ctx, command.args[0]);
    case "botunhook":
      return disconnectWebhook(ctx, command.args[0]);
    case "webhooksync":
      return syncWebhooks(ctx);
    case "tasks":
      return showTasksView(ctx, command.args[0]);
    case "task":
      return sendTaskDetail(ctx, command.args[0]);
    case "activity":
      return sendTaskActivity(ctx, command.args[0], command.args[1]);
    case "pause":
      return setTaskRunningState(ctx, command.args[0], "pause");
    case "resume":
      return setTaskRunningState(ctx, command.args[0], "resume");
    case "stop":
      return setTaskRunningState(ctx, command.args[0], "stop");
    case "tasklabel":
      return relabelTask(ctx, command);
    case "taskedit":
      return editTask(ctx, command.args[0]);
    case "taskdelete":
      return deleteTaskCommand(ctx, command.args[0]);
    case "testcopy":
      return testCopyTask(ctx, command.args[0], command.args[1]);
    case "newtask":
      return startNewTaskWizard(ctx);
    case "saved":
      return showSavedView(ctx);
    case "savedrun":
      return runSaved(ctx, command.args[0]);
    case "saveddel":
      return deleteSaved(ctx, command.args[0]);
    case "chat":
      return sendChat(ctx, command.args);
    case "invite":
      return inviteLink(ctx, command.args);
    case "revoke":
      return revokeInvite(ctx, command.args);
    case "ban":
      return banUser(ctx, command.args, true);
    case "unban":
      return banUser(ctx, command.args, false);
    case "promote":
      return promoteUser(ctx, command.args);
    case "sendtest":
      return sendTestMessage(ctx, command.args);
    case "latest":
      return latestMessageId(ctx, command.args);
    case "copytest":
      return adHocTestCopy(ctx, command.args);
    case "mode":
      return manageMode(ctx, command.args);
    case "admin":
      return manageAdmins(ctx, command.args);
    case "authstatus":
      return showSecurityView(ctx);
    case "authset":
      return setPassword(ctx, command.rawArgs);
    case "authremove":
      return removePassword(ctx);
    case "cancel":
      await dropSession(ctx.env, ctx.chatId);
      return showMainMenu(ctx);
    case "confirm":
      return runConfirmation(ctx);
    default:
      await botReply(ctx, `Unknown command /${esc(command.name)}. Send /help for the list.`);
  }
}

async function sendHelp(ctx: BotContext): Promise<void> {
  await botReply(
    ctx,
    [
      "<b>Telegram Clone Worker · controller</b>",
      "Tip: /start opens the button menu; every list has action buttons.",
      "",
      "<b>Snapshot</b>",
      "/menu — button menu",
      "/status — bots, tasks and throughput",
      "/config — effective settings",
      "",
      "<b>Bots</b>",
      "/bots — list connected bots",
      "/bot &lt;ref&gt; — details + rate limits",
      "/botadd &lt;token&gt; [label] — connect a bot",
      "/botrename &lt;ref&gt; &lt;label&gt;",
      "/botinspect &lt;ref&gt; — external activity check",
      "/botunhook &lt;ref&gt; — remove its webhook",
      "/webhooksync — remove webhooks from all bots",
      "/botremove &lt;ref&gt;",
      "",
      "<b>Tasks</b>",
      "/tasks [botRef] · /task &lt;ref&gt; · /activity &lt;ref&gt; [n]",
      "/newtask — guided creation",
      "/taskedit &lt;ref&gt; — guided edit",
      "/pause &lt;ref&gt; · /resume &lt;ref&gt; · /stop &lt;ref&gt;",
      "/tasklabel &lt;ref&gt; &lt;label&gt; · /taskdelete &lt;ref&gt;",
      "/testcopy &lt;ref&gt; [messageId]",
      "",
      "<b>Templates</b>",
      "/saved · /savedrun &lt;id&gt; · /saveddel &lt;id&gt;",
      "",
      "<b>Chat tools</b> (bot optional when only one exists)",
      "/chat &lt;bot&gt; &lt;chat&gt;",
      "/invite · /revoke · /ban · /unban · /promote",
      "/sendtest · /latest · /copytest",
      "",
      "<b>Security &amp; system</b>",
      "/authstatus · /authset &lt;password&gt; · /authremove",
      "/admin list|add|remove",
      "/mode — webhook vs polling",
      "",
      "Refs accept full ids, unique prefixes, or listing numbers. /cancel aborts a wizard.",
    ].join("\n"),
  );
}

async function showMainMenu(ctx: BotContext): Promise<void> {
  const view = await mainMenuView(ctx.env);
  await botSend(ctx, view.text, view.keyboard);
}

async function showStatusView(ctx: BotContext): Promise<void> {
  const view = await statusView(ctx.env);
  await botSend(ctx, view.text, view.keyboard);
}

async function showConfigView(ctx: BotContext): Promise<void> {
  const view = await configView(ctx.env);
  await botSend(ctx, view.text, view.keyboard);
}

async function showBotsView(ctx: BotContext): Promise<void> {
  const view = await botsView(ctx.env);
  await botSend(ctx, view.text, view.keyboard);
}

async function showSavedView(ctx: BotContext): Promise<void> {
  const view = await savedView(ctx.env);
  await botSend(ctx, view.text, view.keyboard);
}

async function showSecurityView(ctx: BotContext): Promise<void> {
  const view = await securityView(ctx.env);
  await botSend(ctx, view.text, view.keyboard);
}

async function showTasksView(ctx: BotContext, botRef?: string): Promise<void> {
  if (botRef) {
    const bot = await resolveBot(ctx.env, botRef);
    if (!bot.ok) {
      await botReply(ctx, `❌ ${esc(bot.error)}`);
      return;
    }
    const view = await tasksView(ctx.env, "all", 0, bot.value.id);
    await botSend(ctx, view.text, view.keyboard);
    return;
  }
  const view = await tasksView(ctx.env, "active", 0);
  await botSend(ctx, view.text, view.keyboard);
}

function formatRateLimit(rate: {
  is_cooling_down: boolean;
  cooldown_seconds_remaining: number;
  events_last_24h: number;
}): string {
  if (!rate.is_cooling_down) return `not cooling down · ${rate.events_last_24h} 429s in 24h`;
  return `cooling down ${Math.ceil(rate.cooldown_seconds_remaining / 60)} min · ${rate.events_last_24h} 429s in 24h`;
}

async function sendBotDetail(ctx: BotContext, ref?: string): Promise<void> {
  if (!ref) {
    await botReply(ctx, "Usage: /bot &lt;number or @username&gt;");
    return;
  }
  const found = await resolveBot(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  const bot = found.value;
  const [tasks, rate] = await Promise.all([
    listTasksByBot(ctx.env.DB, bot.id),
    getBotRateLimitStats(ctx.env.DB, bot.id),
  ]);
  const active = tasks.filter((t) => t.live_enabled || t.backfill_status === "running" || t.backfill_status === "paused");

  const lines = [
    `<b>${esc(bot.label)}</b> @${esc(bot.bot_username)}`,
    `Bot id ${code(bot.bot_id)} · added ${fmtTime(bot.created_at)}`,
    `Tasks: <b>${tasks.length}</b> · active: <b>${active.length}</b>`,
    `Rate limits: ${esc(formatRateLimit(rate))}`,
  ];
  if (active.length > 0) {
    lines.push("", "<b>Active work</b>");
    for (const task of active.slice(0, 8)) lines.push(taskLine(task));
    if (active.length > 8) lines.push(`… and ${active.length - 8} more`);
  }
  lines.push(
    "",
    `Actions: /botinspect ${esc(shortId(bot.id))} · /botrename · /botunhook · /botremove`,
  );
  await botReply(ctx, lines.join("\n"));
}

async function addBot(ctx: BotContext, command: ParsedCommand): Promise<void> {
  const token = command.args[0];
  const label = command.args.slice(1).join(" ");
  if (!token) {
    await botReply(ctx, "Usage: /botadd &lt;token&gt; [label]\nGet a token from @BotFather. The message is deleted after processing.");
    return;
  }

  // The token must not linger in chat history.
  await ctx.client.deleteMessage(ctx.chatId, ctx.messageId).catch(() => undefined);

  const existing = await findBotByTokenOrBotId(ctx.env.DB, token);
  if (existing) {
    await botReply(ctx, `That token is already connected as <b>${esc(existing.label)}</b> @${esc(existing.bot_username)}.`);
    return;
  }

  const created = await createBotRecord(ctx.env, "", token, label || undefined);
  if (!created.ok) {
    await botReply(ctx, `❌ Telegram rejected the token: ${esc(created.description)}`);
    return;
  }
  await botReply(
    ctx,
    `✅ Connected <b>${esc(created.data.label)}</b> @${esc(created.data.bot_username)}.\nRef: ${code(shortId(created.data.id))} · create a task with /newtask.`,
  );
}

async function renameBot(ctx: BotContext, command: ParsedCommand): Promise<void> {
  const { head, rest } = splitLead(command.rawArgs, 1);
  if (!head[0] || !rest) {
    await botReply(ctx, "Usage: /botrename &lt;bot&gt; &lt;new label&gt;");
    return;
  }
  const found = await resolveBot(ctx.env, head[0]);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  await updateBotLabel(ctx.env.DB, found.value.id, rest);
  await botReply(ctx, `✅ @${esc(found.value.bot_username)} is now labelled <b>${esc(rest)}</b>.`);
}

async function removeBot(ctx: BotContext, ref?: string): Promise<void> {
  if (!ref) {
    await botReply(ctx, "Usage: /botremove &lt;bot&gt;");
    return;
  }
  const found = await resolveBot(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  const tasks = await listTasksByBot(ctx.env.DB, found.value.id);
  await askConfirm(
    ctx,
    "botremove",
    { botId: found.value.id },
    `<b>Delete @${esc(found.value.bot_username)}?</b>\n\nThis disconnects its webhook and permanently deletes <b>${tasks.length}</b> task${
      tasks.length === 1 ? "" : "s"
    } that use it. This cannot be undone.`,
  );
}

async function inspectConnectedBot(ctx: BotContext, ref?: string): Promise<void> {
  if (!ref) {
    await botReply(ctx, "Usage: /botinspect &lt;bot&gt;");
    return;
  }
  const found = await resolveBot(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  const bot = found.value;
  const client = new TelegramClient(bot.token);
  const result = await inspectBot(ctx.env.DB, client, bot.id);
  if (!result.ok) {
    await botReply(ctx, `❌ ${esc(result.description)}`);
    return;
  }

  const report = result.data;
  const lines = [
    `<b>Inspect @${esc(report.bot_username)}</b>`,
    "",
    `Webhook: <b>${report.webhook.is_active ? "active" : "none"}</b>${
      report.webhook.url ? ` · ${esc(report.webhook.url)}` : ""
    }`,
    `Pending updates: ${report.webhook.pending_update_count}`,
    `Polling conflict: <b>${report.polling_session.conflict_detected ? "yes" : "no"}</b>`,
  ];
  if (report.webhook.last_error_message) {
    lines.push(`Last webhook error: ${esc(report.webhook.last_error_message)}`);
  }
  if (report.polling_session.message) lines.push(`↳ ${esc(report.polling_session.message)}`);
  lines.push(`Rate limits: ${esc(formatRateLimit(report.rate_limits))}`);
  lines.push(`Active clone tasks: <b>${report.clone_worker_tasks.active_count}</b>`);
  for (const task of report.clone_worker_tasks.tasks.slice(0, 5)) lines.push(taskLine(task));

  if (report.recent_activities.length > 0) {
    lines.push("", "<b>Recent updates</b>");
    for (const activity of report.recent_activities.slice(0, 6)) {
      lines.push(`${activity.icon} ${esc(activity.summary)} — ${esc(activity.chat_name)}`);
    }
  }
  await botReply(ctx, lines.join("\n"));
}

async function disconnectWebhook(ctx: BotContext, ref?: string): Promise<void> {
  if (!ref) {
    await botReply(ctx, "Usage: /botunhook &lt;bot&gt;");
    return;
  }
  const found = await resolveBot(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  const client = new TelegramClient(found.value.token);
  const result = await toResult(async () => {
    await client.deleteWebhook(false);
    return client.getWebhookInfo().catch(() => null);
  });
  if (!result.ok) {
    await botReply(ctx, `❌ ${esc(result.description)}`);
    return;
  }
  await botReply(
    ctx,
    `✅ Webhook removed from @${esc(found.value.bot_username)}; pending updates preserved (${result.data?.pending_update_count ?? 0}).`,
  );
}

async function syncWebhooks(ctx: BotContext): Promise<void> {
  const bots = await listBotsWithSecrets(ctx.env.DB);
  let removed = 0;
  const errors: string[] = [];
  for (const bot of bots) {
    try {
      await new TelegramClient(bot.token).deleteWebhook(false);
      removed++;
    } catch (e) {
      errors.push(`@${bot.bot_username}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const lines = [`<b>Webhook sync</b>`, "", `Bots checked: <b>${bots.length}</b> · webhooks removed: <b>${removed}</b>`];
  if (errors.length > 0) lines.push("", ...errors.map((e) => `❌ ${esc(e)}`));
  await botReply(ctx, lines.join("\n"));
}

async function sendTaskDetail(ctx: BotContext, ref?: string): Promise<void> {
  if (!ref) {
    await botReply(ctx, "Usage: /task &lt;task id, prefix or number&gt;");
    return;
  }
  const found = await resolveTask(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  const detail = await getTaskWithBot(ctx.env.DB, found.value.id);
  if (!detail) {
    await botReply(ctx, "That task no longer exists.");
    return;
  }
  const actions =
    detail.scope === "live"
      ? `/pause ${shortId(detail.id)} · /resume ${shortId(detail.id)} · /taskedit ${shortId(detail.id)}`
      : `/pause ${shortId(detail.id)} · /resume ${shortId(detail.id)} · /stop ${shortId(detail.id)} · /taskedit ${shortId(detail.id)}`;
  await botReply(ctx, `${taskDetailHtml(detail, detail.bot_username)}\n\n${actions}`);
}

async function sendTaskActivity(ctx: BotContext, ref?: string, limitArg?: string): Promise<void> {
  if (!ref) {
    await botReply(ctx, "Usage: /activity &lt;task&gt; [count]");
    return;
  }
  const found = await resolveTask(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  const limit = Math.min(30, Math.max(1, Number(limitArg) || 10));
  const entries = await listActivityLog(ctx.env.DB, found.value.id, limit);
  if (entries.length === 0) {
    await botReply(ctx, `No activity recorded yet for ${esc(found.value.label)}.`);
    return;
  }
  const lines = [`<b>Activity · ${esc(found.value.label)}</b>`, ""];
  for (const entry of entries) {
    const row = entry as { kind: string; ok: number; detail: string | null; error: string | null; at: number };
    const icon = row.ok ? "✅" : "❌";
    const detail = row.detail ?? row.error ?? "";
    lines.push(`${icon} ${fmtTime(row.at)} · ${esc(row.kind)}\n   ${esc(detail)}`);
  }
  await botReply(ctx, lines.join("\n"));
}

async function setTaskRunningState(
  ctx: BotContext,
  ref: string | undefined,
  action: "pause" | "resume" | "stop",
): Promise<void> {
  if (!ref) {
    await botReply(ctx, `Usage: /${action} &lt;task&gt;`);
    return;
  }
  const found = await resolveTask(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  const task = found.value;
  const result = await performTaskAction(ctx.env, task, action);
  if (!result.ok) {
    await botReply(ctx, `❌ ${esc(result.description)}`);
    return;
  }
  await botReply(
    ctx,
    `✅ ${result.label} ${esc(task.label)}.\nNow: ${esc(taskState(result.task ?? task))}`,
  );
}

async function relabelTask(ctx: BotContext, command: ParsedCommand): Promise<void> {
  const { head, rest } = splitLead(command.rawArgs, 1);
  if (!head[0] || !rest) {
    await botReply(ctx, "Usage: /tasklabel &lt;task&gt; &lt;new label&gt;");
    return;
  }
  const found = await resolveTask(ctx.env, head[0]);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  const result = await applyTaskPatch(ctx.env, found.value.id, { label: rest });
  if (!result.ok) {
    await botReply(ctx, `❌ ${esc(result.description)}`);
    return;
  }
  await botReply(ctx, `✅ Task renamed to <b>${esc(rest)}</b>.`);
}

async function editTask(ctx: BotContext, ref?: string): Promise<void> {
  if (!ref) {
    await botReply(ctx, "Usage: /taskedit &lt;task&gt;");
    return;
  }
  const found = await resolveTask(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  await startEditTaskWizard(ctx, found.value);
}

async function deleteTaskCommand(ctx: BotContext, ref?: string): Promise<void> {
  if (!ref) {
    await botReply(ctx, "Usage: /taskdelete &lt;task&gt;");
    return;
  }
  const found = await resolveTask(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  await askConfirm(
    ctx,
    "taskdelete",
    { taskId: found.value.id },
    `<b>Delete "${esc(found.value.label)}"?</b>\n\nThis removes the task and its activity log permanently. The bot and chats stay untouched.`,
  );
}

async function testCopyTask(ctx: BotContext, ref?: string, messageIdArg?: string): Promise<void> {
  if (!ref) {
    await botReply(ctx, "Usage: /testcopy &lt;task&gt; [messageId]");
    return;
  }
  const found = await resolveTask(ctx.env, ref);
  if (!found.ok) {
    await botReply(ctx, `❌ ${esc(found.error)}`);
    return;
  }
  const task = found.value;
  const bot = await getBotWithSecrets(ctx.env.DB, task.bot_id);
  if (!bot) {
    await botReply(ctx, "That task's bot row is missing.");
    return;
  }
  const client = new TelegramClient(bot.token);
  const result = await toResult(async () => {
    const copyId = Number(messageIdArg) || (await resolveLastN(client, task.source_chat_id, 1)).endId;
    const copy = await client.copyMessage(task.dest_chat_id, task.source_chat_id, copyId);
    return { copyId, copy };
  });
  await botReply(
    ctx,
    result.ok
      ? `✅ Copied message ${code(result.data.copyId)} → destination (new message ${code(
          result.data.copy.message_id,
        )}).`
      : `❌ ${esc(result.description)}`,
  );
}

async function resolveSavedTask(ctx: BotContext, ref: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const saved = await listSavedTasks(ctx.env.DB);
  if (saved.length === 0) return { ok: false, error: "No saved templates exist." };
  if (/^\d+$/.test(ref)) {
    const index = Number(ref);
    if (index >= 1 && index <= saved.length) return { ok: true, id: saved[index - 1].id };
  }
  const exact = saved.filter((s) => s.id === ref);
  if (exact.length === 1) return { ok: true, id: exact[0].id };
  const prefix = saved.filter((s) => ref.length >= 4 && s.id.startsWith(ref));
  if (prefix.length === 1) return { ok: true, id: prefix[0].id };
  if (prefix.length > 1) return { ok: false, error: "That template reference matches more than one." };
  return { ok: false, error: `No template matches ${ref}. Use /saved to list them.` };
}

async function runSaved(ctx: BotContext, ref?: string): Promise<void> {
  if (!ref) {
    await botReply(ctx, "Usage: /savedrun &lt;number or id&gt;");
    return;
  }
  const resolved = await resolveSavedTask(ctx, ref);
  if (!resolved.ok) {
    await botReply(ctx, `❌ ${esc(resolved.error)}`);
    return;
  }
  const result = await startTaskFromSaved(ctx.env, resolved.id);
  if (!result.ok) {
    await botReply(ctx, `❌ ${esc(result.description)}`);
    return;
  }
  await botReply(
    ctx,
    result.data
      ? `✅ Started <b>${esc(result.data.label)}</b> from the template.`
      : "✅ Task started from the template.",
  );
}

async function deleteSaved(ctx: BotContext, ref?: string): Promise<void> {
  if (!ref) {
    await botReply(ctx, "Usage: /saveddel &lt;number or id&gt;");
    return;
  }
  const resolved = await resolveSavedTask(ctx, ref);
  if (!resolved.ok) {
    await botReply(ctx, `❌ ${esc(resolved.error)}`);
    return;
  }
  await askConfirm(
    ctx,
    "saveddel",
    { savedId: resolved.id },
    "Delete this saved template? Running bots and tasks are not affected.",
  );
}

interface BotChatTarget {
  bot: BotRow;
  chatId: string;
  rest: string;
}

async function resolveBotChat(
  ctx: BotContext,
  args: string[],
): Promise<BotChatTarget | { error: string }> {
  if (args.length >= 2) {
    const found = await resolveBot(ctx.env, args[0]);
    if (found.ok) return { bot: found.value, chatId: args[1], rest: args.slice(2).join(" ") };
  }
  const bots = await listBotsWithSecrets(ctx.env.DB);
  if (bots.length === 1 && args.length >= 1) {
    return { bot: bots[0], chatId: args[0], rest: args.slice(1).join(" ") };
  }
  return {
    error:
      bots.length === 0
        ? "No bots connected yet."
        : "Give the bot first: /command &lt;bot&gt; &lt;chat&gt; … (or connect just one bot to omit it).",
  };
}

function isTarget(value: BotChatTarget | { error: string }): value is BotChatTarget {
  return !("error" in value);
}

function capabilityLine(cap: CapabilityEntry): string {
  return `${cap.available ? "✅" : "❌"} ${esc(cap.label)}${cap.reason ? ` — ${esc(cap.reason)}` : ""}`;
}

async function sendChat(ctx: BotContext, args: string[]): Promise<void> {
  const target = await resolveBotChat(ctx, args);
  if (!isTarget(target)) {
    await botReply(ctx, `❌ ${esc(target.error)}`);
    return;
  }
  const client = new TelegramClient(target.bot.token);
  const lookup = await lookupChat(ctx.env.DB, client, target.bot.bot_id, target.chatId);
  if (!lookup.ok) {
    await botReply(ctx, `❌ ${esc(lookup.description)}`);
    return;
  }
  const data = lookup.data;
  const lines = [
    `<b>${esc(data.chat.title ?? data.chat.username ?? data.chat.id)}</b>`,
    `Type: ${esc(data.chat.type)} · id ${code(data.chat.id)}${data.chat.username ? ` · @${esc(data.chat.username)}` : ""}`,
    `Members: ${data.memberCount ?? "unknown"}`,
    `Bot status: <b>${esc(data.botStatus)}</b>`,
    "",
    "<b>Bot rights</b>",
    ...data.capabilities.map(capabilityLine),
  ];
  if (data.admins && data.admins.length > 0) {
    lines.push("", "<b>Admins</b>");
    for (const admin of data.admins.slice(0, 10)) lines.push(`• ${esc(admin.name)} (${esc(admin.status)})`);
  }
  if (data.pastTasks && data.pastTasks.length > 0) {
    lines.push("", `<b>Past tasks from this source</b>: ${data.pastTasks.length}`);
    for (const task of data.pastTasks.slice(0, 5)) {
      lines.push(`• ${code(shortId(task.id))} ${esc(task.label)}`);
    }
  }
  lines.push(
    "",
    `Actions: /invite · /ban · /unban · /promote · /sendtest · /latest · /copytest\nBot: @${esc(target.bot.bot_username)} · chat ${code(data.chat.id)}`,
  );
  await botReply(ctx, lines.join("\n"));
}

async function inviteLink(ctx: BotContext, args: string[]): Promise<void> {
  const target = await resolveBotChat(ctx, args);
  if (!isTarget(target)) {
    await botReply(ctx, `❌ ${esc(target.error)}`);
    return;
  }
  const client = new TelegramClient(target.bot.token);
  const result = await toResult(() => client.createChatInviteLink(target.chatId));
  await botReply(
    ctx,
    result.ok ? `✅ Invite link: ${esc(result.data.invite_link)}` : `❌ ${esc(result.description)}`,
  );
}

async function revokeInvite(ctx: BotContext, args: string[]): Promise<void> {
  const target = await resolveBotChat(ctx, args);
  if (!isTarget(target)) {
    await botReply(ctx, `❌ ${esc(target.error)}`);
    return;
  }
  if (!target.rest) {
    await botReply(ctx, "Usage: /revoke &lt;bot&gt; &lt;chat&gt; &lt;invite link&gt;");
    return;
  }
  const client = new TelegramClient(target.bot.token);
  const result = await toResult(() => client.revokeChatInviteLink(target.chatId, target.rest));
  await botReply(
    ctx,
    result.ok ? `✅ Invite link revoked: ${esc(result.data.invite_link)}` : `❌ ${esc(result.description)}`,
  );
}

async function banUser(ctx: BotContext, args: string[], ban: boolean): Promise<void> {
  const target = await resolveBotChat(ctx, args);
  if (!isTarget(target)) {
    await botReply(ctx, `❌ ${esc(target.error)}`);
    return;
  }
  const userId = Number(target.rest.trim().split(/\s+/)[0]);
  if (!Number.isInteger(userId) || userId <= 0) {
    await botReply(ctx, `Usage: /${ban ? "ban" : "unban"} &lt;bot&gt; &lt;chat&gt; &lt;userId&gt;`);
    return;
  }
  const client = new TelegramClient(target.bot.token);
  const result = await toResult(() =>
    ban ? client.banChatMember(target.chatId, userId) : client.unbanChatMember(target.chatId, userId),
  );
  await botReply(
    ctx,
    result.ok
      ? `✅ User ${userId} ${ban ? "banned" : "unbanned"} in ${esc(target.chatId)}.`
      : `❌ ${esc(result.description)}`,
  );
}

const PROMOTE_RIGHTS: Record<string, keyof PromoteRights> = {
  delete: "can_delete_messages",
  invite: "can_invite_users",
  restrict: "can_restrict_members",
  promote: "can_promote_members",
  info: "can_change_info",
  pin: "can_pin_messages",
  manage: "can_manage_chat",
};

async function promoteUser(ctx: BotContext, args: string[]): Promise<void> {
  const target = await resolveBotChat(ctx, args);
  if (!isTarget(target)) {
    await botReply(ctx, `❌ ${esc(target.error)}`);
    return;
  }
  const [userIdText, ...rightTokens] = target.rest.trim().split(/\s+/).filter(Boolean);
  const userId = Number(userIdText);
  if (!Number.isInteger(userId) || userId <= 0) {
    await botReply(
      ctx,
      "Usage: /promote &lt;bot&gt; &lt;chat&gt; &lt;userId&gt; [delete,invite,restrict,promote,info,pin,manage]\nDefault rights: delete, invite, restrict.",
    );
    return;
  }

  let rights: PromoteRights = {
    can_delete_messages: true,
    can_invite_users: true,
    can_restrict_members: true,
  };
  if (rightTokens.length > 0) {
    const requested = rightTokens
      .join(",")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean);
    const unknown = requested.filter((token) => !(token in PROMOTE_RIGHTS));
    if (unknown.length > 0 || requested.length === 0) {
      await botReply(
        ctx,
        `❌ Unknown right(s): ${esc(unknown.join(", ") || "(none)")}. Use: ${Object.keys(PROMOTE_RIGHTS).join(", ")}.`,
      );
      return;
    }
    rights = {};
    for (const token of requested) rights[PROMOTE_RIGHTS[token]] = true;
  }

  const client = new TelegramClient(target.bot.token);
  const result = await toResult(() => client.promoteChatMember(target.chatId, userId, rights));
  await botReply(
    ctx,
    result.ok ? `✅ User ${userId} promoted with: ${esc(Object.keys(rights).join(", "))}.` : `❌ ${esc(result.description)}`,
  );
}

async function sendTestMessage(ctx: BotContext, args: string[]): Promise<void> {
  const target = await resolveBotChat(ctx, args);
  if (!isTarget(target)) {
    await botReply(ctx, `❌ ${esc(target.error)}`);
    return;
  }
  const text = target.rest || "Test message from Telegram Clone Worker";
  const client = new TelegramClient(target.bot.token);
  const result = await toResult(() => client.sendMessage(target.chatId, text));
  await botReply(
    ctx,
    result.ok
      ? `✅ Sent as message ${code(result.data.message_id)} in ${esc(target.chatId)}.`
      : `❌ ${esc(result.description)}`,
  );
}

async function latestMessageId(ctx: BotContext, args: string[]): Promise<void> {
  const target = await resolveBotChat(ctx, args);
  if (!isTarget(target)) {
    await botReply(ctx, `❌ ${esc(target.error)}`);
    return;
  }
  const client = new TelegramClient(target.bot.token);
  const result = await toResult(() => resolveLastN(client, target.chatId, 1));
  await botReply(
    ctx,
    result.ok
      ? `Latest message id: ${code(result.data.endId)}${result.data.cleanupOk ? "" : " (probe message could not be deleted)"}`
      : `❌ ${esc(result.description)}`,
  );
}

async function adHocTestCopy(ctx: BotContext, args: string[]): Promise<void> {
  const bots = await listBotsWithSecrets(ctx.env.DB);
  if (bots.length === 0) {
    await botReply(ctx, "No bots connected yet.");
    return;
  }

  let bot: BotRow | null = null;
  let sourceChatId = "";
  let destChatId = "";
  let messageIdArg = "";

  if (args.length >= 3) {
    const found = await resolveBot(ctx.env, args[0]);
    if (found.ok) {
      bot = found.value;
      sourceChatId = args[1];
      destChatId = args[2];
      messageIdArg = args[3] ?? "";
    }
  }
  if (!bot && bots.length === 1 && args.length >= 2) {
    bot = bots[0];
    sourceChatId = args[0];
    destChatId = args[1];
    messageIdArg = args[2] ?? "";
  }
  if (!bot || !sourceChatId || !destChatId) {
    await botReply(ctx, "Usage: /copytest &lt;bot&gt; &lt;sourceChat&gt; &lt;destChat&gt; [messageId]");
    return;
  }

  const client = new TelegramClient(bot.token);
  const result = await toResult(async () => {
    const copyId = Number(messageIdArg) || (await resolveLastN(client, sourceChatId, 1)).endId;
    return { copyId, copy: await client.copyMessage(destChatId, sourceChatId, copyId) };
  });
  await botReply(
    ctx,
    result.ok
      ? `✅ Copied message ${code(result.data.copyId)} → destination (new message ${code(result.data.copy.message_id)}).`
      : `❌ ${esc(result.description)}`,
  );
}

async function manageMode(ctx: BotContext, args: string[]): Promise<void> {
  if (args.length === 0) {
    const view = await modeView(ctx.env);
    await botSend(ctx, view.text, view.keyboard);
    return;
  }

  const choice = args[0].toLowerCase();
  if (choice === "poll") {
    // A registered webhook would keep winning over getUpdates with a 409.
    await ctx.client.deleteWebhook(false).catch(() => undefined);
    await setControllerMode(ctx.env, "poll");
    await botReply(
      ctx,
      "✅ Webhook removed and mode set to <b>poll</b>. The cron poller will pick up commands once a minute.",
    );
    return;
  }
  if (choice === "webhook") {
    await botReply(
      ctx,
      "To switch to webhook mode, call the authenticated endpoint:\n<code>POST /api/bot-controller/setup</code>\nIt registers this Worker's URL with Telegram and flips the mode automatically.",
    );
    return;
  }
  await botReply(ctx, "Usage: /mode [poll|webhook]");
}

async function manageAdmins(ctx: BotContext, args: string[]): Promise<void> {
  const action = (args[0] ?? "list").toLowerCase();
  if (action === "list") {
    const [admins, envIds] = await Promise.all([getAdminIds(ctx.env), Promise.resolve(envAdminIds(ctx.env))]);
    const lines = ["<b>Controller admins</b>", ""];
    if (admins.length === 0) lines.push("No admins configured.");
    for (const id of admins) {
      lines.push(`• ${code(id)}${envIds.includes(id) ? " · env" : " · stored"}`);
    }
    lines.push("", "Add with /admin add &lt;userId&gt;, remove stored ids with /admin remove &lt;userId&gt;.");
    lines.push("Env ids come from BOT_CONTROLLER_ADMIN_IDS and cannot be removed from chat.");
    await botReply(ctx, lines.join("\n"));
    return;
  }

  const userId = Number(args[1]);
  if (!Number.isInteger(userId) || userId <= 0) {
    await botReply(ctx, "Usage: /admin list | /admin add &lt;userId&gt; | /admin remove &lt;userId&gt;");
    return;
  }

  if (action === "add") {
    const added = await addAdminId(ctx.env, userId);
    await botReply(
      ctx,
      added ? `✅ ${code(userId)} can now control this bot.` : `${code(userId)} is already an admin (env-managed).`,
    );
    return;
  }
  if (action === "remove") {
    if (userId === ctx.userId) {
      await botReply(ctx, "You cannot remove yourself. Ask another admin, or clear the env allowlist.");
      return;
    }
    const removed = await removeAdminId(ctx.env, userId);
    await botReply(
      ctx,
      removed
        ? `✅ Removed ${code(userId)}.`
        : `Could not remove ${code(userId)} — it is env-managed or not stored.`,
    );
    return;
  }
  await botReply(ctx, "Usage: /admin list | /admin add &lt;userId&gt; | /admin remove &lt;userId&gt;");
}

async function setPassword(ctx: BotContext, rawArgs: string): Promise<void> {
  const password = rawArgs.trim();
  const auth = await getAuthMode(ctx.env);

  // Delete the message carrying the password first, regardless of outcome.
  await ctx.client.deleteMessage(ctx.chatId, ctx.messageId).catch(() => undefined);

  if (auth.source === "env") {
    await botReply(ctx, "❌ The password is managed by the ADMIN_PASSWORD secret and cannot be changed from chat.");
    return;
  }
  if (password.length < 4 || password.length > 256) {
    await botReply(ctx, "❌ Password must be 4–256 characters. Send /authset &lt;password&gt; again.");
    return;
  }

  await storeAdminPassword(ctx.env, password);
  await botReply(ctx, "✅ Web console password updated. The message containing it was deleted.");
}

async function removePassword(ctx: BotContext): Promise<void> {
  const auth = await getAuthMode(ctx.env);
  if (auth.source === "env") {
    await botReply(ctx, "❌ The password is managed by ADMIN_PASSWORD; remove that secret to disable it.");
    return;
  }
  if (auth.source === "none") {
    await botReply(ctx, "The web console is already open (no password).");
    return;
  }
  await askConfirm(
    ctx,
    "authremove",
    {},
    "⚠️ <b>Remove web console password?</b>\n\nAnyone who can reach the Worker URL will be able to manage bots and tasks.",
  );
}

export async function controllerDashboard(env: Env): Promise<{ bots: number; tasks: number; admins: number }> {
  const [bots, tasks, admins] = await Promise.all([
    listBotsSummary(env.DB),
    listAllTasksSummary(env.DB),
    getAdminIds(env),
  ]);
  return { bots: bots.length, tasks: tasks.length, admins: admins.length };
}
