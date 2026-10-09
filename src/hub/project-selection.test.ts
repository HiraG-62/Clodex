import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type FeedItem, WebFeed } from "../web/web-feed.js";
import { Hub } from "./hub.js";
import { selectProject } from "./project-selection.js";

describe("selectProject", () => {
  it("切り替えた project の feed で画面を reset し、元へ戻せる", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "clodex-project-feed-"));
    const feed = new WebFeed();
    const received: FeedItem[] = [];
    feed.subscribe(item => received.push(item));
    const hub = new Hub({
      homeDir,
      cwd: homeDir,
      openProject: async (projectRoot: string) => ({
        projectRoot,
        close: async () => {},
        showFeed: (target: WebFeed) => target.replace([{ type: "output", seq: 0, text: projectRoot }]),
      }),
    });

    await selectProject(hub, feed, "one");
    await selectProject(hub, feed, "two");
    expect(received.filter(item => item.type === "reset")).toHaveLength(2);
    expect(feed.recent().map(item => (item.type === "output" ? item.text : ""))).toEqual([hub.current?.projectRoot]);
    await selectProject(hub, feed, "one");
    expect(feed.recent().map(item => (item.type === "output" ? item.text : ""))).toEqual([hub.current?.projectRoot]);
    expect(hub.list().filter(project => project.open)).toHaveLength(2);
  });
});
