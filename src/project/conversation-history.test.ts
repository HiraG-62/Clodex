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

  it("大文字小文字だけが違うパスはハッシュ部分が一致する", () => {
    expect(basename(conversationStatePath(HOME, "E:\\dev\\Clodex")).slice(-13))
      .toBe(basename(conversationStatePath(HOME, "e:\\dev\\clodex")).slice(-13));
  });
});

describe("ConversationHistory", () => {
  it("別プロセス相当の更新後に書くとき、他方の会話を消さない", () => {
    const path = makePath();
    const first = setup(path, false, 0);
    const second = setup(path, false, 10);
    first.session("claude", "c-first");
    second.session("codex", "x-second");
    first.human("first title");
    const saved = new ConversationHistory(path, { resumeLatest: false }).list();
    expect(saved.map((conversation) => conversation.id)).toContain(first.history.currentId);
    expect(saved.map((conversation) => conversation.id)).toContain(second.history.currentId);
    expect(saved.find((conversation) => conversation.id === first.history.currentId)?.title).toBe("first title");
  });
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

  it("startNew で新しい会話を始め、前の会話は履歴に残る", () => {
    const { history, session } = setup();
    session("claude", "c-1");
    const before = history.currentId;
    history.startNew();
    expect(history.currentId).not.toBe(before);
    expect(history.currentSessions).toEqual({});
    session("claude", "c-2");
    expect(history.list().map((c) => c.sessions.claude)).toEqual(["c-2", "c-1"]);
  });

  it("startNew と switchTo は今の会話が変わったことを通知する", () => {
    const { history, session } = setup();
    session("claude", "c-1");
    const first = history.currentId;
    const switched: string[] = [];
    history.onSwitch((id) => switched.push(id));
    history.startNew();
    history.switchTo(first);
    history.switchTo("missing");
    expect(switched).toEqual([expect.not.stringMatching(first), first]);
  });

  it("clearSession はその Agent の session を今の会話から外して保存する", () => {
    const { history, path, session } = setup();
    session("claude", "c-1");
    session("codex", "x-1");
    history.clearSession("codex");
    expect(history.currentSessions).toEqual({ claude: "c-1" });
    expect(new ConversationHistory(path, { resumeLatest: true }).currentSessions).toEqual({ claude: "c-1" });
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

describe("ConversationHistory のリネーム・削除・ピン止め", () => {
  it("今の会話の名前を変え、以後の入力で上書きしない", () => {
    const { history, human } = setup();
    human("最初の入力");
    history.rename("設計の相談");
    human("次の入力");
    expect(history.list()[0]?.title).toBe("設計の相談");
  });

  it("今の会話以外を削除し、削除を通知する。今の会話・無い会話は理由を返す", () => {
    const { history, human, path } = setup();
    human("old");
    history.startNew();
    human("new");
    const removed: string[] = [];
    history.onRemove((id) => removed.push(id));
    const old = history.list().find((c) => c.title === "old")!;
    expect(history.remove(history.currentId)).toMatch(/current/);
    expect(history.remove("missing")).toMatch(/not found/);
    expect(history.remove(old.id)).toBeUndefined();
    expect(removed).toEqual([old.id]);
    expect(new ConversationHistory(path, { resumeLatest: false }).list().map((c) => c.title)).toEqual(["new"]);
  });

  it("ピン止めした会話は先頭に並び、最大件数の枠から外れる。もう一度で解除する", () => {
    const { history, human, path } = setup();
    human("pinned one");
    const pinnedId = history.currentId;
    history.startNew();
    expect(history.togglePin(pinnedId)).toBe(true);
    for (let i = 0; i < MAX_CONVERSATIONS + 2; i++) {
      human(`c${i}`);
      history.startNew();
    }
    const list = new ConversationHistory(path, { resumeLatest: false }).list();
    expect(list[0]).toMatchObject({ id: pinnedId, pinned: true });
    expect(list.filter((c) => !c.pinned)).toHaveLength(MAX_CONVERSATIONS);
    expect(history.togglePin(pinnedId)).toBe(false);
    expect(history.togglePin("missing")).toBeUndefined();
  });
});
