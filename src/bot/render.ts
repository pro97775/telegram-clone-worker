import type { BotRow } from "../db/queries";
import type { BotSummary, SavedTaskSummary, TaskScope, TaskSummary } from "../shared/rpcTypes";
import { formatBytes } from "../shared/messageFilter";

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function code(value: unknown): string {
  return `<code>${esc(value)}</code>`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function fmtTime(seconds?: number | null): string {
  if (!seconds) return "—";
  const d = new Date(seconds * 1000);
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function pct(part: number, total: number | null): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.round((part / total) * 100));
}

export function progressBar(part: number, total: number | null, width = 10): string {
  const filled = total && total > 0 ? Math.min(width, Math.round((part / total) * width)) : 0;
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export const SCOPE_LABELS: Record<TaskScope, string> = {
  live: "New messages only",
  live_and_backfill: "Existing + new",
  backfill_only: "Existing only (one-time)",
};

export function scopeLabel(scope: TaskScope): string {
  return SCOPE_LABELS[scope] ?? scope;
}

export function taskState(task: TaskSummary): string {
  if (task.stop_reason) return `⛔ stopped (${task.stop_reason.replace(/_/g, " ")})`;
  if (task.scope === "live_and_backfill") {
    const parts: string[] = [];
    if (task.backfill_status === "running") parts.push("📦 backfilling");
    else if (task.backfill_status === "paused") parts.push("⏸ backfill paused");
    else if (task.backfill_status === "complete") parts.push("✅ backfill complete");
    else if (task.backfill_status === "cancelled") parts.push("cancelled");
    else if (task.backfill_status === "failed") parts.push("failed");
    parts.push(task.live_enabled ? "📡 live" : "⏸ live paused");
    return parts.join(" · ");
  }
  if (task.scope === "live") return task.live_enabled ? "📡 live" : "⏸ live paused";
  switch (task.backfill_status) {
    case "running":
      return "📦 backfilling";
    case "paused":
      return "⏸ paused";
    case "complete":
      return "✅ complete";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "❌ failed";
    default:
      return "idle";
  }
}

export function backfillSummary(task: TaskSummary): string {
  if (task.scope === "live" || !task.backfill_mode) return "—";
  if (task.backfill_mode === "lastN") return `last ${task.total ?? "?"} messages`;
  return `ids ${task.start_id ?? "?"}–${task.end_id ?? "?"}`;
}

export function filterSummary(task: TaskSummary): string {
  const parts: string[] = [];
  if (task.filter_media_types) parts.push(`media: ${task.filter_media_types.split(",").join(", ")}`);
  if (task.filter_min_size_bytes) parts.push(`min ${formatBytes(task.filter_min_size_bytes)}`);
  if (task.filter_max_size_bytes) parts.push(`max ${formatBytes(task.filter_max_size_bytes)}`);
  return parts.length > 0 ? parts.join(" · ") : "all messages";
}

export function taskLine(task: TaskSummary, index?: number): string {
  const prefix = index === undefined ? "" : `${index}. `;
  return `${prefix}${code(shortId(task.id))} ${esc(task.label)}\n   ${taskState(task)} · ${task.processed + task.failed} done`;
}

export function taskDetailHtml(task: TaskSummary, botUsername: string): string {
  const scanned = task.total ? Math.min(task.total, task.processed + task.failed) : task.processed + task.failed;
  const lines: string[] = [];
  lines.push(`<b>${esc(task.label)}</b>`);
  lines.push(`${taskState(task)}`);
  lines.push("");
  lines.push(`<b>Bot</b> @${esc(botUsername)}`);
  lines.push(`<b>Source</b> ${esc(task.source_chat_title ?? task.source_chat_id)} ${code(task.source_chat_id)}`);
  lines.push(`<b>Destination</b> ${esc(task.dest_chat_title ?? task.dest_chat_id)} ${code(task.dest_chat_id)}`);
  lines.push(`<b>Scope</b> ${esc(scopeLabel(task.scope))} · pace ${task.pacing_batch_size}/min`);
  lines.push(`<b>Backfill</b> ${esc(backfillSummary(task))}`);

  if (task.scope !== "live") {
    lines.push(
      `   ${progressBar(scanned, task.total)} ${pct(scanned, task.total)}% · ${scanned}/${task.total ?? "?"} scanned`,
    );
    lines.push(`   cursor ${code(task.cursor ?? "—")} · copied ${task.processed} · failed ${task.failed}`);
  }

  if (task.scope !== "backfill_only") {
    lines.push(
      `   live copied ${task.live_processed} · failed ${task.live_failed} · skipped ${task.live_skipped}${
        task.pending_count !== undefined ? ` · queued ${task.pending_count}` : ""
      }`,
    );
    lines.push(`<b>Filters</b> ${esc(filterSummary(task))}`);
  }

  if (task.stop_reason) {
    lines.push(`<b>Stopped</b> ${esc(task.stop_reason.replace(/_/g, " "))} at ${fmtTime(task.stopped_at)}`);
  }
  if (task.rate_limited_until && task.rate_limited_until > Math.floor(Date.now() / 1000)) {
    lines.push(`<b>Cooldown</b> until ${fmtTime(task.rate_limited_until)}`);
  }

  lines.push(`<b>Created</b> ${fmtTime(task.created_at)}`);
  lines.push(`<b>ID</b> ${code(task.id)}`);
  return lines.join("\n");
}

export function botLine(bot: BotSummary | BotRow, index: number, taskCount: number): string {
  return `${index}. <b>${esc(bot.label)}</b> @${esc(bot.bot_username)} · ${taskCount} task${
    taskCount === 1 ? "" : "s"
  }`;
}

export function savedTaskLine(saved: SavedTaskSummary, index: number): string {
  const detail = saved.backfill_mode
    ? saved.backfill_mode === "lastN"
      ? `last ${saved.n ?? "?"} messages`
      : `ids ${saved.start_id ?? "?"}–${saved.end_id ?? "?"}`
    : "no backfill";
  return `${index}. ${code(shortId(saved.id))} <b>${esc(saved.bot_label)}</b> @${esc(saved.bot_username)}\n   ${esc(
    saved.source_chat_title ?? saved.source_chat_id,
  )} → ${esc(saved.dest_chat_title ?? saved.dest_chat_id)}\n   ${esc(scopeLabel(saved.scope))} · ${esc(detail)}`;
}

export function unauthorizedHtml(userId: number, claimAvailable: boolean): string {
  const lines = [
    "⛔ This bot only answers configured controller admins.",
    `Your Telegram user id is ${code(userId)}.`,
  ];
  if (claimAvailable) {
    lines.push("This controller has no admin yet — send /claim &lt;code&gt; with the claim code to take ownership.");
  } else {
    lines.push("Add that id to the BOT_CONTROLLER_ADMIN_IDS secret, or ask an existing admin to run /admin add.");
  }
  return lines.join("\n");
}
