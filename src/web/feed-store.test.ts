import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FeedStore, feedDirPath } from "./feed-store.js";
import type { HistoryItem } from "./web-feed.js";

const makeDir = () => join(mkdtempSync(join(tmpdir(), "clodex-feed-")), "nested.feed");
const output = (seq: number): HistoryItem => ({ type: "output", seq, text: `line ${seq}` });

describe("feedDirPath", () => {
  it("会話の履歴と同じ名前の .feed ディレクトリにする", () => {
    expect(feedDirPath(join("C:\home", "E--dev-app-1a2b3c4d.json"))).toBe(join("C:\home", "E--dev-app-1a2b3c4d.feed"));
  });
});

describe("FeedStore", () => {
  it("会話ごとに追記し、読み込める。保存が無い会話は空", () => {
    const store = new FeedStore(makeDir());
    store.append("a", output(1));
    store.append("b", output(2));
    store.append("a", output(3));
    expect(store.load("a")).toEqual([output(1), output(3)]);
    expect(store.load("none")).toEqual([]);
  });

  it("直近 limit 件だけを返し、2 倍を超えていたら直近だけに書き直す", () => {
    const dir = makeDir();
    const store = new FeedStore(dir, 2);
    for (let i = 1; i <= 4; i++) store.append("a", output(i));
    expect(store.load("a")).toEqual([output(3), output(4)]);
    expect(readFileSync(join(dir, "a.jsonl"), "utf8").trim().split("\n")).toHaveLength(4);

    store.append("a", output(5));
    expect(store.load("a")).toEqual([output(4), output(5)]);
    expect(readFileSync(join(dir, "a.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("壊れた行は読み飛ばす", () => {
    const dir = makeDir();
    const store = new FeedStore(dir);
    store.append("a", output(1));
    writeFileSync(join(dir, "a.jsonl"), `${readFileSync(join(dir, "a.jsonl"), "utf8")}{broken\n{"type":"unknown"}\n{"type":"event","event":null}\n{"type":"event","event":{}}\n`);
    store.append("a", output(2));
    expect(store.load("a")).toEqual([output(1), output(2)]);
  });

  it("読めないファイルは空の feed として扱う（起動や会話の切り替えを妨げない）", () => {
    const dir = makeDir();
    // ファイルの代わりにディレクトリがあると読めない
    mkdirSync(join(dir, "a.jsonl"), { recursive: true });
    expect(new FeedStore(dir).load("a")).toEqual([]);
  });

  it("prune は残す会話以外の feed を削除する", () => {
    const dir = makeDir();
    const store = new FeedStore(dir);
    store.append("keep", output(1));
    store.append("drop", output(2));
    store.prune(["keep"]);
    expect(existsSync(join(dir, "keep.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "drop.jsonl"))).toBe(false);
  });

  it("ディレクトリが無くても prune できる", () => {
    expect(() => new FeedStore(makeDir()).prune([])).not.toThrow();
  });
});
