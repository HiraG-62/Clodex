// 入力欄の補助（DESIGN.md §28 v0.3 A）: スラッシュコマンド・送り先・@path の候補と、強調表示の区切り。
// ブラウザへ関数のまま埋め込むため、外部を参照しない 1 つの関数として書く（型の import のみ）
import type { SlashCommand } from "../../cli/commands.js";
import type { ModelOption } from "../../agents/startup-probe.js";

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

export interface AssistState {
  agents: ReadonlyArray<{ id: string; models: readonly ModelOption[] }>;
  conversations: ReadonlyArray<{ title?: string }>;
  projects?: ReadonlyArray<{ projectRoot: string }>;
  questions?: ReadonlyArray<{ id: string; questions: ReadonlyArray<{ question: string }> }>;
  pendingInputs: ReadonlyArray<{ id: string }>;
  processes?: ReadonlyArray<{ id: number; command: string; status: string }>;
}

// labels: 候補の種類の表示（画面の言語の文言）
export function createInputAssist(commands: readonly SlashCommand[], agents: readonly string[], labels: {
  agent: string; file: string; permission: string; effort: string; model: string;
  conversation: string; project: string; worktree: string; queued: string;
}) {
  const MAX_ITEMS = 8;
  const recipients = [...agents, "all"];
  const PERMISSIONS = ["read-only", "edit", "full"];
  const COMMON_EFFORTS = ["low", "medium", "high", "xhigh"];

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
      .map(({ path }) => ({ label: `@${path}`, detail: labels.file, insert: `@${path} ` }));

  const suggest = (text: string, caret: number, files: readonly string[], state?: AssistState): Suggestion | undefined => {
    const { from, to, word } = tokenAt(text, caret);
    if (from === 0 && word.startsWith("/")) {
      const query = word.slice(1).toLowerCase();
      const items = commands
        .filter(({ name }) => name.startsWith(query))
        .map(({ name, args, description }) => ({ label: `/${name}${args ? ` ${args}` : ""}`, detail: description, insert: `/${name} ` }));
      return items.length ? { from, to, items } : undefined;
    }
    if (state && text.startsWith("/") && from > 0) {
      const previous = text.slice(0, from).trim().split(/\s+/);
      const name = previous[0]?.slice(1);
      const index = previous.length - 1;
      let values: Array<{ value: string; detail: string }> = [];
      const agentValues = agents.map((value) => ({ value, detail: labels.agent }));
      const simple = (items: readonly string[], detail: string) => items.map((value) => ({ value, detail }));
      switch (name) {
        case "limits":
          if (index === 0) values = simple(commands.find((command) => command.name === name)?.argumentValues ?? [], "");
          break;
        case "answer":
          if (index === 0) values = (state.questions ?? []).map(({ id, questions }) => ({ value: id, detail: questions[0]?.question ?? "" }));
          break;
        case "processes": case "kill":
          if (index === 0) values = (state.processes ?? [])
            .filter(({ status }) => name !== "kill" || status === "running")
            .map(({ id, command }) => ({ value: String(id), detail: command }));
          break;
        case "role": case "primary": case "interrupt": case "compact":
          if (index === 0) values = agentValues;
          break;
        case "new":
          if (index === 0) values = [...agentValues, { value: "worktree", detail: labels.worktree }];
          break;
        case "permission":
          if (index === 0) values = [...agentValues, ...simple(PERMISSIONS, labels.permission)];
          if (index === 1) values = simple(PERMISSIONS, labels.permission);
          break;
        case "effort":
          if (index === 0) values = [...agentValues, ...simple(COMMON_EFFORTS, labels.effort)];
          if (index === 1) values = simple([...COMMON_EFFORTS, ...(previous[1] === "claude" ? ["max"] : ["minimal"])], labels.effort);
          break;
        case "model":
          if (index === 0) values = agentValues;
          if (index === 1) values = (state.agents.find((agent) => agent.id === previous[1])?.models ?? [])
            .map((model) => ({ value: model.value, detail: model.label }));
          break;
        case "resume": case "delete": case "pin":
          if (index === 0) values = state.conversations.map((conversation, i) => ({ value: String(i + 1), detail: conversation.title ?? labels.conversation }));
          break;
        case "project": {
          const projects = (state.projects ?? []).map(({ projectRoot }) => ({ value: projectRoot, detail: labels.project }));
          if (index === 0) values = [...simple(["pin", "remove"], ""), ...projects];
          if (index === 1 && (previous[1] === "pin" || previous[1] === "remove")) values = projects;
          break;
        }
        case "cancel":
          if (index === 0) values = state.pendingInputs.map(({ id }) => ({ value: id, detail: labels.queued }));
          break;
      }
      const query = word.toLowerCase();
      const items = values.filter(({ value }) => value.toLowerCase().startsWith(query)).slice(0, MAX_ITEMS)
        .map(({ value, detail }) => ({ label: value, detail, insert: `${value} ` }));
      return items.length ? { from, to, items } : undefined;
    }
    if (!word.startsWith("@")) return undefined;
    const query = word.slice(1).toLowerCase();
    const agentItems = from === 0
      ? recipients.filter((agent) => agent.startsWith(query)).map((agent) => ({ label: `@${agent}`, detail: labels.agent, insert: `@${agent} ` }))
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
      else if (atStart && part.startsWith("@") && recipients.includes(part.slice(1).replace(/!$/, ""))) push(part, "agent");
      else if (part.startsWith("@") && files.has(part.slice(1).replace(/[.,:;!?)\]、。」]+$/, ""))) push(part, "file");
      else push(part);
    }
    return segments;
  };

  return { suggest, highlight };
}
