import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Hub } from "./hub.js";
import { saveRecovery } from "../project/recovery-store.js";
import { ConversationHistory, conversationStatePath } from "../project/conversation-history.js";

const setup = () => {
  const homeDir = mkdtempSync(join(tmpdir(), "clodex-hub-"));
  const opened: string[] = [];
  const hub = new Hub({ homeDir, cwd: homeDir, openProject: async (projectRoot: string) => {
    opened.push(projectRoot);
    return { projectRoot, close: async () => {} };
  } });
  return { homeDir, hub, opened };
};

describe("Hub", () => {
  it("閉じた project の固定した会話を一覧に出し、Agent を開かずに固定を外す", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "clodex-tab-hub-"));
    const opened: string[] = [];
    const makeHub = () => new Hub({ homeDir, cwd: homeDir, openProject: async (projectRoot: string) => {
      opened.push(projectRoot);
      return { projectRoot, history: new ConversationHistory(conversationStatePath(homeDir, projectRoot), { resumeLatest: false }), close: async () => {} };
    } });
    const first = makeHub();
    const context = await first.open("one");
    context.history.rename("固定した会話");
    const id = context.history.currentId;
    context.history.togglePin(id);
    const second = makeHub();
    const source = (project: typeof context) => ({ conversations: project.history.list(), current: project.history.current });
    expect(second.tabs(source)).toMatchObject([{ projectRoot: context.projectRoot, conversationId: id, pinned: true }]);
    expect(second.unpinConversation(context.projectRoot, id, (project) => project.history)).toBe(false);
    expect(second.tabs(source)).toEqual([]);
    expect(opened).toHaveLength(1);
    const saved = new ConversationHistory(conversationStatePath(homeDir, context.projectRoot), { resumeLatest: false }).list();
    expect(saved.map((conversation) => conversation.id)).toEqual([id]);
    expect(saved[0]).not.toHaveProperty("pinned");
  });
  it("保存済み project のうち復旧する作業があるものだけ列挙する", async () => {
    const { homeDir, hub } = setup();
    await hub.open("one");
    await hub.open("two");
    const [one, two] = hub.list().map(({ projectRoot }) => projectRoot);
    saveRecovery(homeDir, one!, { current: "c1", conversations: { c1: { interrupted: ["claude"], queue: { claude: [], codex: [] } } } });
    saveRecovery(homeDir, two!, { current: "c2", conversations: {} });
    const next = new Hub({ homeDir, cwd: homeDir, openProject: async (projectRoot) => ({ projectRoot, close: async () => {} }) });
    expect(next.recoveryProjects()).toEqual([one]);
  });
  it("project を開いて切り替えても既存の context を保持する", async () => {
    const { homeDir, hub, opened } = setup();
    const first = await hub.open("one");
    await hub.open("two");
    expect(hub.lastProject).toBe(resolve(homeDir, "two"));
    expect(hub.current?.projectRoot).toBe(resolve(opened[1]!));
    expect(hub.list().filter((project) => project.open)).toHaveLength(2);
    expect(await hub.open("one")).toBe(first);
    expect(opened).toHaveLength(2);
  });

  it("開いた一覧と最後の project を保存し、次の起動では一覧だけ読む", async () => {
    const { homeDir, hub } = setup();
    await hub.open("one");
    await hub.open("two");
    const saved = JSON.parse(readFileSync(join(homeDir, ".clodex", "hub.json"), "utf8"));
    expect(saved.projects).toEqual([resolve(homeDir, "one"), resolve(homeDir, "two")]);
    expect(saved.lastProject).toBe(resolve(homeDir, "two"));
    const next = new Hub({ homeDir, cwd: homeDir, openProject: async (projectRoot: string) => ({ projectRoot, close: async () => {} }) });
    expect(next.current).toBeUndefined();
    expect(next.lastProject).toBe(resolve(homeDir, "two"));
    expect(next.list().every((project) => !project.open)).toBe(true);
  });

  it("ピン止めした project を先に並べ、ピン止めを保存する", async () => {
    const { homeDir, hub } = setup();
    await hub.open("one");
    await hub.open("two");
    await hub.open("three");
    const [one, two, three] = [resolve(homeDir, "one"), resolve(homeDir, "two"), resolve(homeDir, "three")];
    expect(hub.togglePin(three)).toBe(true);
    expect(hub.list().map(({ projectRoot, pinned }) => [projectRoot, pinned])).toEqual([[three, true], [one, false], [two, false]]);
    const next = new Hub({ homeDir, cwd: homeDir, openProject: async (projectRoot: string) => ({ projectRoot, close: async () => {} }) });
    expect(next.list().map(({ projectRoot }) => projectRoot)).toEqual([three, one, two]);
    expect(next.togglePin(three)).toBe(false);
    expect(next.list()[0]).toMatchObject({ projectRoot: one, pinned: false });
    expect(next.togglePin(resolve(homeDir, "missing"))).toBeUndefined();
  });

  it("開いていない project だけ一覧から外せ、外したものも開けば戻る", async () => {
    const { homeDir, hub } = setup();
    await hub.open("one");
    await hub.open("two");
    const [one, two] = [resolve(homeDir, "one"), resolve(homeDir, "two")];
    expect(hub.remove(two)).toBe("open");
    expect(hub.remove(resolve(homeDir, "missing"))).toBe("missing");
    const next = new Hub({ homeDir, cwd: homeDir, openProject: async (projectRoot: string) => ({ projectRoot, close: async () => {} }) });
    next.togglePin(one);
    expect(next.remove(one)).toBeUndefined();
    expect(next.list().map(({ projectRoot }) => projectRoot)).toEqual([two]);
    const saved = JSON.parse(readFileSync(join(homeDir, ".clodex", "hub.json"), "utf8"));
    expect(saved).toMatchObject({ projects: [two], pinned: [] });
    await next.open("one");
    expect(next.list().map(({ projectRoot }) => projectRoot)).toEqual([two, one]);
  });
});
