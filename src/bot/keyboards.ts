import type { BotSummary, SavedTaskSummary, TaskSummary } from "../shared/rpcTypes";
import type { TelegramInlineKeyboardMarkup as Keyboard } from "../telegram/types";
import { btn } from "./context";
import { shortId, taskState } from "./render";

const MEDIA_TYPES = ["document", "video", "photo", "audio", "voice", "animation"] as const;

function keyboard(...rows: ReturnType<typeof btn>[][]): Keyboard {
  return { inline_keyboard: rows };
}

function truncate(text: string, max = 34): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function backToMenu(): ReturnType<typeof btn>[] {
  return [btn("« Menu", "m")];
}

export function cancelKeyboard(): Keyboard {
  return keyboard([btn("✖️ Cancel", "x")]);
}

export function configKeyboard(): Keyboard {
  return keyboard([btn("🔐 Security", "sec"), btn("🔀 Delivery mode", "mode")], backToMenu());
}

export function mainMenuKeyboard(): Keyboard {
  return keyboard(
    [btn("📊 Status", "s"), btn("🤖 Bots", "b")],
    [btn("📋 Tasks", "t:active:0"), btn("➕ New task", "n")],
    [btn("🗂 Templates", "p"), btn("🛠 Chat tools", "o")],
    [btn("🔐 Security", "sec"), btn("⚙️ Config", "cfg")],
    [btn("🔀 Delivery mode", "mode")],
  );
}

export function botsKeyboard(bots: BotSummary[], taskCounts?: Map<string, number>): Keyboard {
  const rows = bots.map((bot) => [
    btn(
      `${truncate(bot.label)} · @${bot.bot_username}${taskCounts ? ` (${taskCounts.get(bot.id) ?? 0})` : ""}`,
      `B:${shortId(bot.id)}`,
    ),
  ]);
  return { inline_keyboard: [...rows, [btn("➕ Add bot", "Ba")], backToMenu()] };
}

export function botDetailKeyboard(botId: string): Keyboard {
  const ref = shortId(botId);
  return keyboard(
    [btn("🔍 Inspect", `Bi:${ref}`), btn("📋 Tasks", `Bt:${ref}:0`)],
    [btn("✏️ Rename", `Br:${ref}`), btn("🔌 Webhook off", `Bu:${ref}`)],
    [btn("🗑 Delete", `Bd:${ref}`), ...backToMenu()],
  );
}

export function tasksKeyboard(tasks: TaskSummary[], filter: string, page: number, total: number): Keyboard {
  const rows = tasks.map((task) => {
    const state = taskState(task).replace(/[^\p{Letter}\p{Number} /]/gu, "").trim();
    return [btn(`${truncate(task.label)} · ${truncate(state, 12)}`, `T:${shortId(task.id)}`)];
  });

  const filters: ReturnType<typeof btn>[] = [
    btn(filter === "active" ? "✅ Active" : "Active", "tf:active:0"),
    btn(filter === "paused" ? "✅ Paused" : "Paused", "tf:paused:0"),
    btn(filter === "done" ? "✅ Done" : "Done", "tf:done:0"),
    btn(filter === "all" ? "✅ All" : "All", "tf:all:0"),
  ];

  const pager: ReturnType<typeof btn>[] = [];
  if (page > 0) pager.push(btn("« Prev", `tf:${filter}:${page - 1}`));
  if ((page + 1) * 8 < total) pager.push(btn("Next »", `tf:${filter}:${page + 1}`));

  return {
    inline_keyboard: [
      ...rows,
      filters,
      ...(pager.length > 0 ? [pager] : []),
      [btn("➕ New task", "n"), btn("« Menu", "m")],
    ],
  };
}

export function taskDetailKeyboard(task: TaskSummary): Keyboard {
  const ref = shortId(task.id);
  const rows: ReturnType<typeof btn>[][] = [];
  const stateRow: ReturnType<typeof btn>[] = [];

  if (task.backfill_status === "running" || task.live_enabled) {
    stateRow.push(btn("⏸ Pause", `Tp:${ref}`));
  }
  if (
    !task.live_enabled ||
    (task.scope !== "live" && task.backfill_status !== "running" && task.backfill_status !== "complete")
  ) {
    stateRow.push(btn("▶️ Resume", `Tr:${ref}`));
  }
  if (task.backfill_status === "running" || task.backfill_status === "paused" || task.live_enabled) {
    stateRow.push(btn("⏹ Stop", `Ts:${ref}`));
  }
  if (stateRow.length > 0) rows.push(stateRow);

  rows.push([btn("✏️ Edit", `Te:${ref}`), btn("🧪 Test copy", `Tt:${ref}`), btn("📜 Activity", `Ta:${ref}`)]);
  rows.push([btn("🗑 Delete", `Td:${ref}`), btn("« Tasks", `t:active:0`), btn("« Menu", "m")]);
  return { inline_keyboard: rows };
}

export function activityKeyboard(taskId: string): Keyboard {
  return keyboard([btn("« Task", `T:${shortId(taskId)}`), btn("« Tasks", "t:active:0"), btn("« Menu", "m")]);
}

export function savedKeyboard(saved: SavedTaskSummary[]): Keyboard {
  const rows = saved.flatMap((item) => [
    [btn(`▶️ ${truncate(item.bot_label)} · ${truncate(item.dest_chat_title ?? item.dest_chat_id, 20)}`, `Pr:${shortId(item.id)}`)],
    [btn("🗑 Delete template", `Pd:${shortId(item.id)}`)],
  ]);
  return { inline_keyboard: [...rows, backToMenu()] };
}

export function toolsBotsKeyboard(bots: BotSummary[]): Keyboard {
  const rows = bots.map((bot) => [btn(`${truncate(bot.label)} · @${bot.bot_username}`, `O:${shortId(bot.id)}`)]);
  return { inline_keyboard: [...rows, backToMenu()] };
}

export function chatPanelKeyboard(): Keyboard {
  return keyboard(
    [btn("ℹ️ Info", "oc:info"), btn("🔗 Invite", "oc:invite"), btn("🕘 Latest id", "oc:latest")],
    [btn("🚫 Ban", "oc:ban"), btn("♻️ Unban", "oc:unban"), btn("⭐ Promote", "oc:promote")],
    [btn("✉️ Send test", "oc:sendtest"), btn("🧪 Copy test", "oc:copytest"), btn("🔁 Revoke", "oc:revoke")],
    [btn("🔄 Change chat", "o"), btn("« Menu", "m")],
  );
}

export function securityKeyboard(mode: "env" | "d1" | "none"): Keyboard {
  const rows: ReturnType<typeof btn>[][] = [[btn("🔍 Auth status", "sa")]];
  if (mode !== "env") rows.push([btn("🔑 Set password", "sp")]);
  if (mode === "d1") rows.push([btn("🔓 Remove password", "sr")]);
  rows.push([btn("👥 Admins", "adm"), btn("🔀 Delivery mode", "mode")]);
  rows.push(backToMenu());
  return { inline_keyboard: rows };
}

export function adminsKeyboard(ids: number[]): Keyboard {
  const rows = ids.map((id) => [btn(`Remove ${id}`, `admr:${id}`)]);
  return { inline_keyboard: [...rows, [btn("➕ Add admin", "adma"), btn("« Security", "sec"), btn("« Menu", "m")]] };
}

export function modeKeyboard(): Keyboard {
  return keyboard([btn("🐢 Cron polling", "mp"), btn("⚡ Webhook info", "mw")], backToMenu());
}

export function confirmKeyboard(
  yesData: string,
  yesLabel = "Confirm",
  backData = "m",
): Keyboard {
  return keyboard([btn(`✅ ${yesLabel}`, yesData), btn("✖️ Cancel", backData)]);
}

export function newTaskBotKeyboard(bots: BotSummary[]): Keyboard {
  const rows = bots.map((bot) => [
    btn(`${truncate(bot.label)} · @${bot.bot_username}`, `Nb:${shortId(bot.id)}`),
  ]);
  rows.push([btn("🔑 Add bot token", "Nbt")]);
  rows.push([btn("✖️ Cancel", "x")]);
  return { inline_keyboard: rows };
}

export function scopeKeyboard(prefix: "Ns" | "Es", includeKeep = false): Keyboard {
  const rows: ReturnType<typeof btn>[][] = [
    [btn("📡 New messages only", `${prefix}:live`)],
    [btn("📦 Existing + new", `${prefix}:both`)],
    [btn("🗄 Existing only", `${prefix}:backfill`)],
  ];
  if (includeKeep) rows.push([btn("➖ Keep current scope", `${prefix}:keep`)]);
  rows.push([btn("✖️ Cancel", "x")]);
  return { inline_keyboard: rows };
}

export function backfillModeKeyboard(): Keyboard {
  return keyboard(
    [btn("#️⃣ Range", "Nm:range")],
    [btn("🔢 Last N", "Nm:lastN")],
    [btn("✖️ Cancel", "x")],
  );
}

export function lastNKeyboard(): Keyboard {
  return keyboard(
    [btn("10", "Nn:10"), btn("100", "Nn:100"), btn("1,000", "Nn:1000")],
    [btn("✖️ Cancel", "x")],
  );
}

export function pacingKeyboard(): Keyboard {
  return keyboard(
    [btn("30/min", "Np:30"), btn("60/min", "Np:60"), btn("100/min", "Np:100")],
    [btn("Default (60)", "Np:default")],
    [btn("✖️ Cancel", "x")],
  );
}

export function sizePercent(value: number | null | undefined): string {
  if (!value) return "0";
  return String(Math.round(value / 1048576));
}

export function filterKeyboard(
  prefix: "Nf" | "Ef",
  data: {
    filterMediaTypes?: string | null;
    filterMinSizeBytes?: number | null;
    filterMaxSizeBytes?: number | null;
  },
): Keyboard {
  const selected = new Set((data.filterMediaTypes ?? "").split(",").filter(Boolean));
  const mediaButtons = MEDIA_TYPES.map((type) => [
    btn(`${selected.has(type) ? "✅" : "▫️"} ${type}`, `${prefix}:m:${type}`),
  ]);

  const min = sizePercent(data.filterMinSizeBytes);
  const max = sizePercent(data.filterMaxSizeBytes);

  return {
    inline_keyboard: [
      ...mediaButtons,
      [
        btn(min === "0" ? "✅ No min" : "No min", `${prefix}:min:0`),
        btn(min === "5" ? "✅ 5 MB" : "5 MB", `${prefix}:min:5`),
        btn(min === "10" ? "✅ 10 MB" : "10 MB", `${prefix}:min:10`),
        btn(min === "50" ? "✅ 50 MB" : "50 MB", `${prefix}:min:50`),
      ],
      [
        btn(max === "0" ? "✅ No max" : "No max", `${prefix}:max:0`),
        btn(max === "100" ? "✅ 100 MB" : "100 MB", `${prefix}:max:100`),
        btn(max === "500" ? "✅ 500 MB" : "500 MB", `${prefix}:max:500`),
        btn(max === "1024" ? "✅ 1 GB" : "1 GB", `${prefix}:max:1024`),
      ],
      [btn("✅ Done", `${prefix}:done`), btn("✖️ Cancel", "x")],
    ],
  };
}

export function createTaskKeyboard(hasDuplicate: boolean): Keyboard {
  const rows: ReturnType<typeof btn>[][] = [[btn("🚀 Create", "Nc:create"), btn("💾 Create + save template", "Nc:save")]];
  if (hasDuplicate) rows.push([btn("⚠️ Create duplicate anyway", "Nc:again")]);
  rows.push([btn("✖️ Cancel", "x")]);
  return { inline_keyboard: rows };
}

export function editResetKeyboard(): Keyboard {
  return keyboard([btn("Reset progress", "Er:yes"), btn("Keep progress", "Er:no")], [btn("✖️ Cancel", "x")]);
}

export function editConfirmKeyboard(): Keyboard {
  return keyboard([btn("✅ Apply", "Ec:apply"), btn("✖️ Cancel", "x")]);
}

export function keepFieldKeyboard(field: "start" | "end" | "cursor"): Keyboard {
  return keyboard([btn("➖ Keep current", `Ekeep:${field}`)], [btn("✖️ Cancel", "x")]);
}
