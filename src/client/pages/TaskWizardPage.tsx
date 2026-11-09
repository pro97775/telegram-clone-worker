import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { usePolling } from "../lib/usePolling";
import { useToast } from "../components/Toast";
import { PageHero } from "../components/PageHero";
import { CapabilityChecklist } from "../components/CapabilityChecklist";
import { PermissionErrorBanner } from "../components/PermissionErrorBanner";
import { BotActivityModal } from "../components/BotActivityModal";
import { navigate } from "../lib/router";
import { useTasks, getTaskDisplayInfo } from "../lib/useTasksContext";
import type {
  BatchCreateTasksResult,
  BotSummary,
  BotVerifyResult,
  BulkBotImportResult,
  BulkChannelImportResult,
  ChatLookupResult,
  ErrorReason,
  SavedChannel,
  SavedTaskWithToken,
  TaskScope,
  TaskSummary,
} from "../../shared/rpcTypes";

type BackfillMode = "range" | "lastN";

interface TargetItem {
  key: string;
  inputChatId: string;
  labelHint?: string;
  loading: boolean;
  lookup: ChatLookupResult | null;
  error: { reason: ErrorReason; description: string } | null;
}

export function TaskWizardPage({ fromSavedId }: { fromSavedId?: string }) {
  const toast = useToast();
  const { refetch: refetchGlobalTasks } = useTasks();
  const { data: bots, refetch: refetchBots } = usePolling(() => api.get<BotSummary[]>("/api/bots"), 15000);
  const { data: savedChannels, refetch: refetchChannels } = usePolling(
    () => api.get<SavedChannel[]>("/api/channels"),
    15000,
  );

  // Step 1: bot
  const [selectedBotId, setSelectedBotId] = useState<string>("");
  const [newToken, setNewToken] = useState("");
  const [bulkBotMode, setBulkBotMode] = useState(false);
  const [bulkBotText, setBulkBotText] = useState("");
  const [bulkBotResult, setBulkBotResult] = useState<BulkBotImportResult | null>(null);
  const [botError, setBotError] = useState<string | null>(null);
  const [savingBot, setSavingBot] = useState(false);
  const [pendingBot, setPendingBot] = useState<{ token: string; bot_id: number; bot_username: string } | null>(null);
  const [botActiveTasks, setBotActiveTasks] = useState<TaskSummary[] | null>(null);
  const [loadingBotTasks, setLoadingBotTasks] = useState(false);
  const [showActivityModal, setShowActivityModal] = useState(false);

  // Inline bulk channel add helper (accessible from Step 2 or Step 3)
  const [showInlineChannelAdd, setShowInlineChannelAdd] = useState(false);
  const [inlineChannelText, setInlineChannelText] = useState("");
  const [savingInlineChannels, setSavingInlineChannels] = useState(false);

  function handleClearBot() {
    setSelectedBotId("");
    setPendingBot(null);
    setBotActiveTasks(null);
    setNewToken("");
    setBotError(null);
  }

  // Step 2: source chat
  const [sourceChatId, setSourceChatId] = useState("");
  const [sourceLookup, setSourceLookup] = useState<ChatLookupResult | null>(null);
  const [sourceError, setSourceError] = useState<{ reason: ErrorReason; description: string } | null>(null);
  const [lookingUpSource, setLookingUpSource] = useState(false);
  const [showAdminTools, setShowAdminTools] = useState(false);
  const [userIdInput, setUserIdInput] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [revokeInviteLinkInput, setRevokeInviteLinkInput] = useState("");

  // Step 3: multi-target destinations + config (1 source -> 1 bot -> many targets)
  const [destInput, setDestInput] = useState("");
  const [targets, setTargets] = useState<TargetItem[]>([]);
  const [scope, setScope] = useState<TaskScope>("live");
  const [backfillMode, setBackfillMode] = useState<BackfillMode>("lastN");
  const [startId, setStartId] = useState("");
  const [endId, setEndId] = useState("");
  const [n, setN] = useState("100");
  const [batchDuplicates, setBatchDuplicates] = useState<BatchCreateTasksResult["duplicates"]>([]);
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
      setDestInput(s.dest_chat_id);
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
    const res = await api.post<BotVerifyResult>("/api/bots/verify", { token: newToken.trim() });
    setSavingBot(false);
    if (!res.ok) {
      setBotError(res.description);
      return;
    }
    toast.show("success", `Verified @${res.data.bot_username}`);
    if (res.data.existing_bot_id) {
      await refetchBots();
      await handleSelectBot(res.data.existing_bot_id);
    } else {
      setSelectedBotId("");
      setPendingBot({ token: newToken.trim(), bot_id: res.data.bot_id, bot_username: res.data.bot_username });
      setBotActiveTasks(res.data.active_tasks ?? []);
    }
    setNewToken("");
  }

  async function handleBulkAddBotsInWizard() {
    if (!bulkBotText.trim()) return;
    setBotError(null);
    setSavingBot(true);
    setBulkBotResult(null);
    const res = await api.post<BulkBotImportResult>("/api/bots/bulk", { rawText: bulkBotText });
    setSavingBot(false);
    if (!res.ok) {
      setBotError(res.description);
      return;
    }
    setBulkBotResult(res.data);
    await refetchBots();
    const firstValid = res.data.results.find((r) => r.bot)?.bot;
    if (firstValid) {
      toast.show(
        "success",
        `Saved ${res.data.created + res.data.existing} bot(s)! Selected @${firstValid.bot_username} for this task.`,
      );
      setBulkBotText("");
      await handleSelectBot(firstValid.id);
    } else {
      setBotError(`All ${res.data.failed} token(s) failed verification.`);
    }
  }

  async function handleSaveInlineChannels() {
    if (!inlineChannelText.trim()) return;
    setSavingInlineChannels(true);
    const res = await api.post<BulkChannelImportResult>("/api/channels/bulk", {
      rawText: inlineChannelText,
      botId: selectedBotId || undefined,
      botToken: pendingBot?.token,
    });
    setSavingInlineChannels(false);
    if (!res.ok) {
      toast.show("error", res.description);
      return;
    }
    toast.show("success", `Saved ${res.data.saved} channel(s) to your Saved Channels list`);
    setInlineChannelText("");
    setShowInlineChannelAdd(false);
    await refetchChannels();
  }

  async function lookupSourceById(chatIdToLookup: string) {
    const trimmed = chatIdToLookup.trim();
    if (!hasBot || !trimmed) return;
    setSourceChatId(trimmed);
    setLookingUpSource(true);
    setSourceError(null);
    setSourceLookup(null);
    const res = await api.get<ChatLookupResult>(`/api/chats/${encodeURIComponent(trimmed)}?${botQuery()}`);
    setLookingUpSource(false);
    if (res.ok) {
      setSourceLookup(res.data);
      refetchChannels();
    } else {
      setSourceError({ reason: res.reason, description: res.description });
    }
  }

  async function lookupSource() {
    await lookupSourceById(sourceChatId);
  }

  /** Adds and checks one or multiple target chat IDs in parallel */
  async function addAndLookupTargets(rawChatIds: Array<{ chatId: string; labelHint?: string }>) {
    if (!hasBot || rawChatIds.length === 0) return;

    const sourceIdStr = sourceLookup ? String(sourceLookup.chat.id) : sourceChatId.trim();
    const filteredNew: TargetItem[] = [];

    setTargets((prev) => {
      const existingKeys = new Set(
        prev.flatMap((t) => [
          t.inputChatId.toLowerCase(),
          t.lookup ? String(t.lookup.chat.id).toLowerCase() : "",
          t.lookup?.chat.username ? `@${t.lookup.chat.username.toLowerCase()}` : "",
        ]).filter(Boolean),
      );

      for (const item of rawChatIds) {
        const clean = item.chatId.trim();
        if (!clean) continue;
        if (clean === sourceIdStr || (sourceLookup?.chat.username && clean.toLowerCase() === `@${sourceLookup.chat.username.toLowerCase()}`)) {
          toast.show("error", `Skipped ${clean}: Source and target channel cannot be the same`);
          continue;
        }
        if (existingKeys.has(clean.toLowerCase())) continue;
        existingKeys.add(clean.toLowerCase());
        filteredNew.push({
          key: `${clean}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          inputChatId: clean,
          labelHint: item.labelHint,
          loading: true,
          lookup: null,
          error: null,
        });
      }
      return [...prev, ...filteredNew];
    });

    if (filteredNew.length === 0) return;

    await Promise.all(
      filteredNew.map(async (item) => {
        const res = await api.get<ChatLookupResult>(`/api/chats/${encodeURIComponent(item.inputChatId)}?${botQuery()}`);
        setTargets((prev) =>
          prev.map((t) => {
            if (t.key !== item.key) return t;
            if (res.ok) {
              return { ...t, loading: false, lookup: res.data, error: null };
            }
            return {
              ...t,
              loading: false,
              lookup: null,
              error: { reason: res.reason, description: res.description },
            };
          }),
        );
      }),
    );

    refetchChannels();
  }

  async function handleAddTargetsFromInput() {
    if (!destInput.trim()) return;
    const rawTokens = destInput
      .split(/[\r\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    setDestInput("");
    await addAndLookupTargets(rawTokens.map((chatId) => ({ chatId })));
  }

  function removeTarget(key: string) {
    setTargets((prev) => prev.filter((t) => t.key !== key));
    setBatchDuplicates([]);
  }

  function isChannelSelectedAsTarget(ch: SavedChannel): boolean {
    return targets.some(
      (t) =>
        t.inputChatId.toLowerCase() === ch.chat_id.toLowerCase() ||
        (t.lookup && String(t.lookup.chat.id) === ch.chat_id) ||
        (ch.username && t.inputChatId.toLowerCase() === `@${ch.username.toLowerCase()}`),
    );
  }

  async function toggleSavedChannelTarget(ch: SavedChannel) {
    const existing = targets.find(
      (t) =>
        t.inputChatId.toLowerCase() === ch.chat_id.toLowerCase() ||
        (t.lookup && String(t.lookup.chat.id) === ch.chat_id) ||
        (ch.username && t.inputChatId.toLowerCase() === `@${ch.username.toLowerCase()}`),
    );
    if (existing) {
      removeTarget(existing.key);
    } else {
      await addAndLookupTargets([{ chatId: ch.chat_id, labelHint: ch.title }]);
    }
  }

  async function selectAllSavedChannelsAsTargets() {
    if (!availableTargetChannels || availableTargetChannels.length === 0) return;
    const toAdd = availableTargetChannels
      .filter((ch) => !isChannelSelectedAsTarget(ch))
      .map((ch) => ({ chatId: ch.chat_id, labelHint: ch.title }));
    await addAndLookupTargets(toAdd);
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

  const verifiedTargets = targets.filter((t) => t.lookup !== null);

  async function runTestCopy() {
    if (verifiedTargets.length === 0) return;
    setTestingCopy(true);
    setTestCopyResult(null);
    const outcomes: string[] = [];
    for (const t of verifiedTargets) {
      const destId = String(t.lookup!.chat.id);
      const destTitle = t.lookup!.chat.title ?? destId;
      const res = await api.post<{ message_id: number }>(
        `/api/chats/${encodeURIComponent(String(sourceLookup!.chat.id))}/test-copy?${botQuery()}`,
        {
          destChatId: destId,
          messageId: testMessageId ? Number(testMessageId) : undefined,
        },
      );
      outcomes.push(res.ok ? `✓ ${destTitle} (msg #${res.data.message_id})` : `✗ ${destTitle} (${res.description})`);
    }
    setTestingCopy(false);
    setTestCopyResult(outcomes.join(" · "));
  }

  async function createTasksBatch(allowDuplicate = false, saveTemplate = false) {
    if (!sourceLookup || verifiedTargets.length === 0) return;
    setLastSaveTemplate(saveTemplate);
    setCreating(true);
    setBatchDuplicates([]);

    const wantsLive = scope === "live" || scope === "live_and_backfill";
    const minBytes = wantsLive && enableFilters && minFileSizeMb ? Math.round(Number(minFileSizeMb) * 1024 * 1024) : undefined;
    const maxBytes = wantsLive && enableFilters && maxFileSizeMb ? Math.round(Number(maxFileSizeMb) * 1024 * 1024) : undefined;
    const mediaTypesStr = wantsLive && enableFilters && filterMediaTypes.length > 0 ? filterMediaTypes.join(",") : undefined;

    const botPathId = pendingBot ? "new" : selectedBotId;
    const body = {
      botToken: pendingBot?.token,
      sourceChatId: String(sourceLookup.chat.id),
      sourceChatTitle: sourceLookup.chat.title ?? sourceLookup.chat.username ?? String(sourceLookup.chat.id),
      targets: verifiedTargets.map((t) => ({
        destChatId: String(t.lookup!.chat.id),
        destChatTitle: t.lookup!.chat.title ?? t.labelHint ?? String(t.lookup!.chat.id),
        destChatType: t.lookup!.chat.type,
      })),
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

    const res = await api.post<BatchCreateTasksResult>(`/api/bots/${botPathId}/tasks/batch`, body);
    setCreating(false);

    if (!res.ok) {
      toast.show("error", res.description);
      return;
    }

    const { created, duplicates, errors } = res.data;
    await refetchGlobalTasks();
    await refetchChannels();

    if (duplicates.length > 0 && created.length === 0) {
      setBatchDuplicates(duplicates);
      return;
    }

    if (errors.length > 0) {
      toast.show("error", `${errors.length} target(s) failed: ${errors.map((e) => e.error).join(", ")}`);
    }

    if (created.length === 1 && duplicates.length === 0) {
      toast.show("success", "Task created");
      navigate(`task/${created[0].id}`);
      return;
    }

    if (created.length > 0) {
      toast.show(
        "success",
        `Created ${created.length} task${created.length === 1 ? "" : "s"} from ${
          sourceLookup.chat.title ?? sourceLookup.chat.id
        }!`,
      );
      navigate("");
    }
  }

  const availableTargetChannels = (savedChannels ?? []).filter((ch) => {
    if (!sourceLookup) return true;
    const srcId = String(sourceLookup.chat.id);
    const srcUser = sourceLookup.chat.username?.toLowerCase();
    if (ch.chat_id === srcId) return false;
    if (srcUser && (ch.chat_id.toLowerCase() === `@${srcUser}` || ch.username?.toLowerCase() === srcUser)) {
      return false;
    }
    return true;
  });

  return (
    <div className="content-container">
      <PageHero
        title="New Forward Task"
        subtitle="Connect one or many bots, pick saved source & target channels, and forward from 1 source to many targets"
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
            {/* Choose from Existing Saved Bots (Displayed prominently when bots exist) */}
            {bots && bots.length > 0 && (
              <div>
                <div className="field" style={{ marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <label style={{ margin: 0, fontWeight: 600 }}>Select Saved Bot ({bots.length})</label>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ fontSize: 11.5, padding: "2px 8px" }}
                      onClick={() => navigate("bots")}
                    >
                      Manage Bots →
                    </button>
                  </div>
                  <select
                    className="input"
                    value={selectedBotId}
                    onChange={(e) => handleSelectBot(e.target.value)}
                  >
                    <option value="">Choose a saved bot…</option>
                    {bots.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label} (@{b.bot_username})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Quick-Select Bot Pills */}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                  {bots.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ fontSize: 12 }}
                      onClick={() => handleSelectBot(b.id)}
                    >
                      🤖 {b.label} <span className="text-muted">@{b.bot_username}</span>
                    </button>
                  ))}
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    margin: "16px 0 6px",
                    color: "var(--text-dim)",
                    fontSize: 11.5,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    fontWeight: 600,
                  }}
                >
                  <div style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
                  <span>or add new bot token(s)</span>
                  <div style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
                </div>
              </div>
            )}

            {/* Add Single or Multiple Bot Tokens */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <label style={{ margin: 0, fontWeight: 600 }}>
                    {bulkBotMode ? "Bulk Add Multiple Bot Tokens" : "Telegram Bot Token"}
                  </label>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ fontSize: 11.5, padding: "2px 8px" }}
                    onClick={() => {
                      setBulkBotMode((m) => !m);
                      setBotError(null);
                      setBulkBotResult(null);
                    }}
                  >
                    {bulkBotMode ? "Switch to Single Token" : "+ Add Multiple Bot Tokens at Once"}
                  </button>
                </div>
                <a
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 11.5, color: "var(--accent)", textDecoration: "none" }}
                >
                  Get token from @BotFather ↗
                </a>
              </div>

              {!bulkBotMode ? (
                <>
                  <div className="field" style={{ marginBottom: 6 }}>
                    <input
                      className="input"
                      value={newToken}
                      onChange={(e) => setNewToken(e.target.value)}
                      placeholder="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ…"
                      type="password"
                      autoFocus={!fromSavedId && (!bots || bots.length === 0)}
                    />
                  </div>
                  <p className="text-muted" style={{ fontSize: 12, marginBottom: 10 }}>
                    Token is verified directly with Telegram API to check permissions, bot username, and active workloads.
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
                    {savingBot ? "Verifying with Telegram…" : "Verify & Connect Bot"}
                  </button>
                </>
              ) : (
                <>
                  <div className="field" style={{ marginBottom: 6 }}>
                    <textarea
                      className="input"
                      rows={4}
                      style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12.5, resize: "vertical" }}
                      value={bulkBotText}
                      onChange={(e) => setBulkBotText(e.target.value)}
                      placeholder={
                        "Paste multiple bot tokens (one per line or Label | Token):\n123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ...\nWorker Bot 2 | 987654321:ZYXwvuTSRqpONMlkjIHGfedCBA..."
                      }
                    />
                  </div>
                  <p className="text-muted" style={{ fontSize: 12, marginBottom: 10 }}>
                    All tokens will be verified with Telegram and saved to your Connected Bots list at once.
                  </p>
                  {botError && (
                    <div style={{ marginBottom: 10 }}>
                      <PermissionErrorBanner reason="unknown" description={botError} />
                    </div>
                  )}
                  <button
                    className="btn btn-primary"
                    disabled={!bulkBotText.trim() || savingBot}
                    onClick={handleBulkAddBotsInWizard}
                  >
                    {savingBot ? "Verifying & Saving All Bots…" : "Verify & Save All Bot Tokens"}
                  </button>
                </>
              )}

              {bulkBotResult && (
                <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted)" }}>
                  Saved {bulkBotResult.created + bulkBotResult.existing} of {bulkBotResult.total} bots.
                </div>
              )}
            </div>
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
                flexWrap: "wrap",
                gap: 8,
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
              <span>2. Source Chat / Channel (1 Source)</span>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setShowInlineChannelAdd((s) => !s)}
            >
              {showInlineChannelAdd ? "Close Bulk Save" : "+ Bulk Save Channels"}
            </button>
          </div>

          {showInlineChannelAdd && (
            <div
              style={{
                marginBottom: 16,
                padding: "12px 14px",
                background: "var(--surface-raised)",
                border: "1px solid var(--accent-border)",
                borderRadius: "var(--radius)",
              }}
            >
              <label style={{ fontWeight: 600, fontSize: 12.5, display: "block", marginBottom: 6 }}>
                📢 Bulk Add Channels to Saved Library (one per line or Label | Chat ID)
              </label>
              <textarea
                className="input"
                rows={4}
                style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12, marginBottom: 8, resize: "vertical" }}
                value={inlineChannelText}
                onChange={(e) => setInlineChannelText(e.target.value)}
                placeholder={
                  "-1001234567890 | Main Source Channel\n-1009876543210 | Target Channel 1\n-1001122334455 | Target Channel 2"
                }
              />
              <div className="row" style={{ gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!inlineChannelText.trim() || savingInlineChannels}
                  onClick={handleSaveInlineChannels}
                >
                  {savingInlineChannels ? "Saving…" : "Save Channels to Library"}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => navigate("channels")}
                >
                  Open Saved Channels Page →
                </button>
              </div>
            </div>
          )}

          {/* Saved Channels Selector (Displayed just like Saved Bots!) */}
          {savedChannels && savedChannels.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div className="field" style={{ marginBottom: 8 }}>
                <label style={{ fontWeight: 600 }}>Select Source from Saved Channels ({savedChannels.length})</label>
                <select
                  className="input"
                  value={
                    savedChannels.some((c) => c.chat_id === sourceChatId)
                      ? sourceChatId
                      : ""
                  }
                  onChange={(e) => {
                    if (e.target.value) {
                      lookupSourceById(e.target.value);
                    }
                  }}
                >
                  <option value="">Choose a saved channel…</option>
                  {savedChannels.map((ch) => (
                    <option key={ch.id} value={ch.chat_id}>
                      {ch.title} ({ch.username ? `@${ch.username} · ` : ""}{ch.chat_id})
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {savedChannels.map((ch) => {
                  const isCurrentSource =
                    sourceChatId === ch.chat_id ||
                    (sourceLookup && String(sourceLookup.chat.id) === ch.chat_id);
                  return (
                    <button
                      key={ch.id}
                      type="button"
                      className={`btn btn-sm ${isCurrentSource ? "btn-primary" : "btn-secondary"}`}
                      style={{ fontSize: 12 }}
                      onClick={() => lookupSourceById(ch.chat_id)}
                    >
                      📢 {ch.title}{" "}
                      <span style={{ opacity: 0.75, fontSize: 11 }}>
                        ({ch.username ? `@${ch.username}` : ch.chat_id})
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="field">
            <label>Or Enter Source Chat ID / @username</label>
            <div className="row">
              <input
                className="input"
                style={{ flex: 1 }}
                value={sourceChatId}
                onChange={(e) => setSourceChatId(e.target.value)}
                placeholder="e.g. -1001234567890 or @channel"
              />
              <button className="btn btn-secondary" disabled={!sourceChatId || lookingUpSource} onClick={lookupSource}>
                {lookingUpSource ? "Checking…" : "Check & Save"}
              </button>
            </div>
          </div>

          {sourceError && <PermissionErrorBanner reason={sourceError.reason} description={sourceError.description} />}

          {sourceLookup && (
            <div style={{ marginTop: 14 }}>
              <div style={{ background: "var(--surface-raised)", borderRadius: "var(--radius)", padding: "12px 14px", marginBottom: 14 }}>
                <p style={{ fontWeight: 700, fontSize: 14 }}>
                  {sourceLookup.chat.title ?? sourceLookup.chat.id}
                </p>
                <p className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>
                  {sourceLookup.chat.type} · ID: <span className="text-mono">{sourceLookup.chat.id}</span> · bot status: <strong>{sourceLookup.botStatus}</strong>
                  {sourceLookup.memberCount !== undefined && ` · ${sourceLookup.memberCount} members`}
                </p>
              </div>

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
                        Telegram prevents bots from seeing or copying messages sent by other bots in group chats (anti-loop policy). If this group relies on other bots to post files or messages, those bot-authored messages will not be copyable.
                      </p>
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
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {sourceLookup.pastTasks.slice(0, 5).map((pt) => {
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
                            <span>Copied: <strong>{pt.processed} msgs</strong></span>
                            {pt.last_copied_message_id != null && (
                              <>
                                <span>·</span>
                                <span>Last ID: <strong style={{ color: "var(--accent)" }}>#{pt.last_copied_message_id}</strong></span>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
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

      {/* Step 3: Multi-Target Destinations & Copy Config (1 Source -> 1 Bot -> Many Targets) */}
      {sourceLookup && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <span className={`step-pill ${verifiedTargets.length > 0 ? "done" : "active"}`}>
                {verifiedTargets.length > 0 ? "✓" : "3"}
              </span>
              <span>3. Target Channels & Sync Mode (1 Source → Many Targets)</span>
            </div>
            {verifiedTargets.length > 0 && (
              <span className="badge badge-live">
                {verifiedTargets.length} Target{verifiedTargets.length === 1 ? "" : "s"} Ready
              </span>
            )}
          </div>

          {/* Saved Channels Multi-Selector for Targets */}
          {availableTargetChannels.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
                <label style={{ margin: 0, fontWeight: 600, fontSize: 13 }}>
                  Select Target(s) from Saved Channels ({availableTargetChannels.length} available)
                </label>
                <div className="row" style={{ gap: 6 }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ fontSize: 11.5, padding: "3px 8px" }}
                    onClick={selectAllSavedChannelsAsTargets}
                  >
                    ✓ Select All Saved Channels
                  </button>
                  {targets.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ fontSize: 11.5, padding: "3px 8px" }}
                      onClick={() => setTargets([])}
                    >
                      Clear Targets
                    </button>
                  )}
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {availableTargetChannels.map((ch) => {
                  const selected = isChannelSelectedAsTarget(ch);
                  return (
                    <button
                      key={ch.id}
                      type="button"
                      className={`btn btn-sm ${selected ? "btn-primary" : "btn-secondary"}`}
                      style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}
                      onClick={() => toggleSavedChannelTarget(ch)}
                    >
                      <span>{selected ? "☑" : "☐"}</span>
                      <span>📢 {ch.title}</span>
                      <span style={{ opacity: 0.75, fontSize: 11 }}>
                        ({ch.username ? `@${ch.username}` : ch.chat_id})
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Manual Single or Multi-Target Input */}
          <div className="field">
            <label>Add Target Chat ID(s) or @username(s) (comma-separated or multiple lines)</label>
            <div className="row" style={{ alignItems: "flex-start" }}>
              <textarea
                className="input"
                rows={2}
                style={{ flex: 1, fontFamily: "var(--font-mono, monospace)", fontSize: 12.5, resize: "vertical" }}
                value={destInput}
                onChange={(e) => setDestInput(e.target.value)}
                placeholder="e.g. -1009876543210, -1001122334455 or @destchannel1, @destchannel2"
              />
              <button
                className="btn btn-secondary"
                disabled={!destInput.trim()}
                onClick={handleAddTargetsFromInput}
              >
                + Check & Add Target(s)
              </button>
            </div>
          </div>

          {/* Selected Target Channels List */}
          {targets.length > 0 && (
            <div style={{ marginTop: 12, marginBottom: 18 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8, color: "var(--muted)" }}>
                Selected Target Channels ({verifiedTargets.length} verified of {targets.length}):
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {targets.map((t) => {
                  const canPost = t.lookup?.capabilities.find((c) => c.key === "send_message")?.available;
                  return (
                    <div
                      key={t.key}
                      style={{
                        padding: "10px 14px",
                        background: "var(--surface-raised)",
                        border: t.error
                          ? "1px solid var(--danger)"
                          : canPost
                          ? "1px solid color-mix(in oklab, var(--success) 35%, transparent)"
                          : "1px solid var(--border-subtle)",
                        borderRadius: "var(--radius)",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 10,
                        flexWrap: "wrap",
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 200 }}>
                        {t.loading ? (
                          <span className="text-muted" style={{ fontSize: 12.5 }}>
                            Checking permissions for <strong>{t.labelHint ?? t.inputChatId}</strong>…
                          </span>
                        ) : t.lookup ? (
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                              🎯 {t.lookup.chat.title ?? t.lookup.chat.id}{" "}
                              <span className="text-mono text-muted" style={{ fontWeight: 400, fontSize: 12 }}>
                                ({t.lookup.chat.id})
                              </span>
                            </div>
                            <div style={{ fontSize: 12, marginTop: 2, color: canPost ? "var(--success)" : "var(--danger)" }}>
                              {canPost
                                ? `✓ Bot can post here (${t.lookup.chat.type} · ${t.lookup.botStatus})`
                                : `✗ Bot lacks permission to post here (${t.lookup.botStatus})`}
                            </div>
                          </div>
                        ) : (
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 13, color: "var(--danger)" }}>
                              ✗ {t.labelHint ? `${t.labelHint} (${t.inputChatId})` : t.inputChatId}
                            </div>
                            <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 2 }}>
                              {t.error?.description ?? "Could not verify target chat"}
                            </div>
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => removeTarget(t.key)}
                        title="Remove target"
                      >
                        ✕ Remove
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {verifiedTargets.length > 0 && (
            <>
              <div
                style={{
                  padding: "10px 14px",
                  background: "var(--accent-tint)",
                  border: "1px solid var(--accent-border)",
                  borderRadius: "var(--radius)",
                  fontSize: 12.5,
                  marginBottom: 16,
                }}
              >
                <strong>Pipeline Topology:</strong>{" "}
                <span>{sourceLookup.chat.title ?? sourceLookup.chat.id}</span> →{" "}
                <strong>@{selectedBot?.bot_username ?? pendingBot?.bot_username}</strong> →{" "}
                <strong>
                  {verifiedTargets.length} Target Channel{verifiedTargets.length === 1 ? "" : "s"}
                </strong>{" "}
                ({verifiedTargets.map((t) => t.lookup?.chat.title ?? t.inputChatId).join(", ")})
              </div>

              <div className="field">
                <label>Copy Scope</label>
                <select className="input" value={scope} onChange={(e) => setScope(e.target.value as TaskScope)}>
                  <option value="live">New messages only (Live forward)</option>
                  <option value="live_and_backfill">✨ Existing + New (Catch-Up Stream)</option>
                  <option value="backfill_only">Existing only (One-time history backfill)</option>
                </select>
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
                    ⚡ Bulk backfill pace: 60 messages/minute shared cleanly across active target channels on this bot.
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
                  placeholder="Message ID (optional)"
                  value={testMessageId}
                  onChange={(e) => setTestMessageId(e.target.value)}
                />
                <button className="btn btn-secondary" disabled={testingCopy} onClick={runTestCopy}>
                  {testingCopy
                    ? "Sending…"
                    : verifiedTargets.length > 1
                    ? `Send test copy to all ${verifiedTargets.length} targets`
                    : "Send test copy"}
                </button>
              </div>
              {testCopyResult && (
                <p className="text-muted" style={{ fontSize: 12, marginTop: 8 }}>
                  {testCopyResult}
                </p>
              )}

              {batchDuplicates.length > 0 && (
                <div className="permission-banner" style={{ marginTop: 16 }}>
                  <span>⚠</span>
                  <div>
                    Task(s) for{" "}
                    <strong>
                      {batchDuplicates.map((d) => d.destChatTitle ?? d.destChatId).join(", ")}
                    </strong>{" "}
                    already exist.{" "}
                    <button
                      className="btn btn-danger btn-sm"
                      style={{ marginTop: 8 }}
                      onClick={() => createTasksBatch(true, lastSaveTemplate)}
                    >
                      Create anyway
                    </button>
                  </div>
                </div>
              )}

              <div className="row" style={{ marginTop: 24 }}>
                <button
                  className="btn btn-primary"
                  disabled={creating || verifiedTargets.length === 0}
                  onClick={() => createTasksBatch(false, false)}
                >
                  {creating && !lastSaveTemplate
                    ? "Creating…"
                    : verifiedTargets.length > 1
                    ? `Create ${verifiedTargets.length} Tasks (1 Source → ${verifiedTargets.length} Targets)`
                    : "Create Task"}
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={creating || verifiedTargets.length === 0}
                  onClick={() => createTasksBatch(false, true)}
                >
                  {creating && lastSaveTemplate
                    ? "Saving…"
                    : verifiedTargets.length > 1
                    ? `Save Templates & Start All (${verifiedTargets.length})`
                    : "Save & Start"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
