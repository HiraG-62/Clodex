// 完了ログは Static で端末に書き出し、操作中の領域だけを書き換える。
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, render, useApp, useInput } from "ink";
import { slashCommands } from "../cli/commands.js";
import { t } from "../i18n/i18n.js";
import { createInputAssist } from "../web/client/input-assist.js";
import type { WebState } from "../web/web-feed.js";
import type { FeedClient } from "./feed-client.js";
import { advanceTerminalFeed, cursorSlices, editInput, formatMarkdown, formatTimelineItem,
  type InputBuffer, type MarkdownBlock, type StaticItem, type TerminalCard, type TerminalFeed, type TerminalLabels } from "./terminal-layout.js";

const h = React.createElement;
const MAX_SUGGESTIONS = 5;
const SPINNER_INTERVAL_MS = 250;
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const CURSOR_HOME = "\x1b[H";
const LINE_COLOR = "#d4d4d8";
const MUTED_COLOR = "#80808a";
const WARN_COLOR = "#b7791f";
const CLAUDE_COLOR = "#b4793f";
const CODEX_COLOR = "#4b6fa5";
const CODE_COLOR = "#6f9a5a";
const EMPTY_STATE: WebState = { project: "", primary: "claude", roles: {}, agents: [], conversations: [], pendingInputs: [] };
const EMPTY_FEED: TerminalFeed = { timeline: [], completed: [] };

const makeAssist = () => createInputAssist(slashCommands(), ["claude", "codex"], {
  agent: t("web.assist.agent"), file: t("web.assist.file"), permission: t("web.assist.permission"),
  effort: t("web.assist.effort"), model: t("web.assist.model"), conversation: t("web.assist.conversation"),
  project: t("web.assist.project"), worktree: t("web.assist.worktree"), queued: t("web.assist.queued"),
});

const labels = (): TerminalLabels => ({
  you: t("tui.you"), working: t("web.turn.working"), completed: t("web.turn.completed"),
  failed: t("web.turn.failed"), interrupted: t("web.turn.interrupted"),
  steps: t("web.turn.steps"), message: t("tui.message"), notice: t("tui.notice"),
  error: t("tui.error"), output: t("tui.output"),
});

const Inline = ({ parts }: { parts: MarkdownBlock["parts"] }) => h(Text, { wrap: "wrap" },
  ...parts.map((part, i) => h(Text, { key: i, bold: part.style === "bold", color: part.style === "code" ? CODE_COLOR : undefined,
    underline: part.style === "link" }, part.text)));

const Markdown = ({ value }: { value: string }) => h(Box, { flexDirection: "column" },
  ...formatMarkdown(value).map((block, i) => {
    if (block.kind === "code") return h(Box, { key: i, flexDirection: "column", borderStyle: "round", borderColor: LINE_COLOR, paddingX: 1, marginY: 1 },
      block.language ? h(Text, { color: MUTED_COLOR }, block.language) : null,
      h(Text, { color: CODE_COLOR, wrap: "wrap" }, block.parts[0]?.text ?? ""));
    const marker = block.kind === "bullet" ? "• " : block.kind === "ordered" ? `${block.number}. ` : "";
    return h(Box, { key: i, flexDirection: "row", gap: 0 },
      marker ? h(Text, { color: MUTED_COLOR }, marker) : null,
      h(Box, { flexGrow: 1 }, h(Text, { bold: block.kind === "heading", wrap: "wrap" }, h(Inline, { parts: block.parts }))));
  }));

const Card = ({ card, elapsedSeconds }: { card: TerminalCard; elapsedSeconds?: number }) => {
  const divider = card.kind === "message" ? "┃" : "│";
  return h(Box, { flexDirection: "row", marginBottom: 1 },
    h(Text, { color: card.color, bold: true }, divider),
    h(Box, { flexDirection: "column", paddingLeft: 1, flexGrow: 1 },
      h(Text, { color: card.color, bold: true }, `${card.title}${elapsedSeconds === undefined ? "" : ` · ${t("tui.elapsed", { seconds: elapsedSeconds })}`}`),
      card.tag ? h(Text, { color: card.color }, card.tag) : null,
      card.plan ? h(Text, { color: MUTED_COLOR, wrap: "wrap" }, card.plan) : null,
      card.stepsLabel ? h(Text, { color: MUTED_COLOR }, `${card.steps ? "▾" : "▸"} ${card.stepsLabel}`) : null,
      ...(card.steps ?? []).map((step, i) => h(Box, { key: i, paddingLeft: 2 }, h(Text, { color: MUTED_COLOR, wrap: "wrap" }, `• ${step}`))),
      card.body ? h(Markdown, { value: card.body }) : null,
    ));
};

const StatusPanel = ({ state, feed, now }: { state: WebState; feed: TerminalFeed; now: number }) => {
  return h(Box, { flexDirection: "column" },
    ...state.agents.map((agent) => {
      const active = feed.timeline.findLast((item) => item.kind === "turn" && item.agent === agent.id && item.status === "working");
      const last = active?.kind === "turn" ? active.steps.at(-1) : undefined;
      const work = last ? last.kind === "say" ? last.text : `${last.name}: ${last.input}` : active?.kind === "turn" ? active.plan : undefined;
      const elapsed = active?.kind === "turn" ? Math.max(0, Math.floor((now - Date.parse(active.at)) / 1000)) : undefined;
      const usage = [agent.usage.fiveHourPercent === undefined ? "" : `${t("web.gauge.fiveHour")} ${agent.usage.fiveHourPercent}%`,
        agent.usage.weeklyPercent === undefined ? "" : `${t("web.gauge.weekly")} ${agent.usage.weeklyPercent}%`,
        agent.usage.weeklyPace === undefined ? "" : t("web.gauge.pace", { pace: agent.usage.weeklyPace })].filter(Boolean).join(" · ");
      const color = agent.id === "claude" ? CLAUDE_COLOR : CODEX_COLOR;
      const status = t(`web.status.${agent.status}`);
      return h(Box, { key: agent.id, flexDirection: "column" },
        h(Box, { flexDirection: "row", gap: 1 },
          h(Box, { flexShrink: 0 }, h(Text, { color, bold: true }, agent.id === "claude" ? "Claude" : "Codex")),
          h(Box, { flexShrink: 0 }, h(Text, { color: MUTED_COLOR }, `${agent.status === "busy" ? `${SPINNER_FRAMES[Math.floor(now / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]} ` : ""}${status}${elapsed === undefined ? "" : ` · ${t("tui.elapsed", { seconds: elapsed })}`} · ${agent.model ?? "default"} · ${agent.effort ?? "default"} ·`)),
          h(Text, { color: agent.permission === "full" ? WARN_COLOR : MUTED_COLOR, bold: agent.permission === "full" }, agent.permission),
          usage ? h(Box, { flexShrink: 1 }, h(Text, { color: MUTED_COLOR, wrap: "truncate-end" }, `· ${usage}`)) : null,
        ),
        work ? h(Text, { color: MUTED_COLOR, wrap: "truncate-end" }, `↳ ${work.replace(/\s+/g, " ")}`) : null,
      );
    }),
  );
};

export const TuiApp = ({ client }: { client: FeedClient }) => {
  const { exit } = useApp();
  const [feed, setFeed] = useState<TerminalFeed>(EMPTY_FEED);
  const [state, setState] = useState<WebState>(EMPTY_STATE);
  const [files, setFiles] = useState<string[]>([]);
  const [buffer, setBuffer] = useState<InputBuffer>({ text: "", cursor: 0 });
  const [selected, setSelected] = useState(0);
  const [expandFuture, setExpandFuture] = useState(false);
  const expandRef = useRef(false);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
  const assist = useMemo(makeAssist, []);
  const cardLabels = useMemo(labels, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    void client.connect((item) => {
      if (closed) return;
      if (item.type === "state") setState(item.state);
      else setFeed((old) => advanceTerminalFeed(old, item, expandRef.current));
    }).then((stop) => { if (closed) stop(); else unsubscribe = stop; }).catch((error: unknown) => setNotice(String(error)));
    return () => { closed = true; unsubscribe?.(); };
  }, [client]);
  useEffect(() => {
    let active = true;
    void client.files().then((paths) => { if (active) setFiles(paths); }).catch(() => { if (active) setFiles([]); });
    return () => { active = false; };
  }, [client, state.project]);

  const suggestion = assist.suggest(buffer.text, buffer.cursor, files, state);
  const choices = suggestion?.items.slice(0, MAX_SUGGESTIONS) ?? [];
  const send = (line: string) => void client.send(line).catch((error: unknown) => setNotice(String(error)));
  const edit = (action: Parameters<typeof editInput>[1]) => setBuffer((old) => editInput(old, action));

  useInput((keyText, key) => {
    if (key.ctrl && keyText === "d") { exit(); return; }
    if (key.ctrl && keyText === "o") { expandRef.current = !expandRef.current; setExpandFuture(expandRef.current); return; }
    if (key.ctrl && keyText === "c") {
      if (state.agents.some((agent) => agent.status === "busy")) send("/interrupt");
      else setNotice(t("tui.exitHint"));
      return;
    }
    if (key.upArrow && choices.length) { setSelected((old) => (old + choices.length - 1) % choices.length); return; }
    if (key.downArrow && choices.length) { setSelected((old) => (old + 1) % choices.length); return; }
    if (key.upArrow) { edit({ kind: "up" }); return; }
    if (key.downArrow) { edit({ kind: "down" }); return; }
    if (key.tab && suggestion && choices.length) {
      const choice = choices[selected % choices.length];
      if (choice) edit({ kind: "replace", from: suggestion.from, to: suggestion.to, text: choice.insert });
      setSelected(0); return;
    }
    if (key.leftArrow) { edit({ kind: "left" }); return; }
    if (key.rightArrow) { edit({ kind: "right" }); return; }
    if (key.home) { edit({ kind: "home" }); return; }
    if (key.end) { edit({ kind: "end" }); return; }
    if (key.ctrl && keyText === "j") { edit({ kind: "insert", text: "\n" }); return; }
    if (key.return) {
      if (buffer.text.trim() === "/exit") exit();
      else if (buffer.text.trim()) send(buffer.text);
      setBuffer({ text: "", cursor: 0 }); setSelected(0); return;
    }
    if (key.backspace) { edit({ kind: "backspace" }); setSelected(0); return; }
    if (key.delete) { edit({ kind: "delete" }); setSelected(0); return; }
    if (!key.ctrl && !key.meta && keyText) { edit({ kind: "insert", text: keyText }); setSelected(0); }
  });

  const cursor = cursorSlices(buffer);
  const branch = state.conversations.find((conversation) => conversation.current)?.branch;
  const project = `${state.project || "Clodex"}${branch ? ` · ${t("tui.branch", { branch })}` : ""}`;
  return h(Box, { flexDirection: "column" },
    h(Static<StaticItem>, { items: feed.completed, children: (record: StaticItem) => h(Card, {
      key: record.item.id, card: formatTimelineItem(record.item, cardLabels, record.expanded), elapsedSeconds: record.elapsedSeconds,
    }) }),
    ...feed.timeline.filter((item) => item.kind === "turn").map((item) => h(Card, { key: item.id, card: formatTimelineItem(item, cardLabels, expandFuture),
      elapsedSeconds: Math.max(0, Math.floor((now - Date.parse(item.at)) / 1000)) })),
    choices.length ? h(Box, { borderStyle: "round", borderColor: LINE_COLOR, flexDirection: "column", paddingX: 1 },
      ...choices.map((choice, i) => h(Text, { key: `${choice.insert}${i}`, color: i === selected ? CODEX_COLOR : MUTED_COLOR }, `${i === selected ? "▸" : " "} ${choice.label} · ${choice.detail}`))) : null,
    h(Box, { borderStyle: "round", borderColor: LINE_COLOR, flexDirection: "column", paddingX: 1 },
      h(Text, { wrap: "wrap" }, cursor.before, h(Text, { inverse: true }, cursor.at), cursor.after,
        buffer.text ? null : h(Text, { color: MUTED_COLOR }, t("tui.inputLabel")))),
    h(StatusPanel, { state, feed, now }),
    notice ? h(Text, { color: WARN_COLOR }, notice) : null,
    h(Text, { color: MUTED_COLOR, wrap: "truncate-end" }, `${project} · ${t("tui.footer", { queued: state.pendingInputs.length })}`),
  );
};

/** 画面の行数ぶん改行して起動前の内容を端末のスクロールへ押し出し、カーソルを画面の先頭へ戻す */
export const freshScreen = (rows: number): string => `${"\n".repeat(rows)}${CURSOR_HOME}`;

export const startTui = async (client: FeedClient): Promise<void> => {
  if (process.stdout.isTTY) process.stdout.write(freshScreen(process.stdout.rows));
  const instance = render(h(TuiApp, { client }), { exitOnCtrlC: false });
  await instance.waitUntilExit();
};
