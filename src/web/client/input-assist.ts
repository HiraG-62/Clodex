// 入力欄の補助（DESIGN.md §28 v0.3 A）: スラッシュコマンド・送り先・@path の候補と、強調表示の区切り。
// ブラウザへ関数のまま埋め込むため、外部を参照しない 1 つの関数として書く（型の import のみ）
import type { SlashCommand } from "../../cli/commands.js";

export interface AssistItem {
  label: string;
  detail: string;
  insert: string;
}

// 入力の from〜to を候補の insert で置き換える
export interface Suggestion {
  from: number;
  to: number;
  items: AssistItem[];
}

export interface Segment {
  text: string;
  kind?: "command" | "agent" | "file";
}

export function createInputAssist(commands: readonly SlashCommand[], agents: readonly string[]) {
  const MAX_ITEMS = 8;

  // caret を含む空白区切りの語
  const tokenAt = (text: string, caret: number) => {
    let from = caret;
    while (from > 0 && !/\s/.test(text.charAt(from - 1))) from--;
    let to = caret;
    while (to < text.length && !/\s/.test(text.charAt(to))) to++;
    return { from, to, word: text.slice(from, caret) };
  };

  const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  // ファイル名の前方一致 → パスの前方一致 → 部分一致の順。同じ順位なら短いパス
  const rankFile = (path: string, query: string) => {
    const lower = path.toLowerCase();
    if (baseName(lower).startsWith(query)) return 0;
    if (lower.startsWith(query)) return 1;
    return lower.includes(query) ? 2 : undefined;
  };

  const matchFiles = (files: readonly string[], query: string): AssistItem[] =>
    files
      .map((path) => ({ path, rank: rankFile(path, query) }))
      .filter((entry): entry is { path: string; rank: number } => entry.rank !== undefined)
      .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length)
      .slice(0, MAX_ITEMS)
      .map(({ path }) => ({ label: `@${path}`, detail: "ファイル", insert: `@${path} ` }));

  const suggest = (text: string, caret: number, files: readonly string[]): Suggestion | undefined => {
    const { from, to, word } = tokenAt(text, caret);
    if (from === 0 && word.startsWith("/")) {
      const query = word.slice(1).toLowerCase();
      const items = commands
        .filter(({ name }) => name.startsWith(query))
        .map(({ name, args, description }) => ({ label: `/${name}${args ? ` ${args}` : ""}`, detail: description, insert: `/${name} ` }));
      return items.length ? { from, to, items } : undefined;
    }
    if (!word.startsWith("@")) return undefined;
    const query = word.slice(1).toLowerCase();
    const agentItems = from === 0
      ? agents.filter((agent) => agent.startsWith(query)).map((agent) => ({ label: `@${agent}`, detail: "送り先", insert: `@${agent} ` }))
      : [];
    const items = [...agentItems, ...matchFiles(files, query)].slice(0, MAX_ITEMS);
    return items.length ? { from, to, items } : undefined;
  };

  // 先頭のコマンド、行頭の @agent、存在するファイルの @path を区切る
  const highlight = (text: string, files: ReadonlySet<string>): Segment[] => {
    const segments: Segment[] = [];
    const push = (part: string, kind?: Segment["kind"]) => {
      const last = segments[segments.length - 1];
      if (!kind && last && !last.kind) last.text += part;
      else segments.push(kind ? { text: part, kind } : { text: part });
    };
    let offset = 0;
    for (const part of text.split(/(\s+)/)) {
      const atStart = offset === 0;
      offset += part.length;
      if (atStart && /^\/\S+$/.test(part)) push(part, "command");
      else if (atStart && agents.includes(part.slice(1)) && part.startsWith("@")) push(part, "agent");
      else if (part.startsWith("@") && files.has(part.slice(1).replace(/[.,:;!?)\]、。」]+$/, ""))) push(part, "file");
      else push(part);
    }
    return segments;
  };

  return { suggest, highlight };
}
