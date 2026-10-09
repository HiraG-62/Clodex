import type { HubNotification } from "../../hub/notify-format.js";
import type { FeedItem } from "../web-feed.js";
import { draftKey, staleDraftKeys } from "./drafts.js";
import { nextCommandStarts, resolvePendingSettings } from "./pending.js";
import { connectionQuery } from "./connection-query.js";
import type { ClientContext } from "./store.js";
import type { TimelineItem } from "./timeline.js";
import { announcementKind, applyFeedItem, limitLiveHistory, mergeReplayHistory, rebuildTimeline, withStartingTurns } from "./timeline.js";

export function createConnection(ctx: ClientContext) {


  // ---- 接続 ----
  // 指定しないと Tauri の通知は無音になる
  const NOTIFICATION_SOUND = "Default";
  const notify = async (notification: HubNotification) => {
    const plugin = (window as Window & { __TAURI__?: { notification?: {
      isPermissionGranted(): Promise<boolean>;
      requestPermission(): Promise<string>;
      sendNotification(notification: Pick<HubNotification, "title" | "body"> & { sound: string }): void | Promise<void>;
    } } }).__TAURI__?.notification;
    if (!plugin || (!document.hidden && document.hasFocus())) return;
    try {
      const granted = await plugin.isPermissionGranted() || await plugin.requestPermission() === "granted";
      if (granted && (document.hidden || !document.hasFocus())) await plugin.sendNotification({ title: notification.title, body: notification.body, sound: NOTIFICATION_SOUND });
    } catch { /* 通知の失敗で feed の描画を止めない */ }
  };
  const conn = ctx.$("#conn");
  const commitReplay = () => {
    if (!ctx.store.replaying) return;
    const merged = mergeReplayHistory(ctx.store.history, ctx.store.incomingHistory);
    ctx.store.replayAnchor = merged.preserved && !ctx.nearBottom() ? [...ctx.store.rendered].map(([id, entry]) => ({ id, top: entry.node.getBoundingClientRect().top }))
      .find(({ top }) => top >= ctx.log.getBoundingClientRect().top) : undefined;
    ctx.store.history = merged.history;
    ctx.store.incomingHistory = [];
    ctx.store.items = rebuildTimeline(ctx.store.history, applyFeedItem).map((item) => item.kind === "human" ? { ...item, queued: true } : item);
    if (!merged.preserved) ctx.store.opened.clear();
    ctx.store.historyGeneration++;
    ctx.store.historyLoading = false;
    if (!merged.preserved) ctx.store.historyHasMore = true;
    ctx.store.commandStarts = {};
    ctx.store.replaying = false;
  };
  const scheduleLog = () => {
    if (ctx.store.replayScheduled) return;
    ctx.store.replayScheduled = true;
    requestAnimationFrame(() => { ctx.store.replayScheduled = false; if (!ctx.store.replaying) ctx.renderLog(); });
  };
  ctx.$("#reload").addEventListener("click", () => location.reload());
  const connect = () => {
    const query = connectionQuery(ctx.store.guiVersion, ctx.store.pushId, document.visibilityState);
    const events = new EventSource(query.toString() ? `/events?${query}` : "/events");
    events.onopen = () => {
      ctx.store.replaying = true;
      ctx.store.historyGeneration++;
      ctx.store.historyLoading = false;
      ctx.$("#history-loading").hidden = true;
      ctx.store.incomingHistory = [];
    };
    events.onmessage = (e: MessageEvent<string>) => {
      if (ctx.store.reloading) return;
      const item = JSON.parse(e.data) as FeedItem;
      if (item.type === "notify") {
        ctx.showToast(item.notification.body,
          ["failed", "interrupted", "limitHold", "error"].includes(item.notification.kind) ? "warn" : "info", item.notification.title);
        void notify(item.notification);
        return;
      }
      if (item.type === "version") {
        if (item.version !== ctx.version) {
          ctx.store.reloading = true;
          conn.hidden = false;
          ctx.$("#conn-label").textContent = ctx.t("web.conn.updated");
          ctx.$(".app").classList.add("navigation-pending");
          window.setTimeout(() => location.reload(), ctx.RELOAD_DELAY_MS);
        }
        return;
      }
      if (item.type === "state") {
        const projectChanged = ctx.store.state?.project !== item.state.project;
        const conversationChanged = ctx.store.state?.conversations.find((entry) => entry.current)?.id !== item.state.conversations.find((entry) => entry.current)?.id;
        if (projectChanged || conversationChanged) {
          ctx.store.liveGeneration++;
          ctx.store.startingAt.clear();
          ctx.closeUsage();
          ctx.store.pendingSettings = {};
          ctx.store.pendingDeadlines = {};
          ctx.store.settingRequests.clear();
          ctx.store.interrupting.clear();
          if (projectChanged) {
            ctx.store.files = []; ctx.store.fileSet.clear(); ctx.store.filesLoadedAt = 0; ctx.store.filesLoading = false; ctx.store.filesGeneration++;
            ctx.store.target = undefined; ctx.store.pendingPrimary = undefined;
          }
          ctx.closeSheet();
        }
        commitReplay();
        ctx.store.state = item.state;
        const projectRoot = ctx.store.state.projects?.find((project) => project.current)?.projectRoot;
        const conversationId = ctx.store.state.conversations.find((conversation) => conversation.current)?.id;
        const nextDraftKey = projectRoot && conversationId ? draftKey(projectRoot, conversationId) : undefined;
        if (ctx.store.currentDraftKey !== nextDraftKey) {
          if (ctx.store.currentDraftKey) ctx.saveDraft(ctx.store.currentDraftKey, ctx.input.value);
          ctx.store.currentDraftKey = nextDraftKey;
          ctx.input.value = nextDraftKey ? ctx.storage.get(nextDraftKey) ?? "" : "";
          ctx.onInputChanged();
        }
        if (projectRoot) {
          for (const key of staleDraftKeys(ctx.storage.keys(), projectRoot, ctx.store.state.conversations.map((conversation) => conversation.id))) ctx.storage.remove(key);
        }
        ctx.store.pendingSettings = resolvePendingSettings(ctx.store.pendingSettings, ctx.store.state.agents, ctx.store.pendingDeadlines);
        for (const agent of ctx.store.state.agents) if (agent.status !== "busy") ctx.store.interrupting.delete(agent.id);
        if (ctx.store.pendingPrimary && ctx.store.state.primary === ctx.store.pendingPrimary) {
          if (ctx.store.target === ctx.store.pendingPrimary) ctx.store.target = undefined;
          ctx.store.pendingPrimary = undefined;
        }
        ctx.$(".app").classList.remove("initial-loading");
        ctx.$(".app").setAttribute("aria-busy", "false");
        conn.hidden = true;
        ctx.$("#reload").hidden = true;
        ctx.$("#conn-spinner").hidden = false;
        ctx.renderState();
        ctx.renderLog();
        if (ctx.store.replayAnchor) {
          const node = ctx.store.rendered.get(ctx.store.replayAnchor.id)?.node;
          if (node) ctx.log.scrollTop += node.getBoundingClientRect().top - ctx.store.replayAnchor.top;
          ctx.store.replayAnchor = undefined;
          ctx.syncNewer();
        }
        if (projectChanged && document.activeElement === ctx.input) void ctx.loadFiles();
        return;
      }
      if (item.type === "toast") { ctx.showToast(item.text, item.level); return; }
      if (item.type === "gui") { ctx.store.gui = item.gui; ctx.refreshOpenSheet(); return; }
      if (item.type === "gui_command") { void ctx.runGuiCommand(item.action); return; }
      if (item.type === "reset") {
        ctx.store.incomingHistory = [];
        ctx.store.historyGeneration++;
        ctx.store.historyLoading = false;
        ctx.$("#history-loading").hidden = true;
        ctx.store.replaying = true;
        ctx.store.questionDrafts.clear();
        ctx.store.opened.clear();
        ctx.store.unreadWhileReading = false;
        return;
      }
      if (ctx.store.replaying) { ctx.store.incomingHistory.push(item); return; }
      const announcement = announcementKind(item);
      if (announcement && item.type === "event") {
        const agent = item.event.kind === "question" ? item.event.agent : item.event.kind === "agent" ? item.event.agent : undefined;
        if (agent) ctx.announcements.textContent = `${ctx.AGENTS[agent].name}: ${ctx.t(`notify.${announcement}`)}`;
      }
      if (!ctx.nearBottom()) ctx.store.unreadWhileReading = true;
      ctx.store.history = limitLiveHistory(ctx.store.history, item);
      ctx.store.items = applyFeedItem(ctx.store.items, item);
      if (item.type === "output") ctx.store.commandStarts = nextCommandStarts(ctx.store.commandStarts, item.command, new Date().toISOString(), ctx.store.items.at(-1)?.id);
      if (item.type === "event" && item.event.kind === "human") {
        ctx.store.items = withStartingTurns(ctx.store.items, ctx.store.state?.agents ?? [], item.event.at, ctx.store.state?.pendingInputs ?? []).filter((entry): entry is TimelineItem => entry.kind !== "starting" && entry.kind !== "subagents");
      }
      scheduleLog();
    };
    events.onerror = () => {
      if (ctx.store.reloading) return;
      conn.hidden = false;
      const closed = events.readyState === EventSource.CLOSED;
      ctx.$("#conn-label").textContent = closed ? ctx.t("web.conn.closed") : ctx.t("web.conn.lost");
      ctx.$("#reload").hidden = !closed;
      ctx.$("#conn-spinner").hidden = closed;
    };
  };
  // GUI の中の画面は、GUI の版を添えてつなぐ（Hub が更新の依頼をこの接続へ送る）
  void (ctx.tauriApi?.app?.getVersion() ?? Promise.resolve(undefined)).catch(() => undefined).then((version) => {
    ctx.store.guiVersion = version;
    connect();
  });
  return {  };
}
