import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventBus } from "../coordinator/event-bus.js";
import { attachSessionStore, loadSessions, sessionStatePath } from "./session-store.js";

const makeHome = () => mkdtempSync(join(tmpdir(), "clodex-state-"));
const HOME = "C:\\home";

describe("sessionStatePath", () => {
  it("project root の英数字以外を - にした名前とパスのハッシュにする", () => {
    const path = sessionStatePath(HOME, "E:\\dev\\Clodex");
    expect(path.startsWith(join(HOME, ".clodex", "state"))).toBe(true);
    expect(basename(path)).toMatch(/^E--dev-Clodex-[0-9a-f]{8}\.json$/);
  });

  it("区切り文字と - だけが違う project は別のファイルになる", () => {
    expect(sessionStatePath(HOME, "C:\\a-b")).not.toBe(sessionStatePath(HOME, "C:\\a\\b"));
  });

  it("大文字小文字だけが違うパスは同じハッシュになる", () => {
    const hashOf = (root: string) => basename(sessionStatePath(HOME, root)).slice(-13);
    expect(hashOf("E:\\dev\\Clodex")).toBe(hashOf("e:\\dev\\clodex"));
  });
});

describe("loadSessions", () => {
  it("保存が無ければ空", () => {
    expect(loadSessions(join(makeHome(), "none.json"))).toEqual({});
  });

  it("壊れたファイルや未知の値は無視して空として扱う", () => {
    const path = join(makeHome(), "state.json");
    writeFileSync(path, "{ broken");
    expect(loadSessions(path)).toEqual({});
    writeFileSync(path, JSON.stringify({ claude: 1, gemini: "x" }));
    expect(loadSessions(path)).toEqual({});
  });
});

describe("attachSessionStore", () => {
  it("session event のたびにその Agent の ID を上書き保存する", () => {
    const path = join(makeHome(), "nested", "state.json");
    const bus = new EventBus();
    attachSessionStore(bus, path, {});

    bus.publish({ kind: "agent", agent: "claude", event: { type: "session", sessionId: "c-1" } });
    bus.publish({ kind: "agent", agent: "codex", event: { type: "session", sessionId: "x-1" } });
    bus.publish({ kind: "agent", agent: "claude", event: { type: "session", sessionId: "c-2" } });
    bus.publish({ kind: "agent", agent: "claude", event: { type: "text", text: "ignored" } });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ claude: "c-2", codex: "x-1" });
  });

  it("--resume のときは読み込んだ内容を引き継いで上書きする", () => {
    const path = join(makeHome(), "state.json");
    writeFileSync(path, JSON.stringify({ codex: "x-old" }));
    const bus = new EventBus();
    attachSessionStore(bus, path, loadSessions(path));
    bus.publish({ kind: "agent", agent: "claude", event: { type: "session", sessionId: "c-1" } });
    expect(loadSessions(path)).toEqual({ claude: "c-1", codex: "x-old" });
  });

  it("--resume なしの起動では保存内容を空にし、前回の session と混ぜない", () => {
    const path = join(makeHome(), "state.json");
    writeFileSync(path, JSON.stringify({ claude: "c-old", codex: "x-old" }));
    const bus = new EventBus();
    attachSessionStore(bus, path, {});
    expect(loadSessions(path)).toEqual({});
    bus.publish({ kind: "agent", agent: "claude", event: { type: "session", sessionId: "c-new" } });
    expect(loadSessions(path)).toEqual({ claude: "c-new" });
  });
});
