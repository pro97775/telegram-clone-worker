import { TelegramClient } from "../telegram/client";
import { toResult } from "../telegram/errors";
import { handleControllerUpdate } from "./controller";
import {
  getControllerMode,
  getControllerOffset,
  getControllerToken,
  purgeStaleSessions,
  setControllerOffset,
} from "./store";

const MAX_UPDATES_PER_TICK = 50;

/** Cron fallback when no webhook is registered: drains pending controller
 * commands once a minute. A 409 means a webhook owns the bot; the command is
 * then skipped so the webhook keeps working. */
export async function runControllerPoll(env: Env): Promise<void> {
  const token = getControllerToken(env);
  if (!token) return;
  if ((await getControllerMode(env)) === "webhook") return;

  const client = new TelegramClient(token);
  const offset = await getControllerOffset(env);
  const result = await toResult(() =>
    client.getUpdates({
      offset: offset > 0 ? offset : undefined,
      limit: MAX_UPDATES_PER_TICK,
      allowed_updates: ["message", "callback_query"],
      timeout: 0,
    }),
  );
  if (!result.ok) return;

  for (const update of result.data) {
    try {
      await handleControllerUpdate(env, update);
    } catch (e) {
      console.error("controller poll update failed", update.update_id, e);
    }
    // Acknowledge per update: a slow command that outlives the tick must not
    // be replayed (and re-executed) on the next cron run.
    if (update.update_id >= offset) {
      await setControllerOffset(env, update.update_id + 1);
    }
  }

  await purgeStaleSessions(env);
}
