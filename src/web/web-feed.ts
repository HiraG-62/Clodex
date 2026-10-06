// Web UI へ送る feed（DESIGN.md §17 Web UI）。event と output は直近を保持し、接続時に送り直す
import type { AgentId } from "../agents/agent-adapter.js";
import type { AgentState } from "../cli/shell.js";
import type { CoordinatorEvent } from "../coordinator/event-bus.js";
import type { Conversation } from "../project/conversation-history.js";

export const DEFAULT_RECENT_ITEMS = 1000;
export const INITIAL_HISTORY_ITEMS = 200;
export const HISTORY_PAGE_ITEMS = 200;

import type { PendingInput } from "../cli/shell.js";
import type { ConversationActivity } from "../hub/workspace.js";

export interface WebState {
  project: string;
  projects?: Array<{ projectRoot: string; open: boolean; current: boolean }>;
  primary: AgentId;
  roles: Partial<Record<AgentId, string>>;
  agents: AgentState[];
  // activity: 動いている会話の状態（無ければ保存のみ。DESIGN.md §28 D1）
  conversations: Array<Conversation & { current: boolean; activity?: ConversationActivity }>;
  // 配送待ちの人間の入力（取り消し・編集の対象）
  pendingInputs: PendingInput[];
  processes: Array<{ id: number; command: string; status: "running" | "exited" | "stopped" }>;
}

export type FeedItem =
  | { type: "event"; seq: number; event: CoordinatorEvent; envelope?: string }
  | { type: "output"; seq: number; text: string }
  | { type: "state"; state: WebState }
  | { type: "toast"; text: string; level: "info" | "warn" }
  | { type: "reset" }
  // 接続のたびに最初に送る。画面の版が違えば再読み込みする
  | { type: "version"; version: string };

export type HistoryItem = Extract<FeedItem, { type: "event" | "output" }>;
export interface HistoryPage { items: HistoryItem[]; hasMore: boolean; }
export type FeedHandler = (item: FeedItem) => void;

export class WebFeed {
  private readonly items: HistoryItem[] = [];
  private readonly handlers = new Set<FeedHandler>();
  private seq = 0;
  private state: WebState | undefined;

  // onRecord: 新しく publish した event / output を受け取る（保存用）
  constructor(
    private readonly limit = DEFAULT_RECENT_ITEMS,
    private readonly onRecord: (item: HistoryItem) => void = () => {},
  ) {}

  publishEvent(event: CoordinatorEvent, envelope?: string): void {
    this.record({ type: "event", seq: ++this.seq, event, ...(envelope ? { envelope } : {}) });
  }

  publishOutput(text: string): void {
    this.record({ type: "output", seq: ++this.seq, text });
  }

  private record(item: HistoryItem): void {
    this.onRecord(item);
    this.remember(item);
  }

  publishToast(text: string, level: "info" | "warn" = "info"): void {
    this.deliver({ type: "toast", text, level });
  }

  publishState(state: WebState): void {
    this.state = state;
    this.deliver({ type: "state", state });
  }

  // 会話の切り替え: 画面にログを消させ、切り替え先の履歴を送り直す
  replace(items: readonly HistoryItem[]): void {
    this.items.splice(0);
    this.deliver({ type: "reset" });
    this.items.push(...items.slice(-this.limit).map((item) => ({ ...item, seq: ++this.seq })));
    for (const item of this.recent()) this.deliver(item);
  }

  recent(): HistoryItem[] {
    return this.items.slice(-INITIAL_HISTORY_ITEMS);
  }

  before(seq: number, limit = HISTORY_PAGE_ITEMS): HistoryPage {
    const size = Number.isNaN(limit) ? HISTORY_PAGE_ITEMS : Math.max(1, Math.min(HISTORY_PAGE_ITEMS, Math.floor(limit)));
    const older = this.items.filter((item) => item.seq < seq);
    return { items: older.slice(-size), hasMore: older.length > size };
  }

  latestState(): WebState | undefined {
    return this.state;
  }

  subscribe(handler: FeedHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private remember(item: HistoryItem): void {
    this.items.push(item);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    this.deliver(item);
  }

  private deliver(item: FeedItem): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(item);
      } catch {
        // 切断済みのクライアント等。他のクライアントへの配信は続ける
      }
    }
  }
}
