import { useState } from "react";
import { api } from "../lib/api";
import { usePolling } from "../lib/usePolling";
import { useToast } from "../components/Toast";
import { PageHero } from "../components/PageHero";
import { navigate } from "../lib/router";
import type {
  BotSummary,
  BulkChannelImportResult,
  SavedChannel,
} from "../../shared/rpcTypes";

export function ChannelsManagePage() {
  const { data: channels, loading, refetch } = usePolling(() => api.get<SavedChannel[]>("/api/channels"), 10000);
  const { data: bots } = usePolling(() => api.get<BotSummary[]>("/api/bots"), 15000);

  const [showBulkAdd, setShowBulkAdd] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [selectedBotId, setSelectedBotId] = useState("");
  const [savingBulk, setSavingBulk] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkChannelImportResult | null>(null);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameChatId, setRenameChatId] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState<SavedChannel | null>(null);

  const toast = useToast();

  async function handleBulkSave() {
    if (!bulkText.trim()) return;
    setSavingBulk(true);
    setBulkResult(null);
    const res = await api.post<BulkChannelImportResult>("/api/channels/bulk", {
      rawText: bulkText,
      botId: selectedBotId || undefined,
    });
    setSavingBulk(false);
    if (!res.ok) {
      toast.show("error", res.description);
      return;
    }
    setBulkResult(res.data);
    if (res.data.saved > 0) {
      toast.show(
        "success",
        `Saved ${res.data.saved} channel${res.data.saved === 1 ? "" : "s"} to your library`,
      );
      if (res.data.failed === 0) {
        setBulkText("");
      }
      refetch();
    } else {
      toast.show("error", "Could not save channels");
    }
  }

  function startEdit(ch: SavedChannel) {
    setRenamingId(ch.id);
    setRenameTitle(ch.title);
    setRenameChatId(ch.chat_id);
  }

  async function saveEdit(id: string) {
    if (!renameTitle.trim() && !renameChatId.trim()) return;
    const res = await api.patch<SavedChannel>(`/api/channels/${id}`, {
      title: renameTitle.trim(),
      chatId: renameChatId.trim(),
    });
    if (res.ok) {
      toast.show("success", "Channel updated");
      refetch();
    } else {
      toast.show("error", res.description);
    }
    setRenamingId(null);
  }

  async function confirmDelete() {
    if (!confirmingDelete) return;
    const res = await api.del(`/api/channels/${confirmingDelete.id}`);
    if (res.ok) {
      toast.show("success", `Removed "${confirmingDelete.title}" from saved channels`);
      refetch();
    } else {
      toast.show("error", res.description);
    }
    setConfirmingDelete(null);
  }

  return (
    <div className="content-container">
      <PageHero
        title="Saved Channels"
        subtitle="Save source and target channels once and pick them like bots during task creation"
      >
        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn btn-primary"
            onClick={() => {
              setShowBulkAdd((s) => !s);
              setBulkResult(null);
            }}
          >
            {showBulkAdd ? "Close Add Channels" : "+ Add / Bulk Save Channels"}
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
              <span>📢 Add Single or Multiple Channels / Groups at Once</span>
            </div>
          </div>

          <div className="field">
            <label>Paste Channel IDs, @usernames, or Label | Chat ID (one per line or comma-separated)</label>
            <textarea
              className="input"
              rows={5}
              style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12.5, resize: "vertical" }}
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={
                "-1001234567890 | Main Source Channel\n-1009876543210 | Backup Mirror 1\n-1001122334455 | Backup Mirror 2\n@my_public_channel"
              }
              autoFocus
            />
          </div>

          {bots && bots.length > 0 && (
            <div className="field">
              <label>Optional: Verify Titles via Connected Bot</label>
              <select
                className="input"
                value={selectedBotId}
                onChange={(e) => setSelectedBotId(e.target.value)}
              >
                <option value="">Auto-detect using any connected bot (or save without bot check)</option>
                {bots.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label} (@{b.bot_username})
                  </option>
                ))}
              </select>
            </div>
          )}

          <p className="text-muted" style={{ fontSize: 12, marginBottom: 12 }}>
            If a connected bot is already a member of the channel, its official title is fetched automatically. Otherwise, your custom label or Chat ID is saved immediately so you can select it in the Task Wizard.
          </p>

          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn btn-primary"
              disabled={!bulkText.trim() || savingBulk}
              onClick={handleBulkSave}
            >
              {savingBulk ? "Saving Channels…" : "Save All Channels"}
            </button>
            {bulkText && (
              <button
                className="btn btn-secondary"
                disabled={savingBulk}
                onClick={() => {
                  setBulkText("");
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
                Saved {bulkResult.saved} of {bulkResult.total} channel(s)
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
                {bulkResult.results.map((r, idx) => (
                  <div
                    key={idx}
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
                      {r.channel ? (
                        <>
                          <strong>{r.channel.title}</strong>{" "}
                          <span className="text-mono text-muted" style={{ marginLeft: 6 }}>
                            {r.channel.chat_id}
                          </span>
                        </>
                      ) : (
                        <span style={{ color: "var(--danger)" }}>
                          {r.input}: {r.error}
                        </span>
                      )}
                    </div>
                    <span className="badge badge-live" style={{ fontSize: 10.5 }}>
                      {r.verified_with_telegram ? "✓ Verified & Saved" : "✓ Saved"}
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
        {!loading && channels?.length === 0 && (
          <p className="text-muted" style={{ fontSize: 13, textAlign: "center", padding: "24px 0" }}>
            No saved channels yet — click "+ Add / Bulk Save Channels" above or check any channel in the Task Wizard to save it automatically.
          </p>
        )}
        {channels?.map((ch) => (
          <div key={ch.id} className="task-item" style={{ cursor: "default" }}>
            <div className="task-name">
              {renamingId === ch.id ? (
                <div className="row" style={{ flex: 1, flexWrap: "wrap", gap: 8 }}>
                  <input
                    className="input"
                    style={{ flex: 1, minWidth: 180 }}
                    value={renameTitle}
                    onChange={(e) => setRenameTitle(e.target.value)}
                    placeholder="Channel label / title"
                    autoFocus
                  />
                  <input
                    className="input"
                    style={{ maxWidth: 200 }}
                    value={renameChatId}
                    onChange={(e) => setRenameChatId(e.target.value)}
                    placeholder="Chat ID or @username"
                  />
                  <button className="btn btn-primary btn-sm" onClick={() => saveEdit(ch.id)}>
                    Save
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setRenamingId(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <span>
                    📢 {ch.title}{" "}
                    <span className="text-mono text-muted" style={{ fontSize: 12, marginLeft: 6 }}>
                      {ch.chat_id}
                    </span>
                    {ch.username && (
                      <span className="text-muted" style={{ fontSize: 12, marginLeft: 6 }}>
                        (@{ch.username})
                      </span>
                    )}
                  </span>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => startEdit(ch)}>
                      Edit
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => setConfirmingDelete(ch)}>
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
            <div className="task-detail">
              <span>Type: {ch.chat_type ?? "channel"}</span>
              <span>·</span>
              <span>Added: {new Date(ch.created_at * 1000).toLocaleDateString()}</span>
            </div>
          </div>
        ))}
      </div>

      {confirmingDelete && (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <div className="card-header">
            <div className="card-title" style={{ color: "var(--danger)" }}>Confirm Delete Channel</div>
          </div>
          <p style={{ marginBottom: 16 }}>
            Remove <strong>{confirmingDelete.title}</strong> ({confirmingDelete.chat_id}) from your saved channels list? Running tasks using this channel will not be affected.
          </p>
          <div className="row">
            <button className="btn btn-danger" onClick={confirmDelete}>
              Remove from Saved Channels
            </button>
            <button className="btn btn-secondary" onClick={() => setConfirmingDelete(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
