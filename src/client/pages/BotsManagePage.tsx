import { useState } from "react";
import { api } from "../lib/api";
import { usePolling } from "../lib/usePolling";
import { useToast } from "../components/Toast";
import { PageHero } from "../components/PageHero";
import { BotActivityModal } from "../components/BotActivityModal";
import { navigate } from "../lib/router";
import type { BotSummary, BulkBotImportResult, TaskSummary } from "../../shared/rpcTypes";

export function BotsManagePage() {
  const { data: bots, loading, refetch } = usePolling(() => api.get<BotSummary[]>("/api/bots"), 10000);
  const [confirming, setConfirming] = useState<{ bot: BotSummary; taskCount: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [inspectingBot, setInspectingBot] = useState<BotSummary | null>(null);

  // Bulk Bot Token Import state
  const [showBulkAdd, setShowBulkAdd] = useState(false);
  const [bulkTokensText, setBulkTokensText] = useState("");
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkBotImportResult | null>(null);

  const toast = useToast();

  async function handleBulkImportBots() {
    if (!bulkTokensText.trim()) return;
    setBulkImporting(true);
    setBulkResult(null);
    const res = await api.post<BulkBotImportResult>("/api/bots/bulk", { rawText: bulkTokensText });
    setBulkImporting(false);
    if (!res.ok) {
      toast.show("error", res.description);
      return;
    }
    setBulkResult(res.data);
    if (res.data.created > 0 || res.data.existing > 0) {
      toast.show(
        "success",
        `Verified ${res.data.created + res.data.existing} bot(s): ${res.data.created} added, ${res.data.existing} updated${
          res.data.failed > 0 ? `, ${res.data.failed} failed` : ""
        }`,
      );
      if (res.data.failed === 0) {
        setBulkTokensText("");
      }
      refetch();
    } else {
      toast.show("error", `All ${res.data.failed} token(s) failed verification.`);
    }
  }

  async function startDelete(bot: BotSummary) {
    const res = await api.get<TaskSummary[]>(`/api/bots/${bot.id}/tasks`);
    setConfirming({ bot, taskCount: res.ok ? res.data.length : 0 });
  }

  async function confirmDelete() {
    if (!confirming) return;
    const res = await api.del(`/api/bots/${confirming.bot.id}`);
    if (res.ok) {
      toast.show("success", `Deleted @${confirming.bot.bot_username} and its tasks`);
    } else {
      toast.show("error", res.description);
    }
    setConfirming(null);
    refetch();
  }

  function startRename(bot: BotSummary) {
    setRenaming(bot.id);
    setRenameValue(bot.label);
  }

  async function saveRename(botId: string) {
    if (!renameValue.trim()) return;
    const res = await api.patch(`/api/bots/${botId}`, { label: renameValue.trim() });
    if (res.ok) {
      toast.show("success", "Bot note updated");
      refetch();
    } else {
      toast.show("error", res.description);
    }
    setRenaming(null);
  }

  return (
    <div className="content-container">
      <PageHero
        title="Connected Bots"
        subtitle="Bulk-add multiple bot tokens at once, rename notes, or inspect bot workloads"
      >
        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn btn-primary"
            onClick={() => {
              setShowBulkAdd((s) => !s);
              setBulkResult(null);
            }}
          >
            {showBulkAdd ? "Close Bulk Add" : "+ Add / Bulk Import Bots"}
          </button>
          <button className="btn btn-secondary" onClick={() => navigate("wizard")}>
            New Task →
          </button>
        </div>
      </PageHero>

      {showBulkAdd && (
        <div className="card" style={{ borderColor: "var(--accent-border)" }}>
          <div className="card-header">
            <div className="card-title">
              <span>🤖 Add Single or Multiple Bot Tokens at Once</span>
            </div>
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none" }}
            >
              Get tokens from @BotFather ↗
            </a>
          </div>
          <div className="field">
            <label>Paste Bot Tokens (one per line, comma-separated, or Label | Token)</label>
            <textarea
              className="input"
              rows={5}
              style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12.5, resize: "vertical" }}
              value={bulkTokensText}
              onChange={(e) => setBulkTokensText(e.target.value)}
              placeholder={
                "123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ...\nBackup Bot 2 | 987654321:ZYXwvuTSRqpONMlkjIHGfedCBA...\n555666777:LMNopqRSTuvwXYZabcDEFghiJKL..."
              }
              autoFocus
            />
          </div>
          <p className="text-muted" style={{ fontSize: 12, marginBottom: 12 }}>
            Each token is verified against Telegram (`getMe`) in parallel and saved so you can immediately pick it during task creation.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn btn-primary"
              disabled={!bulkTokensText.trim() || bulkImporting}
              onClick={handleBulkImportBots}
            >
              {bulkImporting ? "Verifying & Saving Bots…" : "Verify & Save All Bots"}
            </button>
            {bulkTokensText && (
              <button
                className="btn btn-secondary"
                disabled={bulkImporting}
                onClick={() => {
                  setBulkTokensText("");
                  setBulkResult(null);
                }}
              >
                Clear
              </button>
            )}
          </div>

          {bulkResult && (
            <div
              style={{
                marginTop: 14,
                padding: "12px 14px",
                background: "var(--surface-raised)",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
                Import Summary: {bulkResult.created} added · {bulkResult.existing} already saved · {bulkResult.failed} failed
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
                {bulkResult.results.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      fontSize: 12,
                      padding: "6px 10px",
                      background: "var(--surface)",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--border-subtle)",
                    }}
                  >
                    <div>
                      <span className="text-mono" style={{ color: "var(--muted)", marginRight: 8 }}>
                        {r.token_preview}
                      </span>
                      {r.bot ? (
                        <strong>
                          @{r.bot.bot_username} <span className="text-muted">({r.bot.label})</span>
                        </strong>
                      ) : (
                        <span style={{ color: "var(--danger)" }}>{r.error}</span>
                      )}
                    </div>
                    <span
                      className={`badge ${
                        r.status === "created"
                          ? "badge-live"
                          : r.status === "existing"
                          ? "badge-warning"
                          : ""
                      }`}
                      style={{
                        fontSize: 10.5,
                        color: r.status === "failed" ? "var(--danger)" : undefined,
                      }}
                    >
                      {r.status === "created"
                        ? "✓ Saved"
                        : r.status === "existing"
                        ? "✓ Updated"
                        : "✗ Invalid"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="card">
        {loading && <div className="skeleton-row" />}
        {!loading && bots?.length === 0 && (
          <p className="text-muted" style={{ fontSize: 13, textAlign: "center", padding: "24px 0" }}>
            No bots configured yet — click "+ Add / Bulk Import Bots" above to add one or many bot tokens at once.
          </p>
        )}
        {bots?.map((bot) => (
          <div key={bot.id} className="task-item" style={{ cursor: "default" }}>
            <div className="task-name">
              {renaming === bot.id ? (
                <div className="row" style={{ flex: 1 }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    placeholder="Note (e.g. which chat this bot handles)"
                    autoFocus
                  />
                  <button className="btn btn-primary btn-sm" onClick={() => saveRename(bot.id)}>
                    Save
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setRenaming(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <span>
                    {bot.label} <span className="text-muted">@{bot.bot_username}</span>
                  </span>
                  <div className="row" style={{ gap: 6 }}>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => setInspectingBot(bot)}
                      title="Inspect what else this bot is doing"
                    >
                      🔍 Inspect
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => startRename(bot)}>
                      Rename
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => startDelete(bot)}>
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
            <div className="task-detail">
              <span>Bot ID: {bot.bot_id}</span>
              <span>·</span>
              <span>Added: {new Date(bot.created_at * 1000).toLocaleDateString()}</span>
            </div>
          </div>
        ))}
      </div>

      {confirming && (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <div className="card-header">
            <div className="card-title" style={{ color: "var(--danger)" }}>Confirm Delete</div>
          </div>
          <p style={{ marginBottom: 16 }}>
            Delete <strong>@{confirming.bot.bot_username}</strong>? This removes its webhook and permanently deletes{" "}
            <strong>{confirming.taskCount}</strong> task{confirming.taskCount === 1 ? "" : "s"} that use it. This cannot be
            undone.
          </p>
          <div className="row">
            <button className="btn btn-danger" onClick={confirmDelete}>
              Delete bot and {confirming.taskCount} task{confirming.taskCount === 1 ? "" : "s"}
            </button>
            <button className="btn btn-secondary" onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {inspectingBot && (
        <BotActivityModal
          botId={inspectingBot.id}
          botUsername={inspectingBot.bot_username}
          onClose={() => setInspectingBot(null)}
          onWebhookDisconnected={() => refetch()}
        />
      )}
    </div>
  );
}
