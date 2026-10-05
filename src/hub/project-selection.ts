// project の選択と画面の履歴の切り替えを同じ操作にする（DESIGN.md §28 D2a）
import type { WebFeed } from "../web/web-feed.js";
import type { Hub, HubProject } from "./hub.js";

export interface FeedProject extends HubProject {
  showFeed(feed: WebFeed): void;
}

export const selectProject = async <T extends FeedProject>(hub: Hub<T>, feed: WebFeed, path: string): Promise<T> => {
  const context = await hub.open(path);
  context.showFeed(feed);
  return context;
};
