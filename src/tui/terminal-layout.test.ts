import { describe, expect, it } from "vitest";
import type { TimelineItem } from "../web/client/timeline.js";
import { advanceTerminalFeed, CardLineCache, cardLines, cursorSlices, editInput, formatMarkdown, formatTimelineItem, inputFrame, TERMINAL_COLORS,
  parseSgrMouse, scrollAfterGrowth, scrollBy, scrollToBottom, splitMouseInput, textWidth, visibleRange, wrapText } from "./terminal-layout.js";

const labels = {
  question: "質問", answered: "回答済み",
  you: "あなた", working: "作業中", completed: "完了", failed: "失敗", interrupted: "中断",
  steps: "作業 {count} 件", message: "メッセージ", notice: "通知", error: "エラー", output: "出力",
  steer: "割り込み",
  auto: "自動",
};

it("コマンド入力の枠を緑にして上辺にラベルを置き、! を消すと戻す", () => {
  const frame = inputFrame("!pnpm test", "コマンド", 40);
  expect(frame.color).toBe(TERMINAL_COLORS.code);
  expect(frame.top).toContain("╭─ コマンド ");
  expect(textWidth(frame.top ?? "")).toBe(40);
  expect(inputFrame("pnpm test", "コマンド", 40)).toEqual({ color: TERMINAL_COLORS.line });
});

describe("advanceTerminalFeed", () => {
  it("完了した項目だけを一度 Static へ送り、作業中は残す", () => {
    const start = advanceTerminalFeed({ timeline: [], completed: [] }, {
      type: "event", seq: 1, event: { kind: "agent", agent: "claude", at: "2026-01-01T00:00:00Z", event: { type: "turn_started" } },
    }, false);
    expect(start.completed).toEqual([]);
    expect(start.timeline).toHaveLength(1);
    const done = advanceTerminalFeed(start, {
      type: "event", seq: 2, event: { kind: "agent", agent: "claude", at: "2026-01-01T00:00:01Z", event: { type: "turn", result: { status: "completed", text: "完了" } } },
    }, true);
    expect(done.completed).toHaveLength(1);
    expect(done.completed[0]?.expanded).toBe(true);
    expect(done.timeline).toEqual([]);
  });

  it("連続した output は個別に書き出す", () => {
    const first = advanceTerminalFeed({ timeline: [], completed: [] }, { type: "output", seq: 1, text: "a" }, false);
    const second = advanceTerminalFeed(first, { type: "output", seq: 2, text: "b" }, false);
    expect(second.completed.map(({ item }) => item.kind === "output" ? item.text : "")).toEqual(["a", "b"]);
  });
});

describe("formatMarkdown", () => {
  it("見出し・太字・code・リスト・コードブロックを分類する", () => {
    expect(formatMarkdown("# 見出し\n**太字** と `code`\n- 箇条書き\n1. 番号\n```ts\nconst x = 1\n```"))
      .toMatchObject([
        { kind: "heading" }, { kind: "paragraph" }, { kind: "bullet" }, { kind: "ordered" }, { kind: "code", language: "ts" },
      ]);
    expect(formatMarkdown("**太字** と `code`")[0]?.parts.map(({ style }) => style)).toEqual(["bold", "plain", "code"]);
  });
  it("引用・表・区切り線を marked の token から分類する", () => {
    const blocks = formatMarkdown("> 引用\n\n| 名 | 値 |\n|---|---|\n| A | 1 |\n\n---");
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "table", "hr"]);
    expect(blocks[0]?.quoteDepth).toBe(1);
    expect(blocks[1]?.table?.header[0]?.[0]?.text).toBe("名");
  });

  it("斜体・取り消し線・安全なリンクを装飾し、HTML と危険なリンクは文字にする", () => {
    const blocks = formatMarkdown("*斜体* ~~削除~~ [安全](https://example.com) [危険](javascript:alert(1)) <b>raw</b>");
    const parts = blocks[0]?.parts ?? [];
    expect(parts).toContainEqual({ text: "斜体", style: "italic" });
    expect(parts).toContainEqual({ text: "削除", style: "strikethrough" });
    expect(parts).toContainEqual({ text: "安全", style: "link" });
    expect(parts).toContainEqual({ text: "危険", style: "plain" });
    expect(parts).toContainEqual({ text: "<b>", style: "plain" });
  });

  it("単独改行と入れ子、書かれた開始番号を保つ", () => {
    expect(formatMarkdown("一行\n二行")[0]?.parts.map((part) => part.text).join("")).toBe("一行\n二行");
    expect(formatMarkdown("3. 親\n   - 子\n4. 次")).toMatchObject([
      { kind: "ordered", number: 3, depth: 0 }, { kind: "bullet", depth: 1 }, { kind: "ordered", number: 4, depth: 0 },
    ]);
  });
});

describe("formatTimelineItem", () => {
  it("ターンと formal message の見出しと本文を組み立てる", () => {
    const turn: TimelineItem = { kind: "turn", id: "t", agent: "codex", at: "2026-01-01T00:00:00Z", status: "completed",
      plan: "調べます", steps: [{ kind: "tool", name: "Read", input: "a.ts" }], text: "終わりました" };
    expect(formatTimelineItem(turn, labels, false)).toMatchObject({ color: "#4b6fa5", title: "Codex · 完了", plan: "調べます", stepsLabel: "作業 1 件", body: "終わりました" });
    const message: TimelineItem = { kind: "message", id: "m", at: "2026-01-01T00:00:00Z", message: {
      id: "x", from: "claude", to: "codex", type: "DELEGATE", taskId: "T-1", body: "実装して", repository: "r", createdAt: "2026-01-01T00:00:00Z",
    } };
    expect(formatTimelineItem(message, labels, false)).toMatchObject({ title: "Claude → Codex", tag: "DELEGATE · T-1", body: "実装して" });
    expect(formatTimelineItem({ ...message, message: { ...message.message, auto: true } }, labels, false).tag).toBe("DELEGATE · T-1 · 自動");
  });
});

describe("editInput", () => {
  it("↑↓ で論理行を移動し、列を保ちつつ短い行では行末に止まる", () => {
    const source = "abcd\nxy\n12345";
    expect(editInput({ text: source, cursor: 3 }, { kind: "down" })).toEqual({ text: source, cursor: 7 });
    expect(editInput({ text: source, cursor: 7 }, { kind: "down" })).toEqual({ text: source, cursor: 10 });
    expect(editInput({ text: source, cursor: 12 }, { kind: "up" })).toEqual({ text: source, cursor: 7 });
    expect(editInput({ text: source, cursor: 6 }, { kind: "up" })).toEqual({ text: source, cursor: 1 });
  });

  it("先頭行の ↑ と末尾行の ↓ はカーソルを動かさず、空行にも移動する", () => {
    const source = "ab\n\ncd";
    expect(editInput({ text: source, cursor: 1 }, { kind: "up" })).toEqual({ text: source, cursor: 1 });
    expect(editInput({ text: source, cursor: 1 }, { kind: "down" })).toEqual({ text: source, cursor: 3 });
    expect(editInput({ text: source, cursor: 3 }, { kind: "down" })).toEqual({ text: source, cursor: 4 });
    expect(editInput({ text: source, cursor: 5 }, { kind: "down" })).toEqual({ text: source, cursor: 5 });
  });

  it("移動・挿入・削除・行頭と行末を扱う", () => {
    const left = editInput({ text: "ab\ncd", cursor: 4 }, { kind: "left" });
    expect(left).toEqual({ text: "ab\ncd", cursor: 3 });
    expect(editInput(left, { kind: "insert", text: "X" })).toEqual({ text: "ab\nXcd", cursor: 4 });
    expect(editInput({ text: "ab\ncd", cursor: 4 }, { kind: "home" })).toEqual({ text: "ab\ncd", cursor: 3 });
    expect(editInput({ text: "ab\ncd", cursor: 4 }, { kind: "end" })).toEqual({ text: "ab\ncd", cursor: 5 });
    expect(editInput({ text: "abc", cursor: 2 }, { kind: "backspace" })).toEqual({ text: "ac", cursor: 1 });
    expect(editInput({ text: "abc", cursor: 2 }, { kind: "delete" })).toEqual({ text: "ab", cursor: 2 });
    expect(cursorSlices({ text: "ab\ncd", cursor: 3 })).toEqual({ before: "ab\n", at: "c", after: "d" });
    expect(cursorSlices({ text: "ab\ncd", cursor: 2 })).toEqual({ before: "ab", at: " ", after: "\ncd" });
  });
});

describe("ログの表示行", () => {
  it("人間の割り込みに届いたかどうかを出す", () => {
    const human = { kind: "human", id: "h", at: "2026-01-01T00:00:00Z", agent: "claude", text: "本文", steer: true, steerId: "s-1" } as const;
    expect(formatTimelineItem(human, labels, false).tag).toBe("割り込み");
    expect(formatTimelineItem({ ...human, delivered: true }, labels, false).tag).toBe("割り込み ✓");
    expect(formatTimelineItem({ ...human, steer: undefined }, labels, false).tag).toBeUndefined();
  });
  it("人とターンの見出し 1 行だけを発言者の背景色で幅いっぱいに埋める", () => {
    const human: TimelineItem = { kind: "human", id: "h", at: "2026-01-01T00:00:00Z", agent: "claude", text: "本文" };
    const turn: TimelineItem = { kind: "turn", id: "t", at: "2026-01-01T00:00:00Z", agent: "codex",
      status: "completed", steps: [], text: "本文" };
    const humanLines = cardLines(formatTimelineItem(human, labels, false), 20);
    const turnLines = cardLines(formatTimelineItem(turn, labels, false), 20);
    expect(humanLines[0]?.backgroundColor).toBe("#323234");
    expect(turnLines[0]?.backgroundColor).toBe("#272e39");
    expect(textWidth(humanLines[0]?.text ?? "")).toBe(20);
    expect(textWidth(turnLines[0]?.text ?? "")).toBe(20);
    expect(humanLines.slice(1).every((line) => line.backgroundColor === undefined)).toBe(true);
    expect(turnLines.slice(1).every((line) => line.backgroundColor === undefined)).toBe(true);
  });
  it("全角を含む見出しは表示幅で埋め、折り返した 2 行目には背景を付けない", () => {
    const lines = cardLines({ kind: "human", title: "日本語長い見出し", body: "本文", color: "#80808a",
      headerBackgroundColor: "#323234" }, 8);
    expect(textWidth(lines[0]?.text ?? "")).toBe(8);
    expect(lines[0]?.backgroundColor).toBe("#323234");
    expect(lines[1]?.backgroundColor).toBeUndefined();
  });
  it("message は種類の色ではなく送信元の背景色を使う", () => {
    const message: TimelineItem = { kind: "message", id: "m", at: "2026-01-01T00:00:00Z", message: {
      id: "x", from: "claude", to: "codex", type: "RESULT", taskId: "T-1", body: "本文", repository: "r", createdAt: "2026-01-01T00:00:00Z",
    } };
    const card = formatTimelineItem(message, labels, false);
    expect(card.color).toBe("#4b6fa5");
    expect(cardLines(card, 30)[0]?.backgroundColor).toBe("#3c3025");
  });
  it("通知・エラー・コマンド出力の見出しには背景を付けない", () => {
    const items: TimelineItem[] = [
      { kind: "notice", id: "n", at: "2026-01-01T00:00:00Z", text: "通知" },
      { kind: "error", id: "e", at: "2026-01-01T00:00:00Z", agent: "claude", text: "エラー" },
      { kind: "output", id: "o", text: "結果" },
    ];
    for (const item of items) expect(cardLines(formatTimelineItem(item, labels, false), 20)[0]?.backgroundColor).toBeUndefined();
  });
  it("全角を 2 桁として折り返し、幅が変わると再計算する", () => {
    expect(wrapText("A日本B", 3)).toEqual(["A日", "本B"]);
    const item: TimelineItem = { kind: "output", id: "o", text: "日本語" };
    const cache = new CardLineCache();
    const wide = cache.lines(item, labels, false, 20);
    expect(cache.lines(item, labels, false, 20)).toBe(wide);
    expect(cache.lines(item, labels, false, 5)).not.toEqual(wide);
  });
  it("行内の太字・コード・リンクのスタイルを保って折り返す", () => {
    const lines = cardLines({ kind: "output", title: "出力", body: "**太字** と `code` [link](https://example.com)", color: "#80808a" }, 40);
    expect(lines.some((line) => line.parts?.some((part) => part.text.includes("太字") && part.bold))).toBe(true);
    expect(lines.some((line) => line.parts?.some((part) => part.text.includes("code") && part.color === "#6f9a5a"))).toBe(true);
    expect(lines.some((line) => line.parts?.some((part) => part.text.includes("link") && part.underline))).toBe(true);
  });
  it("引用の各行に薄い縦線を出し、単独改行を行として分ける", () => {
    const lines = cardLines({ kind: "output", title: "出力", body: "> 一行\n> 二行", color: "#80808a" }, 20);
    const quoted = lines.filter((line) => line.text.includes("一行") || line.text.includes("二行"));
    expect(quoted).toHaveLength(2);
    expect(quoted.every((line) => line.parts?.[1]?.text === "│ " && line.parts[1]?.color === "#80808a")).toBe(true);
  });

  it("表を罫線と揃った列幅で描き、端末幅で各行を折り返す", () => {
    const body = "| 名前 | 値 |\n|---|---|\n| 長い名前 | 100 |";
    const wide = cardLines({ kind: "output", title: "出力", body, color: "#80808a" }, 40);
    expect(wide.some((line) => line.text.includes("┌") && line.text.includes("┬"))).toBe(true);
    expect(wide.some((line) => line.text.includes("長い名前") && line.text.includes("100"))).toBe(true);
    const narrow = cardLines({ kind: "output", title: "出力", body, color: "#80808a" }, 12);
    expect(narrow.length).toBeGreaterThan(wide.length);
    expect(narrow.every((line) => textWidth(line.text) <= 12)).toBe(true);
  });

  it("区切り線・斜体・取り消し線・入れ子の字下げと開始番号を描く", () => {
    const body = "*斜体* ~~削除~~\n\n3. 親\n   - 子\n4. 次\n\n---";
    const lines = cardLines({ kind: "output", title: "出力", body, color: "#80808a" }, 28);
    expect(lines.some((line) => line.parts?.some((part) => part.text === "斜体" && part.italic))).toBe(true);
    expect(lines.some((line) => line.parts?.some((part) => part.text === "削除" && part.strikethrough))).toBe(true);
    expect(lines.some((line) => line.text.includes("  • 子"))).toBe(true);
    expect(lines.some((line) => line.text.includes("3. 親"))).toBe(true);
    expect(lines.some((line) => line.text.includes("4. 次"))).toBe(true);
    expect(lines.some((line) => line.text === `│ ${"─".repeat(26)}`)).toBe(true);
  });
  it("見出しの経過時間に渡された言語の文言を使う", () => {
    const lines = cardLines({ kind: "turn", title: "Claude · 作業中", body: "", color: "#b4793f" }, 40, "3 秒");
    expect(lines[0]?.text).toContain("3 秒");
    expect(lines[0]?.text).not.toContain("3s");
  });
  it("作業中のターンは毎秒の表示をキャッシュに溜めない", () => {
    const item: TimelineItem = { kind: "turn", id: "t", agent: "claude", at: "2026-01-01T00:00:00Z", status: "working",
      plan: "", steps: [], text: "作業中" };
    const cache = new CardLineCache();
    expect(cache.lines(item, labels, false, 40, "1 秒")).not.toBe(cache.lines(item, labels, false, 40, "1 秒"));
    expect(cache.lines(item, labels, false, 40, "2 秒")[0]?.text).toContain("2 秒");
  });
  it("全行数、高さ、位置から表示範囲を出す", () => {
    expect(visibleRange(20, 5, 0)).toEqual({ start: 15, end: 20 });
    expect(visibleRange(20, 5, 3)).toEqual({ start: 12, end: 17 });
    expect(visibleRange(2, 5, 10)).toEqual({ start: 0, end: 2 });
  });
});

describe("スクロール", () => {
  it("ホイールと PageUp/PageDown の移動量を制限し、末尾に戻る", () => {
    const wheel = scrollBy(scrollToBottom(), 3, 20, 5);
    expect(wheel.offset).toBe(3);
    expect(scrollBy(wheel, 4, 20, 5).offset).toBe(7);
    expect(scrollBy(wheel, -3, 20, 5)).toEqual(scrollToBottom());
    expect(scrollBy(wheel, 100, 20, 5).offset).toBe(15);
  });
  it("読み返し中は増加分を補正して新着を出し、末尾なら追従する", () => {
    expect(scrollAfterGrowth({ offset: 4, unseen: false }, 20, 23, 5)).toEqual({ offset: 7, unseen: true });
    expect(scrollAfterGrowth(scrollToBottom(), 20, 23, 5)).toEqual(scrollToBottom());
    expect(scrollAfterGrowth({ offset: 10, unseen: true }, 20, 5, 5).offset).toBe(0);
  });
});

describe("SGR マウス", () => {
  it("ホイール上下と修飾キー付きホイールを順に取り出す", () => {
    expect(splitMouseInput("\x1b[<64;10;5M\x1b[<69;10;5M\x1b[<64;10;5M"))
      .toEqual({ wheel: ["up", "down", "up"], rest: "" });
  });
  it("クリックとリリースを捨て、キー入力は順序を保つ", () => {
    expect(splitMouseInput("a\x1b[<0;10;5Mbc\x1b[<0;10;5m\x1b[<65;10;5Md"))
      .toEqual({ wheel: ["down"], rest: "abcd" });
  });
  it("マウスが無いチャンクはそのまま返す", () => {
    expect(splitMouseInput("あ\x1b[1;5Fい")).toEqual({ wheel: [], rest: "あ\x1b[1;5Fい" });
  });
  it("ホイール上下を認識し、クリックは入力対象から除く", () => {
    expect(parseSgrMouse("\x1b[<64;10;5M")).toBe("up");
    expect(parseSgrMouse("[<65;10;5M")).toBe("down");
    expect(parseSgrMouse("\x1b[<68;10;5M")).toBe("up");
    expect(parseSgrMouse("\x1b[<66;10;5M")).toBe("other");
    expect(parseSgrMouse("\x1b[<0;10;5M")).toBe("other");
    expect(parseSgrMouse("\x1b[<0;10;5m")).toBe("other");
    expect(parseSgrMouse("hello")).toBeUndefined();
  });
});

it("質問を番号付きカードにし、回答で同じカードを更新する", () => {
  const questions = [{ header: "方針", question: "選択", options: [{ label: "A", description: "説明" }, { label: "B" }] }];
  const first = advanceTerminalFeed({ timeline: [], completed: [] }, { type: "event", seq: 1, event: { kind: "question", id: "q1", agent: "claude", questions, at: "now" } }, false);
  const card = formatTimelineItem(first.completed[0]!.item, labels, false);
  expect(card.color).toBe(TERMINAL_COLORS.claude);
  expect(card.body).toContain("1. A — 説明");
  expect(card.body).toContain("方針");
  const answered = advanceTerminalFeed(first, { type: "event", seq: 2, event: { kind: "answer", id: "q1", agent: "claude", answers: [["A"]], at: "now" } }, false);
  expect(answered.completed).toHaveLength(1);
  expect(answered.completed[0]!.item).toMatchObject({ id: "q1", answers: [["A"]] });
});
