import { listAllTasksSummary, listBotsWithSecrets, type BotRow } from "../db/queries";
import type { TaskSummary } from "../shared/rpcTypes";
import { esc, shortId } from "./render";

export type Lookup<T> = { ok: true; value: T } | { ok: false; error: string };

function dedupeById<T extends { id: string }>(matches: T[]): T[] {
  const seen = new Set<string>();
  return matches.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

/** Accepts a bot id, bot id prefix, @username, numeric bot_id, label, or the
 * 1-based index shown by /bots. */
export async function resolveBot(env: Env, ref: string): Promise<Lookup<BotRow>> {
  const bots = await listBotsWithSecrets(env.DB);
  if (bots.length === 0) return { ok: false, error: "No bots are connected yet. Add one with /botadd <token>." };

  const raw = ref.trim();
  if (!raw) return { ok: false, error: "Which bot? Give a bot id, @username, or the number from /bots." };

  if (/^\d+$/.test(raw)) {
    const index = Number(raw);
    if (index >= 1 && index <= bots.length) return { ok: true, value: bots[index - 1] };
    const byTelegramId = bots.filter((b) => b.bot_id === index);
    if (byTelegramId.length === 1) return { ok: true, value: byTelegramId[0] };
  }

  const cleaned = raw.replace(/^@/, "").toLowerCase();
  const exact = dedupeById(
    bots.filter(
      (b) =>
        b.id === raw ||
        b.bot_username.toLowerCase() === cleaned ||
        b.label.toLowerCase() === raw.toLowerCase(),
    ),
  );
  if (exact.length === 1) return { ok: true, value: exact[0] };

  if (cleaned.length >= 3) {
    const prefixed = dedupeById(bots.filter((b) => b.bot_username.toLowerCase().startsWith(cleaned)));
    if (prefixed.length === 1) return { ok: true, value: prefixed[0] };
    if (prefixed.length > 1) return { ok: false, error: ambiguous("bot", prefixed.map((b) => `@${b.bot_username}`)) };
  }

  if (raw.length >= 4) {
    const byId = dedupeById(bots.filter((b) => b.id.startsWith(raw)));
    if (byId.length === 1) return { ok: true, value: byId[0] };
    if (byId.length > 1) {
      return { ok: false, error: ambiguous("bot", byId.map((b) => `${shortId(b.id)} (@${b.bot_username})`)) };
    }
  }

  return { ok: false, error: `No bot matches ${raw}. Use /bots to list them.` };
}

/** Accepts a task id, task id prefix, label, or the 1-based index from /tasks. */
export async function resolveTask(env: Env, ref: string): Promise<Lookup<TaskSummary>> {
  const tasks = await listAllTasksSummary(env.DB);
  if (tasks.length === 0) return { ok: false, error: "No tasks exist yet. Create one with /newtask." };

  const raw = ref.trim();
  if (!raw) return { ok: false, error: "Which task? Give a task id or the number from /tasks." };

  if (/^\d+$/.test(raw)) {
    const index = Number(raw);
    if (index >= 1 && index <= tasks.length) return { ok: true, value: tasks[index - 1] };
  }

  const exact = dedupeById(tasks.filter((t) => t.id === raw || t.label.toLowerCase() === raw.toLowerCase()));
  if (exact.length === 1) return { ok: true, value: exact[0] };

  if (raw.length >= 4) {
    const byId = dedupeById(tasks.filter((t) => t.id.startsWith(raw)));
    if (byId.length === 1) return { ok: true, value: byId[0] };
    if (byId.length > 1) {
      return { ok: false, error: ambiguous("task", byId.map((t) => `${shortId(t.id)} ${t.label}`)) };
    }
  }

  return { ok: false, error: `No task matches ${raw}. Use /tasks to list them.` };
}

function ambiguous(kind: string, candidates: string[]): string {
  return `That ${kind} reference matches more than one:\n${candidates.map((c) => `• ${esc(c)}`).join("\n")}`;
}

/** Splits a raw argument string into `count` leading tokens plus the rest. */
export function splitLead(raw: string, count: number): { head: string[]; rest: string } {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  return { head: parts.slice(0, count), rest: parts.slice(count).join(" ") };
}

export function countTasksByBot(tasks: TaskSummary[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) counts.set(task.bot_id, (counts.get(task.bot_id) ?? 0) + 1);
  return counts;
}
