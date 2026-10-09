import type { AgentId } from "../../agents/agent-adapter.js";
import type { AgentState } from "../../cli/shell.js";
import type { ClientContext } from "./store.js";
import type { DisplayTimelineItem } from "./timeline.js";

export function createStoreInit(ctx: ClientContext) {
  // ---- 状態 ----
  ctx.store.items = [];
  ctx.store.history = [];
  ctx.store.historyHasMore = true;
  ctx.store.historyLoading = false;
  ctx.store.historyGeneration = 0;
  ctx.store.questionDrafts = new Map<string, { selected: Set<number>[]; other: string[]; step: number }>();

  ctx.store.pendingSettings = {};
  ctx.store.pendingDeadlines = {};
  ctx.store.settingRequests = new Map<string, symbol>();
  ctx.store.reloading = false;
  ctx.store.pendingRequests = new Set<string>();
  ctx.store.interrupting = new Set<AgentId>();
  ctx.store.interruptAttempts = new Map<AgentId, symbol>();
  ctx.store.uploading = 0;
  ctx.store.commandStarts = {};
  ctx.store.startingAt = new Map<AgentId, string>();
  ctx.store.replaying = true;
  ctx.store.incomingHistory = [];
  ctx.store.replayScheduled = false;
  ctx.store.liveGeneration = 0;
  ctx.store.detail = ctx.storage.get(ctx.DETAIL_KEY) === "1";
  // undefined なら primary に送る
  ctx.store.opened = new Map<string, boolean>(); // 人が開閉した details の状態（項目 ID ごと）
  ctx.store.rendered = new Map<string, { item: DisplayTimelineItem; node: HTMLElement }>();
  ctx.store.controlUpdaters = new WeakMap<HTMLElement, (agent: AgentState) => void>();

  const log = ctx.$("#log");
  const announcements = ctx.$("#announcements");

  const newer = ctx.$("#newer");
  ctx.store.unreadWhileReading = false;
  const input = document.querySelector<HTMLTextAreaElement>("#input")!;
  return { log, newer, input, announcements };
}
