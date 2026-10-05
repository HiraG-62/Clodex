// 会話切り替え時の feed の読み込みと古い会話の整理
import type { HistoryItem } from "./web-feed.js";

interface HistorySource {
  readonly currentId: string;
  list(): Array<{ id: string }>;
  onSwitch(listener: (id: string) => void): void;
}

interface FeedSource {
  prune(keepIds: readonly string[]): void;
  load(conversationId: string): HistoryItem[];
}

interface FeedTarget {
  replace(items: readonly HistoryItem[]): void;
}

export const connectConversationFeed = (history: HistorySource, store: FeedSource, feed: FeedTarget): void => {
  const load = (id: string) => {
    store.prune([id, ...history.list().map((conversation) => conversation.id)]);
    feed.replace(store.load(id));
  };
  load(history.currentId);
  history.onSwitch(load);
};
