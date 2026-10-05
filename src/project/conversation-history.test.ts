import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventBus } from "../coordinator/event-bus.js";
import { ConversationHistory, MAX_CONVERSATIONS, conversationStatePath } from "./conversation-history.js";

const HOME = "C:\\home";
const makePath = () => join(mkdtempSync(join(tmpdir(), "clodex-history-")), "nested", "state.json");

// 呼ぶたびに 1 分進む時計と連番 ID
const setup = (path = makePath(), resumeLatest = false, startMinute = 0) => {
  let minute = startMinute;
  let seq = 0;
  const history = new ConversationHistory(path, {
    resumeLatest,
    now: () => new Date(Date.UTC(2026, 9, 5, 10, minute++)),
    createId: () => `conv-${startMinute}-${++seq}`,
  });
  const bus = new EventBus();
  history.attach(bus);
  const session = (agent: "claude" | "codex", sessionId: string) =>
    bus.publish({ kind: "agent", agent, event: { type: "session", sessionId } });
  const human = (text: string) => bus.publish({ kind: "human", agent: "claude", text });
  return { history, path, session, human };
};

describe("conversationStatePath", () => {
  it("project root の英数字以外を - にした名前とパスのハッシュにする", () => {
    const path = conversationStatePath(HOME, "E:\\dev\\Clodex");
    expect(path.startsWith(join(HOME, ".clodex", "state"))).toBe(true);
    expect(basename(path)).toMatch(/^E--dev-Clodex-[0-9a-f]{8}\.json$/);
  });

  it("区切り文字と - だけが違う project は別のファイルになる", () => {
    expect(conversationStatePath(HOME, "C:\\a-b")).not.toBe(conversationStatePath(HOME, "C:\\a\\b"));
  });

  it("大文字小文字だけが違うパスは同じファイルになる", () => {
    expect(basename(conversationStatePath(HOME, "E:\\dev\\Clodex")).slice(-13))
      .toBe(basename(conversationStatePath(HOME, "e:\\dev\\clodex")).slice(-13));
  });
});

describe("ConversationHistory", () => {
  it("session と最初の人間の入力（60 文字まで）を今の会話として保存する", () => {
    const { history, path, session, human } = setup();
    human(`fix the bug ${"x".repeat(100)}`);
    human("second input");
    session("claude", "c-1");
    session("codex", "x-1");
    session("claude", "c-2");

    const [saved] = new ConversationHistory(path, { resumeLatest: false }).list();
    expect(saved).toMatchObject({ id: history.currentId, sessions: { claude: "c-2", codex: "x-1" } });
    expect(saved!.title).toBe(`fix the bug ${"x".repeat(48)}`);
    expect(JSON.parse(readFileSync(path, "utf8")).conversations).toHaveLength(1);
  });

  it("session も入力も無い会話は保存しない", () => {
    const { path } = setup();
    expect(new ConversationHistory(path, { resumeLatest: false }).list()).toEqual([]);
  });

  it("起動ごとに新しい会話になり、一覧は新しい順", () => {
    const first = setup(makePath(), false, 0);
    first.session("claude", "c-old");
    const second = setup(first.path, false, 10);
    second.session("claude", "c-new");

    const list = second.history.list();
    expect(list.map((c) => c.sessions.claude)).toEqual(["c-new", "c-old"]);
  });

  it("resumeLatest なら最新の会話を今の会話として続ける", () => {
    const first = setup();
    first.session("claude", "c-1");
    first.human("hello");
    const resumed = setup(first.path, true, 10);
    expect(resumed.history.currentId).toBe(first.history.currentId);
    expect(resumed.history.currentSessions).toEqual({ claude: "c-1" });

    resumed.session("codex", "x-1");
    expect(resumed.history.list()).toHaveLength(1);
    expect(resumed.history.list()[0]).toMatchObject({ title: "hello", sessions: { claude: "c-1", codex: "x-1" } });
  });

  it("resumeLatest でも保存が無ければ新しい会話", () => {
    const { history } = setup(makePath(), true);
    expect(history.currentSessions).toEqual({});
  });

  it("switchTo で選んだ会話を今の会話にし、以後の session はそちらに記録する", () => {
    const first = setup();
    first.session("claude", "c-old");
    const second = setup(first.path, false, 10);
    second.session("claude", "c-new");

    const old = second.history.list()[1]!;
    expect(second.history.switchTo(old.id)).toMatchObject({ sessions: { claude: "c-old" } });
    second.session("codex", "x-1");

    const list = second.history.list();
    expect(list.find((c) => c.id === old.id)!.sessions).toEqual({ claude: "c-old", codex: "x-1" });
    expect(list.find((c) => c.sessions.claude === "c-new")).toBeDefined();
  });

  it(`最大 ${MAX_CONVERSATIONS} 件まで残す`, () => {
    const path = makePath();
    for (let i = 0; i < MAX_CONVERSATIONS + 3; i++) setup(path, false, i * 10).session("claude", `c-${i}`);
    const list = new ConversationHistory(path, { resumeLatest: false }).list();
    expect(list).toHaveLength(MAX_CONVERSATIONS);
    expect(list[0]!.sessions.claude).toBe(`c-${MAX_CONVERSATIONS + 2}`);
  });

  it("壊れたファイルは空の履歴として扱う", () => {
    const path = makePath();
    setup(path).session("claude", "c-1");
    writeFileSync(path, "{ broken");
    expect(new ConversationHistory(path, { resumeLatest: false }).list()).toEqual([]);
  });
});
