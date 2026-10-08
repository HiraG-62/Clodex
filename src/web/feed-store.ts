// Web UI の feed を会話ごとに JSON Lines で保存する（DESIGN.md §18 Web UI の feed）
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { AgentId } from "../agents/agent-adapter.js";
import { withoutContextInstruction } from "../context/conversation-instruction.js";
import { DEFAULT_RECENT_ITEMS, type HistoryItem } from "./web-feed.js";

const FEED_EXT = ".jsonl";
// limit のこの倍を超えたら直近だけに書き直す
const COMPACT_FACTOR = 2;

export const feedDirPath = (statePath: string): string =>
  join(statePath, "..", `${basename(statePath, extname(statePath))}.feed`);

const EVENT_KINDS: ReadonlySet<unknown> = new Set(["agent", "message", "human", "notice", "question", "answer"]);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

// 自分で書いたファイルなので形（画面が分岐に使う type と kind）だけ確かめる。壊れた行は読み飛ばす
const parseLine = (line: string): HistoryItem | undefined => {
  try {
    const item: unknown = JSON.parse(line);
    if (!isObject(item)) return undefined;
    if (item.type === "output" && typeof item.text === "string") return item as HistoryItem;
    if (item.type === "event" && isObject(item.event) && EVENT_KINDS.has(item.event.kind)) {
      if (item.event.kind === "human" && typeof item.event.text === "string") {
        item.event.text = withoutContextInstruction(item.event.text);
      }
      if (item.event.kind === "agent" && (
        !isObject(item.event.event) || typeof item.event.event.type !== "string"
        || (item.event.agent !== "claude" && item.event.agent !== "codex") || typeof item.event.at !== "string"
      )) return undefined;
      return item as HistoryItem;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

const toLines = (items: HistoryItem[]) => items.map((item) => `${JSON.stringify(item)}\n`).join("");

// 終わっていない（turn が無い）ターンを閉じる中断の event。working の Agent のターンは閉じない
const interruptionsOf = (items: HistoryItem[], working: ReadonlySet<AgentId>): HistoryItem[] => {
  const open = new Map<AgentId, { at: string }>();
  for (const item of items) {
    if (item.type !== "event" || item.event.kind !== "agent") continue;
    const { agent, at, event } = item.event;
    if (event.type === "turn") open.delete(agent);
    if (event.type === "turn_started" || event.type === "text" || event.type === "tool") open.set(agent, { at });
  }
  return [...open].filter(([agent]) => !working.has(agent)).map(([agent, { at }]): HistoryItem => ({
    type: "event", seq: 0, event: { kind: "agent", agent, at, event: { type: "turn", result: { status: "interrupted", text: "" } } },
  }));
};

const readItems = (path: string): { lines: number; items: HistoryItem[] } => {
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
  return { lines: lines.length, items: lines.map(parseLine).filter((item) => item !== undefined) };
};

export class FeedStore {
  constructor(private readonly dir: string, private readonly limit = DEFAULT_RECENT_ITEMS) {}

  get directory(): string { return this.dir; }

  // Hub が project を開いたとき（まだどのターンも動いていない時点）に呼ぶ。
  // 前の Hub が作業中に止まったターンを、復旧で同じ Agent が作業を始めても作業中のまま残さないよう、ファイル上で閉じる
  closeUnfinished(): void {
    try {
      for (const file of readdirSync(this.dir)) {
        if (!file.endsWith(FEED_EXT)) continue;
        const path = join(this.dir, file);
        const interruptions = interruptionsOf(readItems(path).items, new Set());
        if (interruptions.length) appendFileSync(path, toLines(interruptions));
      }
    } catch {
      // 読めない・無いときは閉じるものが無いとみなす（起動を妨げない）
    }
  }

  append(conversationId: string, item: HistoryItem): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.pathOf(conversationId), toLines([item]));
  }

  // 読めなくても起動や会話の切り替えは妨げない（空の feed として扱う）
  load(conversationId: string, working: ReadonlySet<AgentId> = new Set()): HistoryItem[] {
    const path = this.pathOf(conversationId);
    try {
      if (!existsSync(path)) return [];
      const { lines, items: all } = readItems(path);
      const items = all.slice(-this.limit);
      if (lines > this.limit * COMPACT_FACTOR) writeFileSync(path, toLines(items));
      return [...items, ...interruptionsOf(items, working)].slice(-this.limit);
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
