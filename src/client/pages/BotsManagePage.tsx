import { useState } from "react";
import { api } from "../lib/api";
import { usePolling } from "../lib/usePolling";
import { useToast } from "../components/Toast";
import { PageHero } from "../components/PageHero";
import { BotActivityModal } from "../components/BotActivityModal";
import { navigate } from "../lib/router";
import type {
  BotSummary,
  BulkBotsResult,
  BulkChannelsResult,
  SavedChannel,
  TaskSummary,
} from "../../shared/rpcTypes";

export function BotsManagePage() {
  const { data: bots, loading, refetch } = usePolling(() => api.get<BotSummary[]>("/api/bots"), 10000);
  const {
    data: channels,
    loading: loadingChannels,
    refetch: refetchChannels,
  } = usePolling(() => api.get<SavedChannel[]>("/api/channels"), 10000);

  const [confirming, setConfirming] = useState<{ bot: BotSummary; taskCount: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [inspectingBot, setInspectingBot] = useState<BotSummary | null>(null);

  // Multi-bot input
  const [bulkBotTokens, setBulkBotTokens] = useState("");
  const [addingBots, setAddingBots] = useState(false);

  // Source & Target channel inputs & rename state
  const [bulkSourceInput, setBulkSourceInput] = useState("");
  const [addingSources, setAddingSources] = useState(false);
  const [bulkTargetInput, setBulkTargetInput] = useState("");
  const [addingTargets, setAddingTargets] = useState(false);
  const [renamingChannelId, setRenamingChannelId] = useState<string | null>(null);
  const [renameChannelValue, setRenameChannelValue] = useState("");

  const toast = useToast();

  const sourceChannels = (channels ?? []).filter((c) => c.role === "source");
  const targetChannels = (channels ?? []).filter((c) => c.role === "target");

  async function handleBulkSaveBots() {
    if (!bulkBotTokens.trim()) return;
    setAddingBots(true);
    const res = await api.post<BulkBotsResult>("/api/bots/bulk", { rawInput: bulkBotTokens.trim() });
    setAddingBots(false);
    if (res.ok) {
      const { added, errors } = res.data;
      toast.show(
        errors.length > 0 ? "warning" : "success",
        `Saved ${added.length} bot${added.length === 1 ? "" : "s"}${
          errors.length > 0 ? ` (${errors.length} failed: ${errors.map((e) => e.tokenPreview).join(", ")})` : ""
        }`,
      );
      setBulkBotTokens("");
      refetch();
    } else {
      toast.show("error", res.description);
    }
  }

  async function handleBulkSaveChannels(role: "source" | "target") {
    const rawInput = role === "source" ? bulkSourceInput.trim() : bulkTargetInput.trim();
    if (!rawInput) return;
    if (role === "source") setAddingSources(true);
    else setAddingTargets(true);

    const res = await api.post<BulkChannelsResult>("/api/channels/bulk", { role, rawInput });

    if (role === "source") setAddingSources(false);
    else setAddingTargets(false);

    if (res.ok) {
      const count = res.data.saved.length;
      toast.show(
        "success",
        `Saved ${count} ${role === "source" ? "source" : "target"} channel${count === 1 ? "" : "s"}`,
      );
      if (role === "source") setBulkSourceInput("");
      else setBulkTargetInput("");
      refetchChannels();
    } else {
      toast.show("error", res.description);
    }
  }

  function startRenameChannel(ch: SavedChannel) {
    setRenamingChannelId(ch.id);
    setRenameChannelValue(ch.label);
  }

  async function saveRenameChannel(id: string) {
    if (!renameChannelValue.trim()) return;
    const res = await api.patch(`/api/channels/${id}`, { label: renameChannelValue.trim() });
    if (res.ok) {
      toast.show("success", "Channel label updated");
      refetchChannels();
    } else {
      toast.show("error", res.description);
    }
    setRenamingChannelId(null);
  }

  async function deleteChannel(ch: SavedChannel) {
    const res = await api.del(`/api/channels/${ch.id}`);
    if (res.ok) {
      toast.show("success", `Removed ${ch.label}`);
      refetchChannels();
    } else {
      toast.show("error", res.description);
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
        title="Connected Bots & Saved Channels"
        subtitle="Add multiple bot tokens at once, save Source and Target channels, and manage them"
      >
        <button className="btn btn-primary" onClick={() => navigate("wizard")}>
          + New Task
        </button>
      </PageHero>

      {/* 1. Multi-Bot Tokens & Connected Bots */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">🤖 Connected Bots ({bots?.length ?? 0})</div>
        </div>

        <div className="field" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <label style={{ margin: 0, fontWeight: 600 }}>Add Multiple Bot Tokens at Once</label>
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 11.5, color: "var(--accent)", textDecoration: "none" }}
            >
              Get tokens from @BotFather ↗
            </a>
          </div>
          <textarea
            className="input"
            rows={3}
            style={{ fontFamily: "var(--font-mono, monospace)", resize: "vertical" }}
            value={bulkBotTokens}
            onChange={(e) => setBulkBotTokens(e.target.value)}
            placeholder={"Paste one or multiple bot tokens (one per line or comma-separated)…\n123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ…\n987654321:XYZabcDefGhIJKlmNoPQRsTUV… | Optional Note"}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, gap: 12, flexWrap: "wrap" }}>
            <span className="text-muted" style={{ fontSize: 12 }}>
              All tokens are verified with Telegram and saved for instant selection.
            </span>
            <button
              className="btn btn-primary btn-sm"
              disabled={!bulkBotTokens.trim() || addingBots}
              onClick={handleBulkSaveBots}
            >
              {addingBots ? "Verifying & Saving…" : "+ Verify & Save Bot(s)"}
            </button>
          </div>
        </div>

        {loading && <div className="skeleton-row" />}
        {!loading && bots?.length === 0 && (
          <p className="text-muted" style={{ fontSize: 13, textAlign: "center", padding: "18px 0" }}>
            No bots configured yet — paste one or more bot tokens above to save them.
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

      {/* 2. Saved Source Channels */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">📥 Saved Source Channels ({sourceChannels.length})</div>
        </div>

        <div className="field" style={{ marginBottom: 14 }}>
          <label style={{ fontWeight: 600 }}>Add Source Channels (Single or Multiple at Once)</label>
          <textarea
            className="input"
            rows={2}
            style={{ fontFamily: "var(--font-mono, monospace)", resize: "vertical" }}
            value={bulkSourceInput}
            onChange={(e) => setBulkSourceInput(e.target.value)}
            placeholder={"Paste Source Chat IDs or @usernames (one per line or comma-separated)…\n-1001234567890 | Main Source Channel\n@my_source_channel"}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, gap: 12, flexWrap: "wrap" }}>
            <span className="text-muted" style={{ fontSize: 12 }}>
              Shown only during Source Channel selection in the task wizard.
            </span>
            <button
              className="btn btn-primary btn-sm"
              disabled={!bulkSourceInput.trim() || addingSources}
              onClick={() => handleBulkSaveChannels("source")}
            >
              {addingSources ? "Saving…" : "+ Save Source Channel(s)"}
            </button>
          </div>
        </div>

        {loadingChannels && <div className="skeleton-row" />}
        {!loadingChannels && sourceChannels.length === 0 && (
          <p className="text-muted" style={{ fontSize: 13, textAlign: "center", padding: "16px 0" }}>
            No source channels saved yet.
          </p>
        )}
        {sourceChannels.map((ch) => (
          <div key={ch.id} className="task-item" style={{ cursor: "default" }}>
            <div className="task-name">
              {renamingChannelId === ch.id ? (
                <div className="row" style={{ flex: 1 }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    value={renameChannelValue}
                    onChange={(e) => setRenameChannelValue(e.target.value)}
                    placeholder="Channel label"
                    autoFocus
                  />
                  <button className="btn btn-primary btn-sm" onClick={() => saveRenameChannel(ch.id)}>
                    Save
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setRenamingChannelId(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <span>
                    {ch.label} <span className="text-muted">({ch.chat_id})</span>
                  </span>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => startRenameChannel(ch)}>
                      Rename
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => deleteChannel(ch)}>
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
            <div className="task-detail">
              <span>Chat ID: {ch.chat_id}</span>
              {ch.username && (
                <>
                  <span>·</span>
                  <span>@{ch.username}</span>
                </>
              )}
              <span>·</span>
              <span>Saved: {new Date(ch.created_at * 1000).toLocaleDateString()}</span>
            </div>
          </div>
        ))}
      </div>

      {/* 3. Saved Target Channels */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">📤 Saved Target Channels ({targetChannels.length})</div>
        </div>

        <div className="field" style={{ marginBottom: 14 }}>
          <label style={{ fontWeight: 600 }}>Add Target Channels (Single or Multiple at Once)</label>
          <textarea
            className="input"
            rows={2}
            style={{ fontFamily: "var(--font-mono, monospace)", resize: "vertical" }}
            value={bulkTargetInput}
            onChange={(e) => setBulkTargetInput(e.target.value)}
            placeholder={"Paste Target Chat IDs or @usernames (one per line or comma-separated)…\n-1009876543210 | Backup Archive Channel\n@my_target_channel"}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, gap: 12, flexWrap: "wrap" }}>
            <span className="text-muted" style={{ fontSize: 12 }}>
              Shown only during Target Channel selection in the task wizard.
            </span>
            <button
              className="btn btn-primary btn-sm"
              disabled={!bulkTargetInput.trim() || addingTargets}
              onClick={() => handleBulkSaveChannels("target")}
            >
              {addingTargets ? "Saving…" : "+ Save Target Channel(s)"}
            </button>
          </div>
        </div>

        {loadingChannels && <div className="skeleton-row" />}
        {!loadingChannels && targetChannels.length === 0 && (
          <p className="text-muted" style={{ fontSize: 13, textAlign: "center", padding: "16px 0" }}>
            No target channels saved yet.
          </p>
        )}
        {targetChannels.map((ch) => (
          <div key={ch.id} className="task-item" style={{ cursor: "default" }}>
            <div className="task-name">
              {renamingChannelId === ch.id ? (
                <div className="row" style={{ flex: 1 }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    value={renameChannelValue}
                    onChange={(e) => setRenameChannelValue(e.target.value)}
                    placeholder="Channel label"
                    autoFocus
                  />
                  <button className="btn btn-primary btn-sm" onClick={() => saveRenameChannel(ch.id)}>
                    Save
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setRenamingChannelId(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <span>
                    {ch.label} <span className="text-muted">({ch.chat_id})</span>
                  </span>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => startRenameChannel(ch)}>
                      Rename
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => deleteChannel(ch)}>
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
            <div className="task-detail">
              <span>Chat ID: {ch.chat_id}</span>
              {ch.username && (
                <>
                  <span>·</span>
                  <span>@{ch.username}</span>
                </>
              )}
              <span>·</span>
              <span>Saved: {new Date(ch.created_at * 1000).toLocaleDateString()}</span>
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
