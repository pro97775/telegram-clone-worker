interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_PASSWORD?: string;
  AUTH_SECRET?: string;
  /** Token of the bot that runs the controller commands. */
  BOT_CONTROLLER_TOKEN?: string;
  /** Comma/space separated numeric Telegram user ids allowed to control it. */
  BOT_CONTROLLER_ADMIN_IDS?: string;
  /** Optional one-time claim code, used only while no admin exists yet. */
  BOT_CONTROLLER_CLAIM_CODE?: string;
  /** Optional fixed webhook secret; generated and stored in D1 when omitted. */
  BOT_CONTROLLER_WEBHOOK_SECRET?: string;
}
