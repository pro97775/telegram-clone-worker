import { getAuthMode } from "../auth/handler";
import {
  getBotRateLimitStats,
  getBotWithSecrets,
  getTaskWithBot,
  listActivityLog,
  listAllTasksSummary,
  listBotsSummary,
  listSavedTasks,
  listTasksByBot,
} from "../db/queries";
import { inspectBot } from "../telegram/diagnostics";
import { lookupChat } from "../telegram/chatLookup";
import { TelegramClient } from "../telegram/client";
import type { TelegramInlineKeyboardMarkup as Keyboard } from "../telegram/types";
import type { TaskSummary } from "../shared/rpcTypes";
import { botLine, code, esc, fmtTime, savedTaskLine, scopeLabel, taskDetailHtml, taskLine } from "./render";
import {
  adminsKeyboard,
  activityKeyboard,
  backfillModeKeyboard,
  botDetailKeyboard,
  botsKeyboard,
  chatPanelKeyboard,
  configKeyboard,
  createTaskKeyboard,
  editConfirmKeyboard,
  editResetKeyboard,
  filterKeyboard,
  keepFieldKeyboard,
  lastNKeyboard,
  mainMenuKeyboard,
  modeKeyboard,
  newTaskBotKeyboard,
  pacingKeyboard,
  savedKeyboard,
  scopeKeyboard,
  securityKeyboard,
  taskDetailKeyboard,
  tasksKeyboard,
  toolsBotsKeyboard,
} from "./keyboards";
import { envAdminIds, getAdminIds, getControllerMode } from "./store";
import { countTasksByBot } from "./resolve";

export interface View {
  text: string;
  keyboard?: Keyboard;
}

const PAGE_SIZE = 8;

export async function mainMenuView(env: Env): Promise<View> {
  const [bots, tasks] = await Promise.all([listBotsSummary(env.DB), listAllTasksSummary(env.DB)]);
  const live = tasks.filter((t) => t.live_enabled).length;
  const active = tasks.filter((t) => t.backfill_status === "running").length;
  return {
    text: [
      "<b>Telegram Clone Worker · Control</b>",
      "",
      `Bots <b>${bots.length}</b> · tasks <b>${tasks.length}</b>`,
      `Backfilling <b>${active}</b> · live <b>${live}</b>`,
      "",
      "Tap a button below, or keep using the slash commands.",
    ].join("\n"),
    keyboard: mainMenuKeyboard(),
  };
}

export async function statusView(env: Env): Promise<View> {
  const [bots, tasks, saved, controllerMode] = await Promise.all([
    listBotsSummary(env.DB),
    listAllTasksSummary(env.DB),
    listSavedTasks(env.DB),
    getControllerMode(env),
  ]);
  const live = tasks.filter((t) => t.live_enabled).length;
  const running = tasks.filter((t) => t.backfill_status === "running").length;
  const paused = tasks.filter(
    (t) => t.backfill_status === "paused" || (!t.live_enabled && t.scope === "live"),
  ).length;
  const complete = tasks.filter((t) => t.backfill_status === "complete").length;
  const failed = tasks.filter((t) => t.backfill_status === "failed" || t.stop_reason).length;
  const copied = tasks.reduce((sum, t) => sum + t.processed + t.live_processed, 0);
  const queued = tasks.reduce((sum, t) => sum + (t.pending_count ?? 0), 0);

  return {
    text: [
      "<b>Status</b>",
      "",
      `Bots: <b>${bots.length}</b> · tasks: <b>${tasks.length}</b> · templates: <b>${saved.length}</b>`,
      `Backfilling: <b>${running}</b> · live: <b>${live}</b> · paused: <b>${paused}</b>`,
      `Complete: <b>${complete}</b> · failed/stopped: <b>${failed}</b>`,
      `Messages copied: <b>${copied.toLocaleString()}</b> · queued live: <b>${queued}</b>`,
      "",
      `Delivery: <b>${controllerMode}</b> · cron every minute.`,
    ].join("\n"),
    keyboard: {
      inline_keyboard: [
        [{ text: "📋 Tasks", callback_data: "t:active:0" }, { text: "🤖 Bots", callback_data: "b" }],
        [{ text: "« Menu", callback_data: "m" }],
      ],
    },
  };
}

export async function botsView(env: Env): Promise<View> {
  const [bots, tasks] = await Promise.all([listBotsSummary(env.DB), listAllTasksSummary(env.DB)]);
  if (bots.length === 0) {
    return {
      text: "No bots connected yet. Add one with its @BotFather token.",
      keyboard: {
        inline_keyboard: [
          [{ text: "➕ Add bot", callback_data: "Ba" }],
          [{ text: "➕ New task", callback_data: "n" }],
          [{ text: "« Menu", callback_data: "m" }],
        ],
      },
    };
  }
  const counts = countTasksByBot(tasks);
  return {
    text: [`<b>Connected bots (${bots.length})</b>`, "", ...bots.map((b, i) => botLine(b, i + 1, counts.get(b.id) ?? 0))].join(
      "\n",
    ),
    keyboard: botsKeyboard(bots, counts),
  };
}

export async function botDetailView(env: Env, botId: string): Promise<View | null> {
  const bot = await getBotWithSecrets(env.DB, botId);
  if (!bot) return null;
  const [tasks, rate] = await Promise.all([listTasksByBot(env.DB, bot.id), getBotRateLimitStats(env.DB, bot.id)]);
  const active = tasks.filter(
    (t) => t.live_enabled || t.backfill_status === "running" || t.backfill_status === "paused",
  );
  const rateText = rate.is_cooling_down
    ? `cooling down ${Math.ceil(rate.cooldown_seconds_remaining / 60)} min`
    : "not cooling down";

  const lines = [
    `<b>${esc(bot.label)}</b> @${esc(bot.bot_username)}`,
    `Bot id ${code(bot.bot_id)} · added ${fmtTime(bot.created_at)}`,
    `Tasks: <b>${tasks.length}</b> · active: <b>${active.length}</b>`,
    `Rate limits: ${esc(rateText)} · ${rate.events_last_24h} 429s in 24h`,
  ];
  if (active.length > 0) {
    lines.push("", "<b>Active work</b>");
    for (const task of active.slice(0, 5)) lines.push(`• ${code(task.id.slice(0, 8))} ${esc(task.label)}`);
  }
  lines.push("", "Choose an action below.");
  return { text: lines.join("\n"), keyboard: botDetailKeyboard(bot.id) };
}

export async function botInspectView(env: Env, botId: string): Promise<View | null> {
  const bot = await getBotWithSecrets(env.DB, botId);
  if (!bot) return null;
  const result = await inspectBot(env.DB, new TelegramClient(bot.token), bot.id);
  if (!result.ok) {
    return {
      text: `❌ ${esc(result.description)}`,
      keyboard: { inline_keyboard: [[{ text: "« Bot", callback_data: `B:${bot.id.slice(0, 8)}` }], [{ text: "« Menu", callback_data: "m" }]] },
    };
  }
  const report = result.data;
  const lines = [
    `<b>Inspect @${esc(report.bot_username)}</b>`,
    "",
    `Webhook: <b>${report.webhook.is_active ? "active" : "none"}</b>${report.webhook.url ? ` · ${esc(report.webhook.url)}` : ""}`,
    `Pending updates: ${report.webhook.pending_update_count}`,
    `Polling conflict: <b>${report.polling_session.conflict_detected ? "yes" : "no"}</b>`,
    `Rate limits: ${report.rate_limits.is_cooling_down ? "cooling down" : "ok"} · ${report.rate_limits.events_last_24h} 429s`,
    `Active clone tasks: <b>${report.clone_worker_tasks.active_count}</b>`,
  ];
  for (const task of report.clone_worker_tasks.tasks.slice(0, 4)) lines.push(taskLine(task));
  if (report.recent_activities.length > 0) {
    lines.push("", "<b>Recent updates</b>");
    for (const activity of report.recent_activities.slice(0, 4)) {
      lines.push(`${esc(activity.summary)} — ${esc(activity.chat_name)}`);
    }
  }
  return {
    text: lines.join("\n"),
    keyboard: { inline_keyboard: [[{ text: "« Bot", callback_data: `B:${bot.id.slice(0, 8)}` }], [{ text: "« Menu", callback_data: "m" }]] },
  };
}

function matchesFilter(task: TaskSummary, filter: string): boolean {
  const stopped = Boolean(task.stop_reason);
  switch (filter) {
    case "active":
      return !stopped && (task.live_enabled || task.backfill_status === "running");
    case "paused":
      return !stopped && (task.backfill_status === "paused" || (!task.live_enabled && task.scope === "live"));
    case "done":
      return (
        stopped ||
        task.backfill_status === "complete" ||
        task.backfill_status === "cancelled" ||
        task.backfill_status === "failed"
      );
    default:
      return true;
  }
}

export async function tasksView(
  env: Env,
  filter: string,
  page: number,
  botId?: string,
): Promise<View> {
  const all = await listAllTasksSummary(env.DB);
  const filtered = all.filter((task) => (botId ? task.bot_id === botId : true) && matchesFilter(task, filter));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pages - 1);
  const slice = filtered.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);

  const labels: Record<string, string> = {
    active: "Active",
    paused: "Paused",
    done: "Completed",
    all: "All",
  };
  const lines = [
    `<b>Tasks · ${labels[filter] ?? "All"}${botId ? " · bot filter" : ""}</b>`,
    "",
    filtered.length === 0 ? "Nothing here yet." : `Page ${current + 1}/${pages} · ${filtered.length} task${filtered.length === 1 ? "" : "s"}`,
  ];
  if (slice.length > 0) {
    lines.push("", ...slice.map((task) => `• ${taskLine(task)}`));
  }

  return {
    text: lines.join("\n"),
    keyboard: tasksKeyboard(slice, filter, current, filtered.length),
  };
}

export async function taskDetailView(env: Env, taskId: string): Promise<View | null> {
  const detail = await getTaskWithBot(env.DB, taskId);
  if (!detail) return null;
  return { text: taskDetailHtml(detail, detail.bot_username), keyboard: taskDetailKeyboard(detail) };
}

export async function taskActivityView(env: Env, taskId: string): Promise<View | null> {
  const detail = await getTaskWithBot(env.DB, taskId);
  if (!detail) return null;
  const entries = await listActivityLog(env.DB, taskId, 10);
  const lines = [`<b>Activity · ${esc(detail.label)}</b>`, ""];
  if (entries.length === 0) {
    lines.push("No activity recorded yet.");
  } else {
    for (const entry of entries) {
      const row = entry as { kind: string; ok: number; detail: string | null; error: string | null; at: number };
      lines.push(`${row.ok ? "✅" : "❌"} ${fmtTime(row.at)} · ${esc(row.kind)}`);
      lines.push(`   ${esc(row.detail ?? row.error ?? "")}`);
    }
  }
  return { text: lines.join("\n"), keyboard: activityKeyboard(taskId) };
}

export async function savedView(env: Env): Promise<View> {
  const saved = await listSavedTasks(env.DB);
  if (saved.length === 0) {
    return {
      text: "No saved templates yet. Create a task with Create + save template to keep one.",
      keyboard: { inline_keyboard: [[{ text: "➕ New task", callback_data: "n" }], [{ text: "« Menu", callback_data: "m" }]] },
    };
  }
  return {
    text: [`<b>Saved templates (${saved.length})</b>`, "", ...saved.slice(0, 12).map((s, i) => savedTaskLine(s, i + 1))].join("\n"),
    keyboard: savedKeyboard(saved.slice(0, 12)),
  };
}

export async function toolsBotsView(env: Env): Promise<View> {
  const bots = await listBotsSummary(env.DB);
  if (bots.length === 0) {
    return {
      text: "No bots connected yet.",
      keyboard: { inline_keyboard: [[{ text: "« Menu", callback_data: "m" }]] },
    };
  }
  return {
    text: "<b>Chat tools</b>\n\nChoose the bot that should act on the chat.",
    keyboard: toolsBotsKeyboard(bots),
  };
}

export async function chatInfoView(
  env: Env,
  botId: string,
  chatId: string,
): Promise<View> {
  const bot = await getBotWithSecrets(env.DB, botId);
  if (!bot) {
    return { text: "That bot no longer exists.", keyboard: { inline_keyboard: [[{ text: "« Tools", callback_data: "o" }]] } };
  }
  const lookup = await lookupChat(env.DB, new TelegramClient(bot.token), bot.bot_id, chatId);
  if (!lookup.ok) {
    return {
      text: `❌ ${esc(lookup.description)}`,
      keyboard: {
        inline_keyboard: [
          [{ text: "🔄 Change chat", callback_data: `O:${botId.slice(0, 8)}` }],
          [{ text: "« Menu", callback_data: "m" }],
        ],
      },
    };
  }
  const data = lookup.data;
  const lines = [
    `<b>${esc(data.chat.title ?? data.chat.username ?? data.chat.id)}</b>`,
    `Type: ${esc(data.chat.type)} · id ${code(data.chat.id)}${data.chat.username ? ` · @${esc(data.chat.username)}` : ""}`,
    `Members: ${data.memberCount ?? "unknown"} · bot status: <b>${esc(data.botStatus)}</b>`,
    "",
    "<b>Bot rights</b>",
    ...data.capabilities.map((cap) => `${cap.available ? "✅" : "❌"} ${esc(cap.label)}`),
  ];
  return { text: lines.join("\n"), keyboard: chatPanelKeyboard() };
}

export async function securityView(env: Env): Promise<View> {
  const auth = await getAuthMode(env);
  const admins = await getAdminIds(env);
  return {
    text: [
      "<b>Security</b>",
      "",
      `Web console auth: <b>${auth.mode}</b> via <b>${auth.source}</b>`,
      `Controller admins: <b>${admins.length}</b>`,
      "",
      auth.source === "env"
        ? "The console password is fixed by the ADMIN_PASSWORD secret."
        : auth.source === "d1"
          ? "The console password is stored in D1 and can be changed here."
          : "The console is open. Set a password to protect it.",
    ].join("\n"),
    keyboard: securityKeyboard(auth.source),
  };
}

export async function adminsView(env: Env): Promise<View> {
  const [admins, envIds] = await Promise.all([getAdminIds(env), Promise.resolve(envAdminIds(env))]);
  const lines = ["<b>Controller admins</b>", ""];
  if (admins.length === 0) lines.push("No admins configured.");
  for (const id of admins) lines.push(`• ${code(id)}${envIds.includes(id) ? " · env" : " · stored"}`);
  lines.push("", "Env ids come from BOT_CONTROLLER_ADMIN_IDS and cannot be removed here.");
  return { text: lines.join("\n"), keyboard: adminsKeyboard(admins.filter((id) => !envIds.includes(id))) };
}

export async function configView(env: Env): Promise<View> {
  const [bots, tasks, auth, controllerMode, admins] = await Promise.all([
    listBotsSummary(env.DB),
    listAllTasksSummary(env.DB),
    getAuthMode(env),
    getControllerMode(env),
    getAdminIds(env),
  ]);
  return {
    text: [
      "<b>Effective configuration</b>",
      "",
      `Controller token: <b>${env.BOT_CONTROLLER_TOKEN?.trim() ? "set (env)" : "missing"}</b>`,
      `Controller mode: <b>${controllerMode}</b>`,
      `Webhook secret: <b>${env.BOT_CONTROLLER_WEBHOOK_SECRET?.trim() ? "env" : "generated/stored"}</b>`,
      `Admins: <b>${admins.length}</b>`,
      `Console auth: <b>${auth.mode}</b> via <b>${auth.source}</b>`,
      `Bots: <b>${bots.length}</b> · tasks: <b>${tasks.length}</b>`,
      "",
      "Cron trigger runs every minute.",
    ].join("\n"),
    keyboard: configKeyboard(),
  };
}

export async function modeView(env: Env): Promise<View> {
  const controllerMode = await getControllerMode(env);
  return {
    text: [
      `<b>Delivery mode: ${controllerMode}</b>`,
      "",
      controllerMode === "webhook"
        ? "Telegram calls this Worker instantly for each command."
        : "The cron poller checks for commands once a minute.",
      "",
      "Switch to polling with the button below. Webhook registration needs the authenticated setup endpoint.",
    ].join("\n"),
    keyboard: modeKeyboard(),
  };
}

export function filterPromptView(
  prefix: "Nf" | "Ef",
  data: {
    filterMediaTypes?: string | null;
    filterMinSizeBytes?: number | null;
    filterMaxSizeBytes?: number | null;
  },
): View {
  const selected = (data.filterMediaTypes ?? "").split(",").filter(Boolean);
  return {
    text: [
      "<b>Live message filters</b>",
      "",
      `Media: ${selected.length > 0 ? esc(selected.join(", ")) : "all"}`,
      `Min size: ${data.filterMinSizeBytes ? `${Math.round(data.filterMinSizeBytes / 1048576)} MB` : "off"}`,
      `Max size: ${data.filterMaxSizeBytes ? `${Math.round(data.filterMaxSizeBytes / 1048576)} MB` : "off"}`,
      "",
      "Filters apply to live messages only; backfill always copies everything.",
    ].join("\n"),
    keyboard: filterKeyboard(prefix, data),
  };
}

export function scopePromptView(prefix: "Ns" | "Es", keep = false): View {
  return {
    text: [
      "<b>Scope</b>",
      "",
      "New messages only — live mirror",
      "Existing + new — backfill, then live",
      "Existing only — one-time backfill",
    ].join("\n"),
    keyboard: scopeKeyboard(prefix, keep),
  };
}

export function modePromptView(): View {
  return {
    text: "<b>Backfill mode</b>\n\nRange — copy message ids start…end\nLast N — copy the newest N messages",
    keyboard: backfillModeKeyboard(),
  };
}

export function lastNPromptView(): View {
  return {
    text: "<b>Last N</b>\n\nChoose how many of the newest messages to copy, or send a number.",
    keyboard: lastNKeyboard(),
  };
}

export function pacingPromptView(): View {
  return {
    text: "<b>Pacing</b>\n\nMessages copied per minute. Choose a preset or send a number (1–100).",
    keyboard: pacingKeyboard(),
  };
}

export function createConfirmView(data: {
  botUsername?: string;
  sourceChatTitle?: string | null;
  sourceChatId?: string;
  destChatTitle?: string | null;
  destChatId?: string;
  scope?: TaskSummary["scope"];
  backfillMode?: string;
  n?: number;
  startId?: number;
  endId?: number;
  pacingBatchSize?: number;
  filterMediaTypes?: string | null;
  filterMinSizeBytes?: number | null;
  filterMaxSizeBytes?: number | null;
  duplicateTaskId?: string;
}): View {
  const backfill =
    data.scope === "live"
      ? "none"
      : data.backfillMode === "lastN"
        ? `last ${data.n ?? "?"} messages`
        : `ids ${data.startId ?? "?"}–${data.endId ?? "?"}`;
  const filters =
    data.scope === "backfill_only"
      ? "not used (backfill only)"
      : data.filterMediaTypes || data.filterMinSizeBytes || data.filterMaxSizeBytes
      ? [
          data.filterMediaTypes ?? "all media",
          data.filterMinSizeBytes ? `min ${Math.round(data.filterMinSizeBytes / 1048576)} MB` : "",
          data.filterMaxSizeBytes ? `max ${Math.round(data.filterMaxSizeBytes / 1048576)} MB` : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "all messages";

  const lines = [
    "<b>Review the new task</b>",
    "",
    `<b>Bot</b> @${esc(data.botUsername ?? "")}`,
    `<b>Source</b> ${esc(data.sourceChatTitle ?? data.sourceChatId)} ${code(data.sourceChatId ?? "")}`,
    `<b>Destination</b> ${esc(data.destChatTitle ?? data.destChatId)} ${code(data.destChatId ?? "")}`,
    `<b>Scope</b> ${esc(data.scope ? scopeLabel(data.scope) : "")}`,
    `<b>Backfill</b> ${esc(backfill)} · pace ${data.pacingBatchSize ?? 60}/min`,
    `<b>Live filters</b> ${esc(filters)}`,
  ];
  if (data.duplicateTaskId) {
    lines.push("", "⚠️ A task with this pairing already exists.");
  }
  lines.push("", "Create it?");
  return { text: lines.join("\n"), keyboard: createTaskKeyboard(Boolean(data.duplicateTaskId)) };
}

export function editConfirmView(
  task: TaskSummary,
  data: {
    label?: string;
    scope?: TaskSummary["scope"];
    startId?: number;
    endId?: number;
    cursor?: number;
    resetProgress?: boolean;
    filtersTouched?: boolean;
    filterMediaTypes?: string | null;
  },
): View {
  const scope = data.scope ?? task.scope;
  const lines = [
    "<b>Apply these changes?</b>",
    "",
    `<b>Label</b> ${esc(data.label ?? task.label)}`,
    `<b>Scope</b> ${esc(scopeLabel(scope))}`,
  ];
  if (scope !== "live") {
    lines.push(`<b>Range</b> ${data.startId ?? task.start_id ?? "?"}–${data.endId ?? task.end_id ?? "?"}`);
    lines.push(`<b>Cursor</b> ${data.cursor ?? task.cursor ?? "—"}`);
    lines.push(`<b>Reset progress</b> ${data.resetProgress ? "yes" : "no"}`);
  }
  lines.push("", "Send apply to save.");
  return { text: lines.join("\n"), keyboard: editConfirmKeyboard() };
}

export function editResetView(): View {
  return {
    text: "<b>Progress</b>\n\nReset copied/failed counters and restart the range, or keep them?",
    keyboard: editResetKeyboard(),
  };
}

export function editFieldView(task: TaskSummary, field: "start" | "end" | "cursor", current: number | null): View {
  const labels = {
    start: ["Start id", "the first message id to copy"],
    end: ["End id", "the last message id to copy"],
    cursor: ["Cursor", "the next message id to resume from"],
  } as const;
  return {
    text: [
      `<b>${labels[field][0]}</b>`,
      `Current: ${code(current ?? "not set")}`,
      "",
      `Send ${labels[field][1]}, or keep it.`,
    ].join("\n"),
    keyboard: keepFieldKeyboard(field),
  };
}

export function newTaskBotView(bots: Awaited<ReturnType<typeof listBotsSummary>>): View {
  return {
    text:
      bots.length > 0
        ? "<b>New task · bot</b>\n\nChoose the bot that will copy messages, or add a new token."
        : "<b>New task · bot</b>\n\nNo bots connected yet. Add one with a bot token from @BotFather.",
    keyboard: newTaskBotKeyboard(bots),
  };
}

export function botTasksView(bots: Awaited<ReturnType<typeof listBotsSummary>>, botId: string, tasks: TaskSummary[]): View {
  const bot = bots.find((b) => b.id === botId);
  return {
    text: [
      `<b>Tasks · ${esc(bot?.label ?? "bot")}</b>`,
      "",
      tasks.length === 0 ? "No tasks for this bot." : `${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
      ...tasks.slice(0, 8).map((task) => `• ${taskLine(task)}`),
    ].join("\n"),
    keyboard: {
      inline_keyboard: [
        ...tasks.slice(0, 8).map((task) => [
          { text: `📋 ${task.label.slice(0, 30)}`, callback_data: `T:${task.id.slice(0, 8)}` },
        ]),
        [
          { text: "« Bot", callback_data: `B:${botId.slice(0, 8)}` },
          { text: "« Menu", callback_data: "m" },
        ],
      ],
    },
  };
}
