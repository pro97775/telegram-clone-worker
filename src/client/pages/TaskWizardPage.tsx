import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { usePolling } from "../lib/usePolling";
import { useToast } from "../components/Toast";
import { PageHero } from "../components/PageHero";
import { CapabilityChecklist } from "../components/CapabilityChecklist";
import { PermissionErrorBanner } from "../components/PermissionErrorBanner";
import { BotActivityModal } from "../components/BotActivityModal";
import { navigate } from "../lib/router";
import { getTaskDisplayInfo } from "../lib/useTasksContext";
import { runWithConcurrency } from "../../shared/concurrencyPool";
import type {
  BotSummary,
  BulkBotsResult,
  BulkChannelsResult,
  ChatLookupResult,
  ErrorReason,
  SavedChannel,
  SavedTaskWithToken,
  TaskScope,
  TaskSummary,
} from "../../shared/rpcTypes";

type BackfillMode = "range" | "lastN";

function parseDestinationIds(value: string): string[] {
  return [...new Set(value.split(/[\s,;]+/).map((id) => id.trim()).filter(Boolean))];
}

export function TaskWizardPage({ fromSavedId }: { fromSavedId?: string }) {
  const toast = useToast();
  const { data: bots, refetch: refetchBots } = usePolling(() => api.get<BotSummary[]>("/api/bots"), 15000);
  const { data: savedChannels, refetch: refetchChannels } = usePolling(
    () => api.get<SavedChannel[]>("/api/channels"),
    15000,
  );

  const sourceChannels = (savedChannels ?? []).filter((c) => c.role === "source");
  const targetChannels = (savedChannels ?? []).filter((c) => c.role === "target");

  // Step 1: bot
  const [selectedBotId, setSelectedBotId] = useState<string>("");
  const [newToken, setNewToken] = useState("");
  const [botError, setBotError] = useState<string | null>(null);
  const [savingBot, setSavingBot] = useState(false);
  const [pendingBot, setPendingBot] = useState<{ token: string; bot_id: number; bot_username: string } | null>(null);
  const [botActiveTasks, setBotActiveTasks] = useState<TaskSummary[] | null>(null);
  const [loadingBotTasks, setLoadingBotTasks] = useState(false);
  const [showActivityModal, setShowActivityModal] = useState(false);

  function handleClearBot() {
    setSelectedBotId("");
    setPendingBot(null);
    setBotActiveTasks(null);
    setNewToken("");
    setBotError(null);
    setDestLookups([]);
    setDestError(null);
    setDestLookupErrors([]);
  }

  // Step 2: source chat
  const [sourceChatId, setSourceChatId] = useState("");
  const [savingSourceChannels, setSavingSourceChannels] = useState(false);
  const [sourceLookup, setSourceLookup] = useState<ChatLookupResult | null>(null);
  const [sourceError, setSourceError] = useState<{ reason: ErrorReason; description: string } | null>(null);
  const [lookingUpSource, setLookingUpSource] = useState(false);
  const [showAdminTools, setShowAdminTools] = useState(false);
  const [userIdInput, setUserIdInput] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [revokeInviteLinkInput, setRevokeInviteLinkInput] = useState("");

  // Step 3: destination + config
  const [destChatId, setDestChatId] = useState("");
  const [savingTargetChannels, setSavingTargetChannels] = useState(false);
  const [destLookups, setDestLookups] = useState<ChatLookupResult[]>([]);
  const [destError, setDestError] = useState<{ reason: ErrorReason; description: string } | null>(null);
  const [destLookupErrors, setDestLookupErrors] = useState<string[]>([]);
  const [lookingUpDest, setLookingUpDest] = useState(false);
  const [scope, setScope] = useState<TaskScope>("live");
  const [backfillMode, setBackfillMode] = useState<BackfillMode>("lastN");
  const [startId, setStartId] = useState("");
  const [endId, setEndId] = useState("");
  const [n, setN] = useState("100");
  const [duplicate, setDuplicate] = useState<TaskSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [lastSaveTemplate, setLastSaveTemplate] = useState(false);
  const [testMessageId, setTestMessageId] = useState("");
  const [testCopyResult, setTestCopyResult] = useState<string | null>(null);
  const [testingCopy, setTestingCopy] = useState(false);
  const [enableFilters, setEnableFilters] = useState(false);
  const [filterMediaTypes, setFilterMediaTypes] = useState<string[]>(["document", "video"]);
  const [minFileSizeMb, setMinFileSizeMb] = useState("");
  const [maxFileSizeMb, setMaxFileSizeMb] = useState("");

  const selectedBot = bots?.find((b) => b.id === selectedBotId);
  const hasBot = !!selectedBotId || !!pendingBot;
  const wantsBackfill = scope === "live_and_backfill" || scope === "backfill_only";
  const destinationIds = parseDestinationIds(destChatId);
  const destinationChecksComplete =
    destinationIds.length > 0 &&
    destinationIds.length <= 25 &&
    destLookups.length === destinationIds.length &&
    destLookupErrors.length === 0;
  const runningBackfillTasks = (botActiveTasks ?? []).filter((t) => t.backfill_status === "running");
  const hasRunningBackfill = runningBackfillTasks.length > 0;

  function botQuery(): string {
    if (pendingBot) return `token=${encodeURIComponent(pendingBot.token)}&botTelegramId=${pendingBot.bot_id}`;
    return `botId=${selectedBotId}`;
  }

  async function handleSelectBot(botId: string) {
    setSelectedBotId(botId);
    setPendingBot(null);
    setBotActiveTasks(null);
    setNewToken("");
    setBotError(null);
    setDestLookups([]);
    setDestError(null);
    setDestLookupErrors([]);
    if (!botId) return;
    setLoadingBotTasks(true);
    const res = await api.get<TaskSummary[]>(`/api/bots/${botId}/tasks`);
    setLoadingBotTasks(false);
    if (res.ok) {
      const active = res.data.filter(
        (t) => t.live_enabled || t.backfill_status === "running" || t.backfill_status === "paused",
      );
      setBotActiveTasks(active);
    } else {
      setBotActiveTasks([]);
    }
  }

  useEffect(() => {
    if (!fromSavedId) return;
    (async () => {
      const res = await api.get<SavedTaskWithToken>(`/api/saved-tasks/${fromSavedId}`);
      if (!res.ok) {
        toast.show("error", res.description);
        return;
      }
      const s = res.data;
      setNewToken(s.bot_token);
      setSourceChatId(s.source_chat_id);
      setDestChatId(s.dest_chat_id);
      setScope(s.scope);
      if (s.backfill_mode) setBackfillMode(s.backfill_mode);
      if (s.backfill_mode === "range") {
        setStartId(s.start_id != null ? String(s.start_id) : "");
        setEndId(s.end_id != null ? String(s.end_id) : "");
      } else if (s.backfill_mode === "lastN" && s.n != null) {
        setN(String(s.n));
      }
      if (s.filter_media_types) {
        setEnableFilters(true);
        setFilterMediaTypes(s.filter_media_types.split(",").map((m) => m.trim()).filter(Boolean));
      }
      if (s.filter_min_size_bytes != null) {
        setEnableFilters(true);
        setMinFileSizeMb(String(Math.round(s.filter_min_size_bytes / (1024 * 1024))));
      }
      if (s.filter_max_size_bytes != null) {
        setEnableFilters(true);
        setMaxFileSizeMb(String(Math.round(s.filter_max_size_bytes / (1024 * 1024))));
      }
      toast.show("success", "Prefilled from saved template — review each step and continue manually.");
    })();
  }, [fromSavedId]);

  async function verifyNewBot() {
    if (!newToken.trim()) return;
    setBotError(null);
    setSavingBot(true);
    const res = await api.post<BulkBotsResult>("/api/bots/bulk", { rawInput: newToken.trim() });
    setSavingBot(false);
    if (!res.ok) {
      setBotError(res.description);
      return;
    }
    const { added, errors } = res.data;
    await refetchBots();
    setNewToken("");

    if (errors.length > 0) {
      setBotError(`Some tokens failed: ${errors.map((e) => `${e.tokenPreview} (${e.error})`).join(", ")}`);
    }

    if (added.length === 1) {
      toast.show("success", `Verified & saved @${added[0].bot_username}`);
      await handleSelectBot(added[0].id);
    } else if (added.length > 1) {
      toast.show(
        "success",
        `Verified & saved ${added.length} bots (${added.map((b) => `@${b.bot_username}`).join(", ")})`,
      );
      await handleSelectBot(added[0].id);
    }
  }

  async function lookupSource(overrideChatId?: string) {
    const targetId = (overrideChatId ?? sourceChatId).trim();
    if (!hasBot || !targetId) return;
    setLookingUpSource(true);
    setSourceError(null);
    setSourceLookup(null);
    const res = await api.get<ChatLookupResult>(`/api/chats/${encodeURIComponent(targetId)}?${botQuery()}`);
    setLookingUpSource(false);
    if (res.ok) {
      setSourceLookup(res.data);
      refetchChannels();
    } else {
      setSourceError({ reason: res.reason, description: res.description });
    }
  }

  async function lookupDest(overrideChatId?: string) {
    const targetIds = parseDestinationIds(overrideChatId ?? destChatId);
    if (!hasBot || targetIds.length === 0) return;
    if (targetIds.length > 25) {
      const description = "Check and create up to 25 destination chats at a time.";
      setLookingUpDest(false);
      setDestLookups([]);
      setDestLookupErrors([description]);
      setDestError({ reason: "invalid_request", description });
      return;
    }
    setLookingUpDest(true);
    setDestError(null);
    setDestLookups([]);
    setDestLookupErrors([]);
    const results = await runWithConcurrency(
      targetIds,
      3,
      (targetId) => api.get<ChatLookupResult>(`/api/chats/${encodeURIComponent(targetId)}?${botQuery()}`),
    );
    setLookingUpDest(false);
    const lookups = results.flatMap((res) => (res.ok ? [res.data] : []));
    const errors = results.flatMap((res, index) =>
      res.ok ? [] : [{ reason: res.reason, description: `${targetIds[index]}: ${res.description}` }],
    );
    setDestLookups(lookups);
    setDestLookupErrors(errors.map((error) => error.description));
    setDestError(errors[0] ?? null);
    if (lookups.length > 0) {
      refetchChannels();
    }
  }

  async function handleSaveSourceChannels() {
    if (!sourceChatId.trim()) return;
    setSavingSourceChannels(true);
    const res = await api.post<BulkChannelsResult>("/api/channels/bulk", {
      role: "source",
      rawInput: sourceChatId.trim(),
      botId: selectedBotId || undefined,
      botToken: pendingBot?.token,
    });
    setSavingSourceChannels(false);
    if (!res.ok) {
      toast.show("error", res.description);
      return;
    }
    const saved = res.data.saved;
    await refetchChannels();
    toast.show("success", `Saved ${saved.length} source channel${saved.length === 1 ? "" : "s"}`);
    if (saved.length === 1) {
      setSourceChatId(saved[0].chat_id);
      if (hasBot) await lookupSource(saved[0].chat_id);
    } else if (saved.length > 1) {
      setSourceChatId(saved[0].chat_id);
      if (hasBot) await lookupSource(saved[0].chat_id);
    }
  }

  async function handleSaveTargetChannels() {
    if (!destChatId.trim()) return;
    setSavingTargetChannels(true);
    const res = await api.post<BulkChannelsResult>("/api/channels/bulk", {
      role: "target",
      rawInput: destChatId.trim(),
      botId: selectedBotId || undefined,
      botToken: pendingBot?.token,
    });
    setSavingTargetChannels(false);
    if (!res.ok) {
      toast.show("error", res.description);
      return;
    }
    const saved = res.data.saved;
    await refetchChannels();
    toast.show("success", `Saved ${saved.length} target channel${saved.length === 1 ? "" : "s"}`);
    if (saved.length > 0) {
      const savedIds = saved.map((channel) => channel.chat_id);
      setDestChatId(savedIds.join(", "));
      if (hasBot) await lookupDest(savedIds.join(", "));
    }
  }

  async function handleSelectSourceChannel(chatId: string) {
    setSourceChatId(chatId);
    if (!chatId) {
      setSourceLookup(null);
      setSourceError(null);
      return;
    }
    if (hasBot) {
      await lookupSource(chatId);
    }
  }

  async function handleSelectTargetChannels(chatIds: string[]) {
    const joinedIds = chatIds.join(", ");
    setDestChatId(joinedIds);
    if (!joinedIds) {
      setDestLookups([]);
      setDestError(null);
      setDestLookupErrors([]);
      return;
    }
    if (hasBot) {
      await lookupDest(joinedIds);
    }
  }

  async function generateInviteLink() {
    const res = await api.post<{ invite_link: string }>(`/api/chats/${encodeURIComponent(sourceChatId)}/invite-link?${botQuery()}`);
    if (res.ok) setInviteLink(res.data.invite_link);
    else toast.show("error", res.description);
  }

  async function revokeInviteLink() {
    if (!revokeInviteLinkInput) return;
    const res = await api.post(`/api/chats/${encodeURIComponent(sourceChatId)}/revoke-invite-link?${botQuery()}`, {
      inviteLink: revokeInviteLinkInput,
    });
    if (res.ok) {
      toast.show("success", "Invite link revoked");
      setRevokeInviteLinkInput("");
    } else toast.show("error", res.description);
  }

  async function banUser() {
    const uid = Number(userIdInput);
    if (!uid) return;
    const res = await api.post(`/api/chats/${encodeURIComponent(sourceChatId)}/ban?${botQuery()}`, { userId: uid });
    toast.show(res.ok ? "success" : "error", res.ok ? "User banned" : res.description);
  }

  async function unbanUser() {
    const uid = Number(userIdInput);
    if (!uid) return;
    const res = await api.post(`/api/chats/${encodeURIComponent(sourceChatId)}/unban?${botQuery()}`, { userId: uid });
    toast.show(res.ok ? "success" : "error", res.ok ? "User unbanned" : res.description);
  }

  async function promoteUser() {
    const uid = Number(userIdInput);
    if (!uid) return;
    const res = await api.post(`/api/chats/${encodeURIComponent(sourceChatId)}/promote?${botQuery()}`, {
      userId: uid,
      rights: { can_delete_messages: true, can_invite_users: true, can_restrict_members: true },
    });
    toast.show(res.ok ? "success" : "error", res.ok ? "User promoted" : res.description);
  }

  async function sendTestMessage() {
    const res = await api.post(`/api/chats/${encodeURIComponent(sourceChatId)}/send-test-message?${botQuery()}`, {
      text: "Test message from Telegram Clone Worker",
    });
    toast.show(res.ok ? "success" : "error", res.ok ? "Test message sent" : res.description);
  }

  async function checkLatestId() {
    const res = await api.get<{ latestMessageId: number; cleanupOk: boolean }>(
      `/api/chats/${encodeURIComponent(sourceChatId)}/latest-message-id?${botQuery()}`,
    );
    if (res.ok) toast.show("success", `Latest message id: ${res.data.latestMessageId}`);
    else toast.show("error", res.description);
  }

  async function runTestCopy() {
    const targetId = String(destLookups[0]?.chat.id ?? destinationIds[0] ?? "");
    if (!targetId) return;
    setTestingCopy(true);
    setTestCopyResult(null);
    const res = await api.post<{ message_id: number }>(`/api/chats/${encodeURIComponent(sourceChatId)}/test-copy?${botQuery()}`, {
      destChatId: targetId,
      messageId: testMessageId ? Number(testMessageId) : undefined,
    });
    setTestingCopy(false);
    setTestCopyResult(res.ok ? `Sent as message ${res.data.message_id} in destination` : `Failed: ${res.description}`);
  }

  async function createTask(allowDuplicate = false, saveTemplate = false) {
    if (!sourceLookup || !destinationChecksComplete) return;
    setLastSaveTemplate(saveTemplate);
    setCreating(true);
    setDuplicate(null);
    const wantsLive = scope === "live" || scope === "live_and_backfill";
    const minBytes = wantsLive && enableFilters && minFileSizeMb ? Math.round(Number(minFileSizeMb) * 1024 * 1024) : undefined;
    const maxBytes = wantsLive && enableFilters && maxFileSizeMb ? Math.round(Number(maxFileSizeMb) * 1024 * 1024) : undefined;
    const mediaTypesStr = wantsLive && enableFilters && filterMediaTypes.length > 0 ? filterMediaTypes.join(",") : undefined;

    const destinations = destLookups.map((lookup) => ({
      chatId: String(lookup.chat.id),
      title: lookup.chat.title,
      type: lookup.chat.type,
    }));
    const body = {
      botToken: pendingBot?.token,
      sourceChatId: String(sourceLookup.chat.id),
      sourceChatTitle: sourceLookup.chat.title,
      destChatId: destinations[0].chatId,
      destChatTitle: destinations[0].title,
      destChatType: destinations[0].type,
      destinations,
      scope,
      backfillMode: wantsBackfill ? backfillMode : undefined,
      startId: wantsBackfill && backfillMode === "range" ? Number(startId) : undefined,
      endId: wantsBackfill && backfillMode === "range" ? Number(endId) : undefined,
      n: wantsBackfill && backfillMode === "lastN" ? Number(n) : undefined,
      allowDuplicate,
      saveTemplate,
      filterMediaTypes: mediaTypesStr,
      filterMinSizeBytes: minBytes,
      filterMaxSizeBytes: maxBytes,
    };
    const botPathId = pendingBot ? "new" : selectedBotId;
    const res = await api.post<TaskSummary[]>(`/api/bots/${botPathId}/tasks`, body);
    setCreating(false);
    if (res.ok) {
      toast.show("success", `${res.data.length} destination task${res.data.length === 1 ? "" : "s"} created`);
      navigate(`task/${res.data[0].id}`);
      return;
    }
    const duplicateTaskId = (res as { duplicateTaskId?: string }).duplicateTaskId;
    if (duplicateTaskId) {
      const dup = await api.get<TaskSummary[]>(`/api/bots/${selectedBotId}/tasks`);
      if (dup.ok) {
        const found = dup.data.find((t) => t.id === duplicateTaskId);
        if (found) setDuplicate(found);
      }
      return;
    }
    toast.show("error", res.description);
  }

  return (
    <div className="content-container">
      <PageHero
        title="New Forward Task"
        subtitle="Connect a bot, point it at a chat, and configure copy mode"
      >
        <button className="btn btn-secondary" onClick={() => navigate("")}>
          Cancel
        </button>
      </PageHero>

      {/* Step 1: Bot Selection */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <span className={`step-pill ${hasBot ? "done" : "active"}`}>
              {hasBot ? "✓" : "1"}
            </span>
            <span>1. Select Telegram Bot</span>
          </div>
          {hasBot && <span className="badge badge-live">Connected</span>}
        </div>

        {!hasBot ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Primary: Add Telegram Bot Token (Always on top) */}
            <div>
              <div className="field" style={{ marginBottom: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <label style={{ margin: 0, fontWeight: 600 }}>Telegram Bot Token(s)</label>
                  <a
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 11.5, color: "var(--accent)", textDecoration: "none" }}
                  >
                    Get token from @BotFather ↗
                  </a>
                </div>
                <textarea
                  className="input"
                  rows={2}
                  style={{ fontFamily: "var(--font-mono, monospace)", resize: "vertical" }}
                  value={newToken}
                  onChange={(e) => setNewToken(e.target.value)}
                  placeholder={"Paste one or multiple bot tokens (one per line or comma-separated)…\n123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ…"}
                  autoFocus={!fromSavedId}
                />
              </div>
              <p className="text-muted" style={{ fontSize: 12, marginBottom: 10 }}>
                Tokens are verified directly with Telegram API and saved for reuse. You can paste multiple tokens at once.
              </p>
              {botError && (
                <div style={{ marginBottom: 10 }}>
                  <PermissionErrorBanner reason="unknown" description={botError} />
                </div>
              )}
              <button
                className="btn btn-primary"
                disabled={!newToken.trim() || savingBot}
                onClick={verifyNewBot}
              >
                {savingBot ? "Verifying with Telegram…" : "Verify & Save Bot(s)"}
              </button>
            </div>

            {/* Secondary: Choose from Existing Bots (ONLY if bots exist) */}
            {bots && bots.length > 0 && (
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    margin: "6px 0 14px",
                    color: "var(--text-dim)",
                    fontSize: 11.5,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    fontWeight: 600,
                  }}
                >
                  <div style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
                  <span>or choose from existing bots ({bots.length})</span>
                  <div style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
                </div>

                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Select Saved Bot</label>
                  <select
                    className="input"
                    value={selectedBotId}
                    onChange={(e) => handleSelectBot(e.target.value)}
                  >
                    <option value="">Choose a previously saved bot…</option>
                    {bots.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label} (@{b.bot_username})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Connected Bot summary card */
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "12px 16px",
                background: "var(--surface-raised)",
                border: "1px solid color-mix(in oklab, var(--success) 35%, transparent)",
                borderRadius: "var(--radius)",
                marginBottom: 12,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 24 }}>🤖</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>
                    @{selectedBot?.bot_username ?? pendingBot?.bot_username}
                    {selectedBot && (
                      <span className="text-muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 13 }}>
                        ({selectedBot.label})
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>
                    {pendingBot ? "Verified new bot token (will be saved when task starts)" : "Saved bot connected"}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setShowActivityModal(true)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                  title="Inspect what else this bot is doing"
                >
                  🔍 Check What Else Bot Is Doing
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleClearBot}
                  title="Choose a different bot"
                >
                  Change Bot
                </button>
              </div>
            </div>

            {showActivityModal && (
              <BotActivityModal
                botId={selectedBotId || undefined}
                botToken={pendingBot?.token}
                botUsername={selectedBot?.bot_username ?? pendingBot?.bot_username}
                onClose={() => setShowActivityModal(false)}
                onWebhookDisconnected={() => {
                  if (selectedBotId) handleSelectBot(selectedBotId);
                }}
              />
            )}

            {loadingBotTasks && <div className="skeleton-row" style={{ height: 36 }} />}

            {!loadingBotTasks && botActiveTasks !== null && botActiveTasks.length > 0 && (
              <div
                style={{
                  background: "var(--surface-raised)",
                  border: hasRunningBackfill
                    ? "1px solid color-mix(in oklab, var(--warning) 50%, transparent)"
                    : "1px solid rgba(245, 158, 11, 0.35)",
                  borderRadius: "var(--radius)",
                  padding: "12px 14px",
                  marginBottom: 10,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: 13,
                      color: hasRunningBackfill ? "var(--warning)" : "var(--ink)",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span>{hasRunningBackfill ? "⚠️ Active Backfill in Progress on this Bot" : "Currently Active Tasks on this Bot"}</span>
                    <span style={{ fontSize: 11.5, fontWeight: 500, color: "var(--muted)" }}>({botActiveTasks.length})</span>
                  </span>
                  <span className="badge badge-warning" style={{ fontSize: 11 }}>
                    {hasRunningBackfill ? "Backfill Active" : "Active Tasks"}
                  </span>
                </div>

                {hasRunningBackfill ? (
                  <div
                    style={{
                      background: "color-mix(in oklab, var(--warning) 12%, transparent)",
                      border: "1px solid color-mix(in oklab, var(--warning) 30%, transparent)",
                      borderRadius: "var(--radius-sm)",
                      padding: "10px 12px",
                      marginBottom: 10,
                      fontSize: 12,
                      lineHeight: 1.5,
                    }}
                  >
                    <p style={{ margin: "0 0 6px", color: "var(--ink)" }}>
                      This bot is currently executing historical message copying for{" "}
                      <strong>{runningBackfillTasks.map((t) => getTaskDisplayInfo(t).title).join(", ")}</strong>.
                      Telegram enforces strict message rate limits per bot token. Running multiple backfills concurrently on the same bot will trigger severe <strong>Telegram Flood Wait (429)</strong> throttling, pausing all tasks for that bot.
                    </p>
                    <div style={{ fontWeight: 600, color: "var(--warning)" }}>
                      💡 Recommendation: Use <strong>one dedicated bot token per backfilling task</strong> for maximum copy speed, or wait until the current backfill completes.
                    </div>
                  </div>
                ) : (
                  <p className="text-muted" style={{ fontSize: 12, marginBottom: 10 }}>
                    This bot is currently executing the following tasks. You can still assign new tasks to it, but high message volumes may share Telegram rate limits.
                  </p>
                )}

                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {botActiveTasks.map((bt) => {
                    const { title, routeText, isCustomLabel } = getTaskDisplayInfo(bt);
                    const isBtBackfilling = bt.backfill_status === "running";
                    return (
                      <div
                        key={bt.id}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "8px 10px",
                          background: isBtBackfilling
                            ? "color-mix(in oklab, var(--warning) 10%, var(--surface))"
                            : "var(--surface)",
                          borderRadius: "var(--radius-sm)",
                          fontSize: 12,
                          border: isBtBackfilling
                            ? "1px solid color-mix(in oklab, var(--warning) 40%, transparent)"
                            : "1px solid var(--border-subtle)",
                        }}
                      >
                        <div>
                          <strong style={{ color: "var(--ink)" }}>{title}</strong>
                          {isCustomLabel && (
                            <span className="text-muted" style={{ marginLeft: 8 }}>
                              {routeText}
                            </span>
                          )}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {isBtBackfilling ? (
                            <span className="badge badge-warning" style={{ fontSize: 10.5 }}>
                              ⚡ Backfilling
                            </span>
                          ) : (
                            <span className="badge badge-live" style={{ fontSize: 10.5 }}>
                              {bt.live_enabled ? "Live" : "Backfill"}
                            </span>
                          )}
                          <span className="text-muted" style={{ fontSize: 11 }}>
                            {bt.processed} copied
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {!loadingBotTasks && botActiveTasks !== null && botActiveTasks.length === 0 && (
              <div
                style={{
                  padding: "8px 12px",
                  background: "var(--success-tint)",
                  border: "1px solid color-mix(in oklab, var(--success) 30%, transparent)",
                  borderRadius: "var(--radius)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12.5,
                }}
              >
                <span style={{ color: "var(--success)", fontWeight: 700 }}>✓</span>
                <span>
                  <strong>@{selectedBot?.bot_username ?? pendingBot?.bot_username}</strong> is currently <strong>idle</strong> (0 active tasks — completely free for new assignments).
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Step 2: Source Chat */}
      {hasBot && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <span className={`step-pill ${sourceLookup ? "done" : "active"}`}>
                {sourceLookup ? "✓" : "2"}
              </span>
              <span>2. Source Chat / Channel</span>
            </div>
          </div>

          <div className="field">
            <label>Source Chat ID or @username (paste one or multiple to save)</label>
            <div className="row">
              <input
                className="input"
                style={{ flex: 1 }}
                value={sourceChatId}
                onChange={(e) => setSourceChatId(e.target.value)}
                onPaste={(e) => {
                  const text = e.clipboardData.getData("text");
                  if (text.includes("\n")) {
                    e.preventDefault();
                    const joined = text
                      .split(/\r?\n/)
                      .map((s) => s.trim())
                      .filter(Boolean)
                      .join(", ");
                    setSourceChatId((prev) => (prev ? `${prev}, ${joined}` : joined));
                  }
                }}
                placeholder="e.g. -1001234567890 or @channel (comma-separated for multiple)"
              />
              <button
                className="btn btn-secondary"
                disabled={!sourceChatId.trim() || lookingUpSource}
                onClick={() => lookupSource()}
              >
                {lookingUpSource ? "Checking…" : "Check"}
              </button>
              <button
                className="btn btn-primary"
                disabled={!sourceChatId.trim() || savingSourceChannels}
                onClick={handleSaveSourceChannels}
                title="Save entered channel(s) to Source Channels"
              >
                {savingSourceChannels ? "Saving…" : "+ Save Source"}
              </button>
            </div>
          </div>

          {sourceChannels.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  margin: "6px 0 14px",
                  color: "var(--text-dim)",
                  fontSize: 11.5,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  fontWeight: 600,
                }}
              >
                <div style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
                <span>or choose from existing source channels ({sourceChannels.length})</span>
                <div style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
              </div>

              <div className="field" style={{ marginBottom: 0 }}>
                <label>Select Saved Source Channel</label>
                <select
                  className="input"
                  value={sourceChannels.some((c) => c.chat_id === sourceChatId) ? sourceChatId : ""}
                  onChange={(e) => handleSelectSourceChannel(e.target.value)}
                >
                  <option value="">Choose a previously saved source channel…</option>
                  {sourceChannels.map((c) => (
                    <option key={c.id} value={c.chat_id}>
                      {c.label}{c.label !== c.chat_id ? ` (${c.chat_id})` : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {sourceError && <PermissionErrorBanner reason={sourceError.reason} description={sourceError.description} />}

          {sourceLookup && (
            <div style={{ marginTop: 14 }}>
              <div style={{ background: "var(--surface-raised)", borderRadius: "var(--radius)", padding: "12px 14px", marginBottom: 14 }}>
                <p style={{ fontWeight: 700, fontSize: 14 }}>
                  {sourceLookup.chat.title ?? sourceLookup.chat.id}
                </p>
                <p className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>
                  {sourceLookup.chat.type} · bot status: <strong>{sourceLookup.botStatus}</strong>
                  {sourceLookup.memberCount !== undefined && ` · ${sourceLookup.memberCount} members`}
                </p>
              </div>

              {/* Group Chat Source Notice (Telegram Bot API Restriction) */}
              {(sourceLookup.chat.type === "group" || sourceLookup.chat.type === "supergroup") && (
                <div
                  style={{
                    background: "rgba(245, 158, 11, 0.08)",
                    border: "1px solid rgba(245, 158, 11, 0.35)",
                    borderRadius: "var(--radius)",
                    padding: "12px 14px",
                    marginBottom: 14,
                  }}
                >
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 18, marginTop: 1 }}>⚠️</span>
                    <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                      <strong style={{ color: "var(--warning)" }}>Group Chat Notice (Telegram Bot API Restriction):</strong>
                      <p style={{ margin: "4px 0 6px", color: "var(--ink)" }}>
                        Telegram prevents bots from seeing or copying messages sent by other bots in group chats (anti-loop policy). If this group relies on other bots to post files or messages, those bot-authored messages will not be copyable (they will be skipped as <em>"message to copy not found"</em>).
                      </p>
                      <span style={{ color: "var(--muted)", fontSize: 12 }}>
                        💡 <strong>Recommendation:</strong> If you need complete file cloning, consider using a <strong>Telegram Channel</strong> as the source. Channel posts are published on behalf of the channel and can be copied freely by bots regardless of author.
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Previous Task History for this Source Channel */}
              {sourceLookup.pastTasks && sourceLookup.pastTasks.length > 0 ? (
                <div
                  style={{
                    marginBottom: 14,
                    background: "var(--surface-raised)",
                    border: "1px solid rgba(245, 158, 11, 0.35)",
                    borderRadius: "var(--radius)",
                    padding: "14px",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: 13, color: "var(--warning)" }}>
                      📋 Channel Task History ({sourceLookup.pastTasks.length} previous task{sourceLookup.pastTasks.length > 1 ? "s" : ""})
                    </span>
                    <span className="badge badge-warning" style={{ fontSize: 11 }}>Previously Added</span>
                  </div>
                  <p className="text-muted" style={{ fontSize: 12, marginBottom: 12 }}>
                    This channel was previously connected to the following tasks. Review what was done and the last copied message ID to prevent duplicate copying.
                  </p>

                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {sourceLookup.pastTasks.map((pt) => {
                      const statusLabel = pt.stop_reason
                        ? `Stopped (${pt.stop_reason})`
                        : pt.backfill_status === "complete"
                        ? "Complete"
                        : pt.live_enabled
                        ? "Live Forwarding"
                        : pt.backfill_status;

                      return (
                        <div
                          key={pt.id}
                          style={{
                            background: "var(--surface)",
                            borderRadius: "var(--radius-sm)",
                            padding: "10px 12px",
                            fontSize: 12,
                            border: "1px solid var(--border-subtle)",
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                            <strong style={{ fontSize: 12.5, color: "var(--ink)" }}>{pt.label}</strong>
                            <span className="badge" style={{ fontSize: 10.5 }}>{statusLabel}</span>
                          </div>
                          <div className="task-detail" style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 6 }}>
                            <span>Dest: <strong>{pt.dest_chat_title ?? pt.dest_chat_id}</strong></span>
                            <span>·</span>
                            <span>Bot: @{pt.bot_username}</span>
                            <span>·</span>
                            <span>Mode: {(pt.scope ?? "live").replace(/_/g, " ")}</span>
                          </div>
                          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12 }}>
                            <span>
                              Copied: <strong>{pt.processed} msgs</strong>{pt.failed ? ` (${pt.failed} failed)` : ""}
                            </span>
                            <span>
                              Last Copied Message ID:{" "}
                              <strong style={{ color: "var(--accent)" }}>
                                {pt.last_copied_message_id != null ? `#${pt.last_copied_message_id}` : "None"}
                              </strong>
                            </span>
                            {pt.start_id != null && pt.end_id != null && (
                              <span>Range: #{pt.start_id} → #{pt.end_id}</span>
                            )}
                            <span>Created: {new Date(pt.created_at * 1000).toLocaleDateString()}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {(() => {
                    const validIds = sourceLookup.pastTasks
                      .map((pt) => pt.last_copied_message_id)
                      .filter((id): id is number => id != null && id > 0);
                    const maxLastId = validIds.length > 0 ? Math.max(...validIds) : 0;
                    if (maxLastId > 0) {
                      return (
                        <div
                          style={{
                            marginTop: 12,
                            padding: "8px 12px",
                            background: "var(--accent-tint)",
                            borderRadius: "var(--radius-sm)",
                            border: "1px solid var(--accent-border)",
                            fontSize: 12,
                          }}
                        >
                          💡 <strong>Duplication Safeguard:</strong> The highest message ID copied from this channel so far is <strong>#{maxLastId}</strong>. If you are configuring a new backfill, set your <strong>Start ID to #{maxLastId + 1}</strong> to avoid duplicating past messages.
                        </div>
                      );
                    }
                    return null;
                  })()}
                </div>
              ) : (
                <div
                  style={{
                    marginBottom: 14,
                    padding: "8px 12px",
                    background: "var(--success-tint)",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid color-mix(in oklab, var(--success) 30%, transparent)",
                    fontSize: 12,
                    color: "var(--ink)",
                  }}
                >
                  ✓ <strong>Fresh Channel:</strong> No previous tasks found for this source channel.
                </div>
              )}

              <CapabilityChecklist capabilities={sourceLookup.capabilities} />

              {/* Collapsible Admin Tools Accordion */}
              <div className="accordion">
                <div
                  className="accordion-header"
                  onClick={() => setShowAdminTools((s) => !s)}
                >
                  <span>🛠️ Advanced Admin Tools (Invites, Bans, Diagnostics)</span>
                  <span>{showAdminTools ? "▲" : "▼"}</span>
                </div>
                {showAdminTools && (
                  <div className="accordion-body">
                    <div className="row">
                      <button className="btn btn-secondary btn-sm" onClick={generateInviteLink}>
                        Generate invite link
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={sendTestMessage}>
                        Send test message
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={checkLatestId}>
                        Check latest message ID
                      </button>
                    </div>
                    {inviteLink && (
                      <p className="text-mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
                        {inviteLink}
                      </p>
                    )}
                    <div className="row">
                      <input
                        className="input"
                        style={{ maxWidth: 220 }}
                        placeholder="Paste invite link to revoke"
                        value={revokeInviteLinkInput}
                        onChange={(e) => setRevokeInviteLinkInput(e.target.value)}
                      />
                      <button className="btn btn-secondary btn-sm" onClick={revokeInviteLink} disabled={!revokeInviteLinkInput}>
                        Revoke link
                      </button>
                    </div>
                    <div className="row">
                      <input
                        className="input"
                        style={{ maxWidth: 160 }}
                        placeholder="User ID"
                        value={userIdInput}
                        onChange={(e) => setUserIdInput(e.target.value)}
                      />
                      <button className="btn btn-secondary btn-sm" onClick={banUser}>
                        Ban
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={unbanUser}>
                        Unban
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={promoteUser}>
                        Promote
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 3: Destination & Copy Config */}
      {sourceLookup && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <span className={`step-pill ${destinationChecksComplete ? "done" : "active"}`}>
                {destinationChecksComplete ? "✓" : "3"}
              </span>
              <span>3. Destination & Sync Mode</span>
            </div>
          </div>

          <div className="field">
            <label>Destination / Target Chat ID or @username (paste one or multiple to save)</label>
            {destinationIds.length > 25 && (
              <p className="text-muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
                Check and create at most 25 destination chats at a time.
              </p>
            )}
            <div className="row">
              <input
                className="input"
                style={{ flex: 1 }}
                disabled={lookingUpDest}
                value={destChatId}
                onPaste={(e) => {
                  const text = e.clipboardData.getData("text");
                  if (text.includes("\n")) {
                    e.preventDefault();
                    const joined = text
                      .split(/\r?\n/)
                      .map((s) => s.trim())
                      .filter(Boolean)
                      .join(", ");
                    setDestChatId((prev) => (prev ? `${prev}, ${joined}` : joined));
                    setDestLookups([]);
                    setDestError(null);
                    setDestLookupErrors([]);
                  }
                }}
                onChange={(e) => {
                  setDestChatId(e.target.value);
                  setDestLookups([]);
                  setDestError(null);
                  setDestLookupErrors([]);
                }}
                placeholder="e.g. -1009876543210 or @destchannel (comma-separated for multiple)"
              />
              <button
                className="btn btn-secondary"
                disabled={!destChatId.trim() || lookingUpDest}
                onClick={() => lookupDest()}
              >
                {lookingUpDest ? "Checking…" : "Check"}
              </button>
              <button
                className="btn btn-primary"
                disabled={!destChatId.trim() || savingTargetChannels}
                onClick={handleSaveTargetChannels}
                title="Save entered channel(s) to Target Channels"
              >
                {savingTargetChannels ? "Saving…" : "+ Save Target"}
              </button>
            </div>
          </div>

          {targetChannels.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  margin: "6px 0 14px",
                  color: "var(--text-dim)",
                  fontSize: 11.5,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  fontWeight: 600,
                }}
              >
                <div style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
                <span>or choose from existing target channels ({targetChannels.length})</span>
                <div style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
              </div>

              <div className="field" style={{ marginBottom: 0 }}>
                <label>Select Saved Target Channels</label>
                <select
                  className="input"
                  disabled={lookingUpDest}
                  multiple
                  size={Math.min(5, targetChannels.length)}
                  value={targetChannels.filter((c) => destinationIds.includes(c.chat_id)).map((c) => c.chat_id)}
                  onChange={(e) => handleSelectTargetChannels(Array.from(e.target.selectedOptions, (option) => option.value))}
                >
                  {targetChannels.map((c) => (
                    <option key={c.id} value={c.chat_id}>
                      {c.label}{c.label !== c.chat_id ? ` (${c.chat_id})` : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {destError && <PermissionErrorBanner reason={destError.reason} description={destError.description} />}
          {destLookupErrors.length > 0 && (
            <ul className="text-muted" style={{ fontSize: 12, margin: "8px 0 14px", paddingLeft: 20 }}>
              {destLookupErrors.map((error) => <li key={error}>{error}</li>)}
            </ul>
          )}

          {destLookups.length > 0 && (
            <>
              {destLookups.map((lookup) => (
                <p key={lookup.chat.id} className="text-muted" style={{ fontSize: 13, marginBottom: 8 }}>
                  <strong>{lookup.chat.title ?? lookup.chat.id}</strong> —{" "}
                  {lookup.capabilities.find((c) => c.key === "send_message")?.available
                    ? "bot can post here ✓"
                    : "bot cannot post here ✗"}
                </p>
              ))}

              {/* Destination Group Chat Warning for Future Operations */}
              {destLookups.filter((lookup) => lookup.chat.type === "group" || lookup.chat.type === "supergroup").map((lookup) => (
                <div
                  key={lookup.chat.id}
                  style={{
                    background: "rgba(56, 189, 248, 0.08)",
                    border: "1px solid rgba(56, 189, 248, 0.3)",
                    borderRadius: "var(--radius)",
                    padding: "12px 14px",
                    marginBottom: 16,
                  }}
                >
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 18, marginTop: 1 }}>ℹ️</span>
                    <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                      <strong style={{ color: "var(--info)" }}>{lookup.chat.title ?? lookup.chat.id} is a Group Chat:</strong>
                      <p style={{ margin: "4px 0 6px", color: "var(--ink)" }}>
                        Messages copied here will be sent under this bot's identity. <strong>Notice for future operations:</strong> Telegram's anti-loop rule prevents bots from copying messages sent by other bots in groups. If you or another bot ever attempt to clone messages <em>out</em> of this destination group later, those bot-authored messages will not be copyable.
                      </p>
                      <span style={{ color: "var(--muted)", fontSize: 12 }}>
                        💡 <strong>Tip:</strong> If you are creating a permanent file archive or mirror intended to be cloned again by other bots in the future, a <strong>Telegram Channel</strong> is recommended.
                      </span>
                    </div>
                  </div>
                </div>
              ))}

              <div className="field">
                <label>Copy Scope</label>
                <select className="input" value={scope} onChange={(e) => setScope(e.target.value as TaskScope)}>
                  <option value="live">New messages only (Live forward)</option>
                  <option value="live_and_backfill">✨ Existing + New (Catch-Up Stream)</option>
                  <option value="backfill_only">Existing only (One-time history backfill)</option>
                </select>

                {wantsBackfill && hasRunningBackfill && (
                  <div
                    style={{
                      margin: "10px 0 6px",
                      padding: "12px 14px",
                      background: "color-mix(in oklab, var(--warning) 12%, transparent)",
                      border: "1px solid color-mix(in oklab, var(--warning) 40%, transparent)",
                      borderRadius: "var(--radius)",
                      fontSize: 12.5,
                      color: "var(--ink)",
                      lineHeight: 1.5,
                    }}
                  >
                    <div style={{ fontWeight: 700, color: "var(--warning)", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                      <span>⚠️ Flood Wait Advisory: Concurrent Backfill Detected</span>
                    </div>
                    <p style={{ margin: "0 0 8px" }}>
                      <strong>@{selectedBot?.bot_username ?? pendingBot?.bot_username}</strong> is already actively running a historical backfill for{" "}
                      <strong>{runningBackfillTasks.map((t) => getTaskDisplayInfo(t).title).join(", ")}</strong>. Assigning another backfill to this same bot token will split Telegram's copy quota and trigger <strong>Telegram Flood Wait (429)</strong> throttling.
                    </p>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      <li>
                        <strong>Recommended:</strong> Return to Step 1 and connect a separate bot token from{" "}
                        <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
                          @BotFather ↗
                        </a>{" "}
                        (1 bot per backfill task prevents flood waits).
                      </li>
                      <li style={{ marginTop: 3 }}>
                        <strong>Alternative:</strong> Switch scope to <em>"New messages only (Live forward)"</em> if you only need upcoming messages.
                      </li>
                    </ul>
                  </div>
                )}
              </div>

              {wantsBackfill && (
                <div className="field">
                  <label>Backfill Mode</label>
                  <div className="row" style={{ marginBottom: 8 }}>
                    <label className="row" style={{ gap: 6, cursor: "pointer" }}>
                      <input type="radio" checked={backfillMode === "lastN"} onChange={() => setBackfillMode("lastN")} /> Last N messages
                    </label>
                    <label className="row" style={{ gap: 6, cursor: "pointer" }}>
                      <input type="radio" checked={backfillMode === "range"} onChange={() => setBackfillMode("range")} /> Explicit ID range
                    </label>
                  </div>
                  {backfillMode === "lastN" ? (
                    <input className="input" style={{ maxWidth: 160 }} value={n} onChange={(e) => setN(e.target.value)} placeholder="N messages" />
                  ) : (
                    <div className="row">
                      <input className="input" style={{ maxWidth: 160 }} value={startId} onChange={(e) => setStartId(e.target.value)} placeholder="Start ID" />
                      <input className="input" style={{ maxWidth: 160 }} value={endId} onChange={(e) => setEndId(e.target.value)} placeholder="End ID" />
                    </div>
                  )}
                  <p className="text-muted" style={{ fontSize: 12, marginTop: 6 }}>
                    ⚡ Bulk backfill pace: 60 messages/minute. Runs at maximum speed without filters to preserve complete chat history.
                  </p>
                </div>
              )}

              {/* Message Filters (Available for Live and Live+Backfill) */}
              {scope !== "backfill_only" && (
                <div
                  style={{
                    margin: "16px 0",
                    padding: "14px 16px",
                    background: "var(--surface-raised)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5, display: "flex", alignItems: "center", gap: 6 }}>
                      <span>🔍 {scope === "live" ? "Live Message Filters" : "Live Stream Filters (Stage 2)"}</span>
                    </div>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
                      <input
                        type="checkbox"
                        checked={enableFilters}
                        onChange={(e) => setEnableFilters(e.target.checked)}
                      />
                      Enable Filters
                    </label>
                  </div>

                  {scope === "live_and_backfill" && (
                    <div
                      style={{
                        padding: "10px 12px",
                        background: "var(--accent-tint)",
                        border: "1px solid var(--accent-border)",
                        borderRadius: "var(--radius-sm)",
                        fontSize: 12,
                        color: "var(--ink)",
                        lineHeight: 1.5,
                        marginBottom: 12,
                      }}
                    >
                      <div style={{ fontWeight: 600, color: "var(--info)", marginBottom: 3 }}>
                        ℹ️ Two-Stage Catch-Up Stream
                      </div>
                      <div>
                        • <strong>Historical Backfill (Stage 1)</strong>: Existing messages up to the latest ID will be copied in bulk (60 msgs/min) <strong>without filters</strong> to ensure full speed and complete chat history.
                      </div>
                      <div style={{ marginTop: 3 }}>
                        • <strong>Live Messages (Stage 2)</strong>: All incoming messages after backfill will be evaluated against your filters below. While backfill is running, matching live messages are safely queued in order.
                      </div>
                    </div>
                  )}

                  {enableFilters && (
                    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 12 }}>
                      <div>
                        <label style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)", display: "block", marginBottom: 6 }}>
                          Allowed Media Types (Leave unchecked for all media)
                        </label>
                        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12.5 }}>
                          {[
                            { id: "document", label: "📄 Documents / Files" },
                            { id: "video", label: "🎬 Videos" },
                            { id: "photo", label: "🖼️ Photos" },
                            { id: "audio", label: "🎵 Audio" },
                          ].map((mt) => (
                            <label key={mt.id} style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
                              <input
                                type="checkbox"
                                checked={filterMediaTypes.includes(mt.id)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setFilterMediaTypes([...filterMediaTypes, mt.id]);
                                  } else {
                                    setFilterMediaTypes(filterMediaTypes.filter((t) => t !== mt.id));
                                  }
                                }}
                              />
                              {mt.label}
                            </label>
                          ))}
                        </div>
                        <p className="text-muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                          Selecting specific media types automatically filters out text-only channel posts.
                        </p>
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                        <div className="field" style={{ margin: 0 }}>
                          <label style={{ fontSize: 12 }}>Minimum File Size (MB)</label>
                          <input
                            className="input"
                            type="number"
                            min="0"
                            step="1"
                            placeholder="e.g. 10 (ignore files < 10 MB)"
                            value={minFileSizeMb}
                            onChange={(e) => setMinFileSizeMb(e.target.value)}
                          />
                        </div>
                        <div className="field" style={{ margin: 0 }}>
                          <label style={{ fontSize: 12 }}>Maximum File Size (MB, optional)</label>
                          <input
                            className="input"
                            type="number"
                            min="0"
                            step="1"
                            placeholder="e.g. 500 (ignore files > 500 MB)"
                            value={maxFileSizeMb}
                            onChange={(e) => setMaxFileSizeMb(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="row" style={{ marginTop: 8 }}>
                <input
                  className="input"
                  style={{ maxWidth: 180 }}
                  placeholder="Message ID (optional; first target)"
                  value={testMessageId}
                  onChange={(e) => setTestMessageId(e.target.value)}
                />
                <button className="btn btn-secondary" disabled={testingCopy} onClick={runTestCopy}>
                  {testingCopy ? "Sending…" : "Send test copy"}
                </button>
              </div>
              {testCopyResult && (
                <p className="text-muted" style={{ fontSize: 12, marginTop: 8 }}>
                  {testCopyResult}
                </p>
              )}

              {duplicate && (
                <div className="permission-banner" style={{ marginTop: 16 }}>
                  <span>⚠</span>
                  <div>
                    A task for this source → destination already exists ("{duplicate.label}").{" "}
                    <button
                      className="btn btn-danger btn-sm"
                      style={{ marginTop: 8 }}
                      onClick={() => createTask(true, lastSaveTemplate)}
                    >
                      Create anyway
                    </button>
                  </div>
                </div>
              )}

              <div className="row" style={{ marginTop: 24 }}>
                <button className="btn btn-primary" disabled={creating || !destinationChecksComplete} onClick={() => createTask(false, false)}>
                  {creating && !lastSaveTemplate ? "Creating…" : "Create Task"}
                </button>
                <button className="btn btn-secondary" disabled={creating || !destinationChecksComplete} onClick={() => createTask(false, true)}>
                  {creating && lastSaveTemplate ? "Saving…" : "Save & Start"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
