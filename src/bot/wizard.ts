import { findBotByTokenOrBotId, getTask, getTaskWithBot, listBotsSummary } from "../db/queries";
import { createBotRecord } from "../routes/api/bots";
import { applyTaskPatch, createTask, type CreateTaskInput, type TaskPatch } from "../tasks/service";
import { lookupChat } from "../telegram/chatLookup";
import { TelegramClient } from "../telegram/client";
import type { TaskScope, TaskSummary } from "../shared/rpcTypes";
import { botEdit, botSend, type BotContext } from "./context";
import { cancelKeyboard } from "./keyboards";
import { code, esc, scopeLabel, shortId } from "./render";
import { resolveBot } from "./resolve";
import { dropSession, saveSession, type ActiveSession } from "./store";
import {
  createConfirmView,
  editConfirmView,
  editFieldView,
  editResetView,
  filterPromptView,
  lastNPromptView,
  modePromptView,
  newTaskBotView,
  pacingPromptView,
  scopePromptView,
  type View,
} from "./views";

export interface WizardData {
  // new task
  botId?: string;
  botUsername?: string;
  sourceChatId?: string;
  sourceChatTitle?: string | null;
  destChatId?: string;
  destChatTitle?: string | null;
  destWarning?: string;
  scope?: TaskScope;
  backfillMode?: "range" | "lastN";
  startId?: number;
  endId?: number;
  n?: number;
  pacingBatchSize?: number;
  filterMediaTypes?: string | null;
  filterMinSizeBytes?: number | null;
  filterMaxSizeBytes?: number | null;
  allowDuplicate?: boolean;
  duplicateTaskId?: string;
  // edit task
  taskId?: string;
  label?: string;
  cursor?: number;
  resetProgress?: boolean;
  filtersTouched?: boolean;
}

const MEDIA_TYPES = ["document", "video", "photo", "audio", "voice", "animation"] as const;

export type ParsedFilter = {
  mediaTypes: string | null;
  minBytes: number | null;
  maxBytes: number | null;
};

/** Parses `none` or `media=document,video min=10 max=500` (sizes in MB). */
export function parseFilterInput(raw: string): { ok: true; value: ParsedFilter } | { ok: false; error: string } {
  const text = raw.trim().toLowerCase();
  if (text === "" || text === "none" || text === "all" || text === "-") {
    return { ok: true, value: { mediaTypes: null, minBytes: null, maxBytes: null } };
  }

  let mediaTypes: string[] | null = null;
  let minMb: number | null = null;
  let maxMb: number | null = null;

  for (const token of text.split(/\s+/)) {
    const [key, ...valueParts] = token.split("=");
    const value = valueParts.join("=");
    if (!value) {
      return { ok: false, error: `Expected key=value, got "${token}". Example: media=document,video min=10 max=500` };
    }
    if (key === "media") {
      const types = value
        .split(/[,+]/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (types.length === 0) return { ok: false, error: "media= needs at least one type." };
      const invalid = types.filter((t) => !MEDIA_TYPES.includes(t as (typeof MEDIA_TYPES)[number]));
      if (invalid.length > 0) {
        return { ok: false, error: `Unknown media type(s): ${invalid.join(", ")}. Allowed: ${MEDIA_TYPES.join(", ")}.` };
      }
      mediaTypes = types;
    } else if (key === "min" || key === "max") {
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0) return { ok: false, error: `${key} must be a non-negative number of MB.` };
      if (key === "min") minMb = num;
      else maxMb = num;
    } else {
      return { ok: false, error: `Unknown filter "${key}". Use media=, min=, max=.` };
    }
  }

  if (minMb !== null && maxMb !== null && minMb > maxMb) {
    return { ok: false, error: "min cannot be greater than max." };
  }

  return {
    ok: true,
    value: {
      mediaTypes: mediaTypes ? mediaTypes.join(",") : null,
      minBytes: minMb === null ? null : Math.round(minMb * 1024 * 1024),
      maxBytes: maxMb === null ? null : Math.round(maxMb * 1024 * 1024),
    },
  };
}

export function wizardDataOf(session: ActiveSession): WizardData {
  return session.data as WizardData;
}

export function isBotToken(text: string): boolean {
  return /^\d+:[A-Za-z0-9_-]{20,}$/.test(text.trim());
}

function chatTitle(lookup: Awaited<ReturnType<typeof lookupChat>>): { id: string; title: string | null } {
  if (!lookup.ok) return { id: "", title: null };
  const chat = lookup.data.chat;
  return {
    id: String(chat.id),
    title: chat.title ?? (chat.username ? `@${chat.username}` : null),
  };
}

async function show(
  ctx: BotContext,
  state: string,
  data: WizardData,
  view: View,
  edit?: number,
): Promise<void> {
  await saveSession(ctx.env, ctx.chatId, ctx.userId, state, data);
  if (edit === undefined) await botSend(ctx, view.text, view.keyboard);
  else await botEdit(ctx, edit, view.text, view.keyboard);
}

export async function startNewTaskWizard(ctx: BotContext, edit?: number): Promise<void> {
  const bots = await listBotsSummary(ctx.env.DB);
  await show(ctx, "newtask:bot", {}, newTaskBotView(bots), edit);
}

export async function showNewTaskBotPicker(ctx: BotContext, edit?: number): Promise<void> {
  const bots = await listBotsSummary(ctx.env.DB);
  await show(ctx, "newtask:bot", {}, newTaskBotView(bots), edit);
}

export async function startEditTaskWizard(ctx: BotContext, task: TaskSummary, edit?: number): Promise<void> {
  const data: WizardData = {
    taskId: task.id,
    label: task.label,
    filterMediaTypes: task.filter_media_types,
    filterMinSizeBytes: task.filter_min_size_bytes,
    filterMaxSizeBytes: task.filter_max_size_bytes,
  };
  await show(
    ctx,
    "taskedit:label",
    data,
    {
      text: [
        `<b>Edit ${esc(task.label)}</b>`,
        "",
        "<b>Step 1/7 · label</b>",
        `Current: ${esc(task.label)}`,
        "Send a new label, or tap Cancel to abort.",
      ].join("\n"),
      keyboard: cancelKeyboard(),
    },
    edit,
  );
}

export async function promptSource(ctx: BotContext, data: WizardData, edit?: number): Promise<void> {
  await show(
    ctx,
    "newtask:source",
    data,
    {
      text: [
        "<b>Step 2/8 · source chat</b>",
        `Bot: @${esc(data.botUsername ?? "")}`,
        "",
        "Send the source channel/group id (e.g. <code>-1001234567890</code>) or @username.",
        "The bot must already be a member with access to its history.",
      ].join("\n"),
      keyboard: cancelKeyboard(),
    },
    edit,
  );
}

export async function promptDest(ctx: BotContext, data: WizardData, edit?: number): Promise<void> {
  await show(
    ctx,
    "newtask:dest",
    data,
    {
      text: [
        "<b>Step 3/8 · destination chat</b>",
        `Source: ${esc(data.sourceChatTitle ?? data.sourceChatId ?? "")}`,
        "",
        "Send the destination channel/group id or @username.",
        "The bot must be an admin allowed to post there.",
      ].join("\n"),
      keyboard: cancelKeyboard(),
    },
    edit,
  );
}

export async function promptScope(ctx: BotContext, data: WizardData, edit?: number): Promise<void> {
  await show(ctx, "newtask:scope", data, scopePromptView("Ns"), edit);
}

export async function promptMode(ctx: BotContext, data: WizardData, edit?: number): Promise<void> {
  await show(ctx, "newtask:mode", data, modePromptView(), edit);
}

export async function promptRange(ctx: BotContext, data: WizardData, edit?: number): Promise<void> {
  await show(
    ctx,
    "newtask:range",
    data,
    {
      text: "<b>Step 6/8 · range</b>\n\nSend start and end message ids, e.g. <code>1 50000</code>.",
      keyboard: cancelKeyboard(),
    },
    edit,
  );
}

export async function promptLastN(ctx: BotContext, data: WizardData, edit?: number): Promise<void> {
  await show(ctx, "newtask:lastn", data, lastNPromptView(), edit);
}

export async function promptPacing(ctx: BotContext, data: WizardData, edit?: number): Promise<void> {
  await show(ctx, "newtask:pacing", data, pacingPromptView(), edit);
}

export async function promptFilter(ctx: BotContext, data: WizardData, edit?: number): Promise<void> {
  if (data.scope === "backfill_only") {
    await promptConfirm(ctx, data, edit);
    return;
  }
  await show(ctx, "newtask:filter", data, filterPromptView("Nf", data), edit);
}

export async function promptConfirm(ctx: BotContext, data: WizardData, edit?: number): Promise<void> {
  await show(ctx, "newtask:confirm", data, createConfirmView(data), edit);
}

export function taskStateShort(task: TaskSummary): string {
  if (task.stop_reason) return "stopped";
  if (task.live_enabled && task.backfill_status === "running") return "live + backfill running";
  if (task.live_enabled) return "live";
  if (task.backfill_status === "running") return "backfill running";
  return task.backfill_status.replace(/_/g, " ");
}

export async function completeNewTask(
  ctx: BotContext,
  data: WizardData,
  saveTemplate: boolean,
): Promise<void> {
  if (!data.botId || !data.sourceChatId || !data.destChatId || !data.scope) {
    await dropSession(ctx.env, ctx.chatId);
    await botSend(ctx, "That wizard state was incomplete — start again with /newtask or the New task button.");
    return;
  }

  const wantsBackfill = data.scope !== "live";
  const input: CreateTaskInput = {
    sourceChatId: data.sourceChatId,
    sourceChatTitle: data.sourceChatTitle ?? undefined,
    destChatId: data.destChatId,
    destChatTitle: data.destChatTitle ?? undefined,
    scope: data.scope,
    backfillMode: wantsBackfill ? (data.backfillMode ?? "range") : undefined,
    startId: wantsBackfill && data.backfillMode !== "lastN" ? data.startId : undefined,
    endId: wantsBackfill && data.backfillMode !== "lastN" ? data.endId : undefined,
    n: wantsBackfill && data.backfillMode === "lastN" ? data.n : undefined,
    pacingBatchSize: data.pacingBatchSize,
    saveTemplate,
    allowDuplicate: data.allowDuplicate,
    filterMediaTypes: data.filterMediaTypes ?? undefined,
    filterMinSizeBytes: data.filterMinSizeBytes ?? undefined,
    filterMaxSizeBytes: data.filterMaxSizeBytes ?? undefined,
  };

  const result = await createTask(ctx.env, data.botId, input);
  if (!result.ok) {
    if (result.errorCode === 409 && result.duplicateTaskId) {
      data.duplicateTaskId = result.duplicateTaskId;
      await promptConfirm(ctx, data);
      return;
    }
    await botSend(ctx, `❌ ${esc(result.description)}\n\nAdjust the wizard or tap Cancel.`);
    return;
  }

  await dropSession(ctx.env, ctx.chatId);
  const task = result.data;
  await botSend(
    ctx,
    task
      ? [
          "✅ <b>Task created</b>",
          "",
          `<b>${esc(task.label)}</b>`,
          `<b>ID</b> ${code(task.id)}`,
          `<b>Scope</b> ${esc(scopeLabel(task.scope))} · ${esc(taskStateShort(task))}`,
          "",
          "Open it with the button below.",
        ].join("\n")
      : "✅ Task created, but it could not be re-read. Use /tasks to find it.",
    task
      ? { inline_keyboard: [[{ text: "📋 Open task", callback_data: `T:${shortId(task.id)}` }], [{ text: "« Menu", callback_data: "m" }]] }
      : undefined,
  );
}

async function currentEditTask(ctx: BotContext, data: WizardData): Promise<TaskSummary | null> {
  if (!data.taskId) return null;
  const task = await getTask(ctx.env.DB, data.taskId);
  if (!task) {
    await dropSession(ctx.env, ctx.chatId);
    await botSend(ctx, "That task no longer exists. Edit cancelled.");
    return null;
  }
  return task;
}

export function editTargetScope(data: WizardData, task: TaskSummary): TaskScope {
  return data.scope ?? task.scope;
}

export async function promptEditScope(
  ctx: BotContext,
  data: WizardData,
  task: TaskSummary,
  edit?: number,
): Promise<void> {
  await show(ctx, "taskedit:scope", data, scopePromptView("Es", true), edit);
}

export async function promptEditStart(
  ctx: BotContext,
  data: WizardData,
  task: TaskSummary,
  edit?: number,
): Promise<void> {
  await show(ctx, "taskedit:start", data, editFieldView(task, "start", task.start_id), edit);
}

export async function promptEditEnd(
  ctx: BotContext,
  data: WizardData,
  task: TaskSummary,
  edit?: number,
): Promise<void> {
  await show(ctx, "taskedit:end", data, editFieldView(task, "end", task.end_id), edit);
}

export async function promptEditCursor(
  ctx: BotContext,
  data: WizardData,
  task: TaskSummary,
  edit?: number,
): Promise<void> {
  await show(ctx, "taskedit:cursor", data, editFieldView(task, "cursor", task.cursor), edit);
}

export async function promptEditReset(ctx: BotContext, data: WizardData, edit?: number): Promise<void> {
  await show(ctx, "taskedit:reset", data, editResetView(), edit);
}

export async function promptEditFilter(
  ctx: BotContext,
  data: WizardData,
  task: TaskSummary,
  edit?: number,
): Promise<void> {
  // Backfill-only tasks ignore live filters; applyTaskPatch clears them.
  if (editTargetScope(data, task) === "backfill_only") {
    await promptEditConfirm(ctx, data, task, edit);
    return;
  }
  await show(ctx, "taskedit:filter", data, filterPromptView("Ef", data), edit);
}

export async function promptEditConfirm(
  ctx: BotContext,
  data: WizardData,
  task: TaskSummary,
  edit?: number,
): Promise<void> {
  await show(ctx, "taskedit:confirm", data, editConfirmView(task, data), edit);
}

export async function completeEditTask(ctx: BotContext, data: WizardData, task: TaskSummary): Promise<void> {
  const patch: TaskPatch = {
    label: data.label,
    scope: data.scope,
    startId: data.startId,
    endId: data.endId,
    cursor: data.cursor,
    resetProgress: data.resetProgress,
  };
  if (data.filtersTouched) {
    patch.filterMediaTypes = data.filterMediaTypes ?? null;
    patch.filterMinSizeBytes = data.filterMinSizeBytes ?? null;
    patch.filterMaxSizeBytes = data.filterMaxSizeBytes ?? null;
  }

  const result = await applyTaskPatch(ctx.env, task.id, patch);
  if (!result.ok) {
    await botSend(ctx, `❌ ${esc(result.description)}`);
    return;
  }

  await dropSession(ctx.env, ctx.chatId);
  const updated = await getTaskWithBot(ctx.env.DB, task.id);
  await botSend(
    ctx,
    updated
      ? `✅ <b>Task updated</b>\n\n${esc(updated.label)} · ${esc(taskStateShort(updated))}\n<code>${esc(updated.id)}</code>`
      : "✅ Task updated.",
    {
      inline_keyboard: [[{ text: "📋 Open task", callback_data: `T:${shortId(task.id)}` }], [{ text: "« Menu", callback_data: "m" }]],
    },
  );
}

export function parseScopeInput(text: string): TaskScope | null {
  const value = text.trim().toLowerCase();
  if (["1", "live", "live_only", "new", "messages"].includes(value)) return "live";
  if (["2", "both", "all", "live_and_backfill", "live+backfill"].includes(value)) return "live_and_backfill";
  if (["3", "backfill", "backfill_only", "history", "existing"].includes(value)) return "backfill_only";
  return null;
}

export async function advanceWizard(ctx: BotContext, session: ActiveSession): Promise<void> {
  const data = wizardDataOf(session);
  const text = ctx.text.trim();

  switch (session.state) {
    case "newtask:bot": {
      if (isBotToken(text)) {
        // Never leave a token hanging around in chat history.
        await ctx.client.deleteMessage(ctx.chatId, ctx.messageId).catch(() => undefined);
        const existing = await findBotByTokenOrBotId(ctx.env.DB, text);
        if (existing) {
          data.botId = existing.id;
          data.botUsername = existing.bot_username;
          await botSend(ctx, `Using the already connected bot @${esc(existing.bot_username)}.`);
        } else {
          const created = await createBotRecord(ctx.env, "", text);
          if (!created.ok) {
            await botSend(ctx, `❌ ${esc(created.description)}\n\nSend a valid bot token, or tap Cancel.`);
            return;
          }
          data.botId = created.data.id;
          data.botUsername = created.data.bot_username;
          await botSend(ctx, `✅ Connected @${esc(created.data.bot_username)}.`);
        }
      } else {
        const found = await resolveBot(ctx.env, text);
        if (!found.ok) {
          await botSend(ctx, `❌ ${esc(found.error)}`);
          return;
        }
        data.botId = found.value.id;
        data.botUsername = found.value.bot_username;
      }
      await promptSource(ctx, data);
      return;
    }

    case "newtask:source":
    case "newtask:dest": {
      if (!data.botId) {
        await dropSession(ctx.env, ctx.chatId);
        await botSend(ctx, "Wizard state was lost — start again with /newtask.");
        return;
      }
      const bot = await resolveBot(ctx.env, data.botId);
      if (!bot.ok) {
        await dropSession(ctx.env, ctx.chatId);
        await botSend(ctx, `❌ ${esc(bot.error)}`);
        return;
      }
      const client = new TelegramClient(bot.value.token);
      const lookup = await lookupChat(ctx.env.DB, client, bot.value.bot_id, text);
      if (!lookup.ok) {
        await botSend(ctx, `❌ Cannot access ${esc(text)}: ${esc(lookup.description)}`);
        return;
      }
      const resolved = chatTitle(lookup);
      if (session.state === "newtask:source") {
        data.sourceChatId = resolved.id;
        data.sourceChatTitle = resolved.title;
        await promptDest(ctx, data);
      } else {
        data.destChatId = resolved.id;
        data.destChatTitle = resolved.title;
        const send = lookup.data.capabilities.find((c) => c.key === "send_message");
        data.destWarning = send && !send.available ? send.reason : undefined;
        await promptScope(ctx, data);
      }
      return;
    }

    case "newtask:scope": {
      const scope = parseScopeInput(text);
      if (!scope) {
        await botSend(ctx, "Reply 1, 2 or 3, or use the buttons.");
        return;
      }
      data.scope = scope;
      if (scope === "live") await promptPacing(ctx, data);
      else await promptMode(ctx, data);
      return;
    }

    case "newtask:mode": {
      const value = text.toLowerCase();
      if (["1", "range"].includes(value)) data.backfillMode = "range";
      else if (["2", "lastn", "last", "n"].includes(value)) data.backfillMode = "lastN";
      else {
        await botSend(ctx, "Reply 1 for range or 2 for last N, or use the buttons.");
        return;
      }
      if (data.backfillMode === "range") await promptRange(ctx, data);
      else await promptLastN(ctx, data);
      return;
    }

    case "newtask:range": {
      const numbers = (text.match(/\d+/g) ?? []).map(Number);
      if (numbers.length !== 2 || numbers[0] < 1 || numbers[0] > numbers[1]) {
        await botSend(ctx, "Send two message ids with start ≤ end, e.g. <code>1 50000</code>.");
        return;
      }
      data.startId = numbers[0];
      data.endId = numbers[1];
      await promptPacing(ctx, data);
      return;
    }

    case "newtask:lastn": {
      const n = Number(text);
      if (!Number.isInteger(n) || n < 1 || n > 1000000) {
        await botSend(ctx, "Send a whole number between 1 and 1,000,000.");
        return;
      }
      data.n = n;
      await promptPacing(ctx, data);
      return;
    }

    case "newtask:pacing": {
      if (/^(default|auto)$/i.test(text)) {
        data.pacingBatchSize = undefined;
      } else {
        const n = Number(text);
        if (!Number.isInteger(n) || n < 1 || n > 100) {
          await botSend(ctx, "Send a whole number from 1 to 100, or choose Default.");
          return;
        }
        data.pacingBatchSize = n;
      }
      if (data.scope === "backfill_only") await promptConfirm(ctx, data);
      else await promptFilter(ctx, data);
      return;
    }

    case "newtask:filter": {
      const parsed = parseFilterInput(text);
      if (!parsed.ok) {
        await botSend(ctx, `❌ ${esc(parsed.error)}`);
        return;
      }
      data.filterMediaTypes = parsed.value.mediaTypes;
      data.filterMinSizeBytes = parsed.value.minBytes;
      data.filterMaxSizeBytes = parsed.value.maxBytes;
      await promptConfirm(ctx, data);
      return;
    }

    case "newtask:confirm": {
      const value = text.toLowerCase();
      if (["create", "start", "yes", "go"].includes(value)) {
        await completeNewTask(ctx, data, false);
        return;
      }
      if (["save", "template", "savetemplate"].includes(value)) {
        await completeNewTask(ctx, data, true);
        return;
      }
      if (value === "again" && data.duplicateTaskId) {
        data.allowDuplicate = true;
        await completeNewTask(ctx, data, false);
        return;
      }
      await botSend(ctx, "Choose Create or Create + save template, or tap Cancel.");
      return;
    }

    case "taskedit:label": {
      const task = await currentEditTask(ctx, data);
      if (!task) return;
      if (text !== "-") data.label = text;
      await promptEditScope(ctx, data, task);
      return;
    }

    case "taskedit:scope": {
      const task = await currentEditTask(ctx, data);
      if (!task) return;
      if (text !== "-") {
        const scope = parseScopeInput(text);
        if (!scope) {
          await botSend(ctx, "Reply 1, 2, 3 or - to keep, or use the buttons.");
          return;
        }
        data.scope = scope;
      }
      if (editTargetScope(data, task) === "live") await promptEditFilter(ctx, data, task);
      else await promptEditStart(ctx, data, task);
      return;
    }

    case "taskedit:start": {
      const task = await currentEditTask(ctx, data);
      if (!task) return;
      if (text !== "-") {
        const n = Number(text);
        if (!Number.isInteger(n) || n < 1) {
          await botSend(ctx, "Send a positive message id, or use Keep current.");
          return;
        }
        data.startId = n;
      }
      if ((data.startId ?? task.start_id) === null) {
        await botSend(ctx, "A start id is required for backfill — send a number.");
        return;
      }
      await promptEditEnd(ctx, data, task);
      return;
    }

    case "taskedit:end": {
      const task = await currentEditTask(ctx, data);
      if (!task) return;
      if (text !== "-") {
        const n = Number(text);
        if (!Number.isInteger(n) || n < 1) {
          await botSend(ctx, "Send a positive message id, or use Keep current.");
          return;
        }
        data.endId = n;
      }
      if ((data.endId ?? task.end_id) === null) {
        await botSend(ctx, "An end id is required for backfill — send a number.");
        return;
      }
      await promptEditCursor(ctx, data, task);
      return;
    }

    case "taskedit:cursor": {
      const task = await currentEditTask(ctx, data);
      if (!task) return;
      if (text !== "-") {
        const n = Number(text);
        if (!Number.isInteger(n) || n < 0) {
          await botSend(ctx, "Send a non-negative message id, or use Keep current.");
          return;
        }
        data.cursor = n;
      }
      await promptEditReset(ctx, data);
      return;
    }

    case "taskedit:reset": {
      const task = await currentEditTask(ctx, data);
      if (!task) return;
      const value = text.toLowerCase();
      if (!["yes", "no", "y", "n"].includes(value)) {
        await botSend(ctx, "Choose Reset progress or Keep progress.");
        return;
      }
      data.resetProgress = value === "yes" || value === "y";
      await promptEditFilter(ctx, data, task);
      return;
    }

    case "taskedit:filter": {
      const task = await currentEditTask(ctx, data);
      if (!task) return;
      if (text !== "-") {
        const parsed = parseFilterInput(text);
        if (!parsed.ok) {
          await botSend(ctx, `❌ ${esc(parsed.error)}`);
          return;
        }
        data.filtersTouched = true;
        data.filterMediaTypes = parsed.value.mediaTypes;
        data.filterMinSizeBytes = parsed.value.minBytes;
        data.filterMaxSizeBytes = parsed.value.maxBytes;
      }
      await promptEditConfirm(ctx, data, task);
      return;
    }

    case "taskedit:confirm": {
      const task = await currentEditTask(ctx, data);
      if (!task) return;
      if (text.toLowerCase() !== "apply") {
        await botSend(ctx, "Tap Apply to save, or Cancel to abort.");
        return;
      }
      await completeEditTask(ctx, data, task);
      return;
    }

    default: {
      await dropSession(ctx.env, ctx.chatId);
      await botSend(ctx, "That wizard state is no longer valid — start again with /newtask.");
    }
  }
}
