// Web UI の feed を会話ごとに JSON Lines で保存する（DESIGN.md §18 Web UI の feed）
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { DEFAULT_RECENT_ITEMS, type HistoryItem } from "./web-feed.js";

const FEED_EXT = ".jsonl";
// limit のこの倍を超えたら直近だけに書き直す
const COMPACT_FACTOR = 2;

export const feedDirPath = (statePath: string): string =>
  join(statePath, "..", `${basename(statePath, extname(statePath))}.feed`);

const EVENT_KINDS: ReadonlySet<unknown> = new Set(["agent", "message", "human", "notice"]);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

// 自分で書いたファイルなので形（画面が分岐に使う type と kind）だけ確かめる。壊れた行は読み飛ばす
const parseLine = (line: string): HistoryItem | undefined => {
  try {
    const item: unknown = JSON.parse(line);
    if (!isObject(item)) return undefined;
    if (item.type === "output" && typeof item.text === "string") return item as HistoryItem;
    if (item.type === "event" && isObject(item.event) && EVENT_KINDS.has(item.event.kind)) return item as HistoryItem;
    return undefined;
  } catch {
    return undefined;
  }
};

const toLines = (items: HistoryItem[]) => items.map((item) => `${JSON.stringify(item)}\n`).join("");

export class FeedStore {
  constructor(private readonly dir: string, private readonly limit = DEFAULT_RECENT_ITEMS) {}

  append(conversationId: string, item: HistoryItem): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.pathOf(conversationId), toLines([item]));
  }

  // 読めなくても起動や会話の切り替えは妨げない（空の feed として扱う）
  load(conversationId: string): HistoryItem[] {
    const path = this.pathOf(conversationId);
    try {
      if (!existsSync(path)) return [];
      const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
      const items = lines.map(parseLine).filter((item) => item !== undefined).slice(-this.limit);
      if (lines.length > this.limit * COMPACT_FACTOR) writeFileSync(path, toLines(items));
      return items;
    } catch {
      return [];
    }
  }

  // 会話の履歴から外れた会話の feed を消す。消せないもの（使用中など）は次の機会に回す
  prune(keepIds: readonly string[]): void {
    const keep = new Set(keepIds.map((id) => `${id}${FEED_EXT}`));
    try {
      for (const file of readdirSync(this.dir)) {
        if (file.endsWith(FEED_EXT) && !keep.has(file)) unlinkSync(join(this.dir, file));
      }
    } catch {
      // ディレクトリが無い・消せない
    }
  }

  private pathOf(conversationId: string): string {
    return join(this.dir, `${conversationId}${FEED_EXT}`);
  }
}
