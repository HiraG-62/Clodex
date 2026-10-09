// 会話切り替え時の feed の読み込みと古い会話の整理
import type { AgentId } from "../agents/agent-adapter.js";
import type { HistoryItem } from "./web-feed.js";

interface HistorySource {
  readonly currentId: string;
  list(): Array<{ id: string }>;
  onSwitch(listener: (id: string) => void): void;
  onRemove(listener: (id: string) => void): void;
}

interface FeedSource {
  prune(keepIds: readonly string[]): void;
  load(conversationId: string, working: ReadonlySet<AgentId>): HistoryItem[];
}

interface FeedTarget {
  replace(items: readonly HistoryItem[]): void;
}

export const connectConversationFeed = (
  history: HistorySource,
  store: FeedSource,
  feed: FeedTarget,
  working: (id: string) => ReadonlySet<AgentId> = () => new Set(),
): void => {
  const load = (id: string) => {
    store.prune([id, ...history.list().map(conversation => conversation.id)]);
    feed.replace(store.load(id, working(id)));
  };
  load(history.currentId);
  history.onSwitch(load);
  // 削除した会話の feed も消す（今の会話は残す）
  history.onRemove(() => store.prune([history.currentId, ...history.list().map(conversation => conversation.id)]));
};
