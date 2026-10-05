// Ink の端末画面。入力と feed の輸送方法には依存しない。
import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { slashCommands } from "../cli/commands.js";
import { t } from "../i18n/i18n.js";
import { applyFeedItem, type TimelineItem } from "../web/client/timeline.js";
import { createInputAssist } from "../web/client/input-assist.js";
import type { WebState } from "../web/web-feed.js";
import type { FeedClient } from "./feed-client.js";
import { terminalLines } from "./terminal-lines.js";

const h = React.createElement;
const MAX_SUGGESTIONS = 5;
const CHROME_ROWS = 12;
const MIN_LOG_ROWS = 4;
const DEFAULT_ROWS = 24;
const PAGE_ROWS = 8;
const EMPTY_STATE: WebState = { project: "", primary: "claude", roles: {}, agents: [], conversations: [], pendingInputs: [] };

const makeAssist = () => createInputAssist(slashCommands(), ["claude", "codex"], {
  agent: t("web.assist.agent"), file: t("web.assist.file"), permission: t("web.assist.permission"),
  effort: t("web.assist.effort"), model: t("web.assist.model"), conversation: t("web.assist.conversation"),
  project: t("web.assist.project"), worktree: t("web.assist.worktree"), queued: t("web.assist.queued"),
});

const App = ({ client }: { client: FeedClient }) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [rows, setRows] = useState(process.stdout.rows ?? DEFAULT_ROWS);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [state, setState] = useState<WebState>(EMPTY_STATE);
  const [files, setFiles] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState(0);
  const [offset, setOffset] = useState(0);
  const [notice, setNotice] = useState("");
  const assist = useMemo(makeAssist, []);

  useEffect(() => {
    const resize = () => setRows(process.stdout.rows ?? DEFAULT_ROWS);
    stdout.on("resize", resize);
    return () => { stdout.off("resize", resize); };
  }, [stdout]);
  useEffect(() => {
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    void client.connect((item) => {
      if (closed) return;
      if (item.type === "state") setState(item.state);
      else if (item.type !== "version") setItems((old) => applyFeedItem(old, item));
    }).then((stop) => { if (closed) stop(); else unsubscribe = stop; }).catch((error: unknown) => setNotice(String(error)));
    return () => { closed = true; unsubscribe?.(); };
  }, [client]);
  useEffect(() => {
    let active = true;
    void client.files().then((paths) => { if (active) setFiles(paths); }).catch(() => { if (active) setFiles([]); });
    return () => { active = false; };
  }, [client, state.project]);

  const suggestion = assist.suggest(input, input.length, files, state);
  const choices = suggestion?.items.slice(0, MAX_SUGGESTIONS) ?? [];
  const logRows = Math.max(MIN_LOG_ROWS, rows - CHROME_ROWS - state.agents.length - state.pendingInputs.length - choices.length);
  const allLines = useMemo(() => terminalLines(items, undefined, {
    working: t("log.working"), completed: t("log.done"), failed: t("tui.failed"), interrupted: t("log.interrupted"),
    steps: t("web.turn.steps"), you: t("tui.you"),
  }), [items]);
  const end = Math.max(0, allLines.length - offset);
  const visible = allLines.slice(Math.max(0, end - logRows), end);
  const send = (line: string) => void client.send(line).catch((error: unknown) => setNotice(String(error)));

  useInput((keyText, key) => {
    if (key.ctrl && keyText === "d") { exit(); return; }
    if (key.ctrl && keyText === "c") {
      if (state.agents.some((agent) => agent.status === "busy")) send("/interrupt");
      else setNotice(t("tui.exitHint"));
      return;
    }
    if (key.pageUp || key.pageDown) { setOffset((old) => Math.max(0, old + (key.pageUp ? PAGE_ROWS : -PAGE_ROWS))); return; }
    if (key.upArrow && choices.length) { setSelected((old) => (old + choices.length - 1) % choices.length); return; }
    if (key.downArrow && choices.length) { setSelected((old) => (old + 1) % choices.length); return; }
    if (key.tab && suggestion && choices.length) {
      const choice = choices[selected % choices.length];
      if (choice) setInput(input.slice(0, suggestion.from) + choice.insert + input.slice(suggestion.to));
      setSelected(0);
      return;
    }
    if (key.ctrl && keyText === "j") { setInput((old) => `${old}\n`); return; }
    if (key.return) { if (input.trim() === "/exit") exit(); else if (input.trim()) send(input); setInput(""); setSelected(0); setOffset(0); return; }
    if (key.backspace || key.delete) { setInput((old) => old.slice(0, -1)); setSelected(0); return; }
    if (!key.ctrl && !key.meta && keyText) { setInput((old) => old + keyText); setSelected(0); }
  });

  const agentRows = state.agents.map((agent) => {
    const usage = [agent.usage.fiveHourPercent === undefined ? "" : `5h ${agent.usage.fiveHourPercent}%`,
      agent.usage.weeklyPercent === undefined ? "" : `${t("web.gauge.weekly")} ${agent.usage.weeklyPercent}%`].filter(Boolean).join(" ");
    const active = items.findLast((item) => item.kind === "turn" && item.agent === agent.id && item.status === "working");
    const work = active?.kind === "turn" ? active.steps.at(-1) : undefined;
    const current = work ? work.kind === "say" ? work.text : `${work.name}: ${work.input}` : active?.kind === "turn" ? active.plan : "";
    return h(Text, { key: agent.id, wrap: "truncate-end" }, `${agent.id} ${agent.status} · ${agent.model ?? "default"} / ${agent.effort ?? "default"} / ${agent.permission} ${usage}${current ? ` · ${current.replace(/\s+/g, " ")}` : ""}`);
  });
  return h(Box, { flexDirection: "column" },
    h(Text, { bold: true, wrap: "truncate-end" }, state.project || "Clodex"),
    ...agentRows,
    h(Box, { flexDirection: "column", height: logRows, borderStyle: "single", paddingX: 1 }, ...visible.map((line, i) => h(Text, { key: i, wrap: "truncate-end" }, line))),
    ...state.pendingInputs.map((pending) => h(Text, { key: pending.id, dimColor: true, wrap: "truncate-end" }, `${t("tui.pending")} ${pending.id} → ${pending.agent}: ${pending.text}`)),
    ...choices.map((choice, i) => h(Text, { key: `${choice.insert}${i}`, color: i === selected ? "cyan" : undefined }, `${i === selected ? "▸" : " "} ${choice.label}  ${choice.detail}`)),
    h(Text, {}, `${t("tui.input")}: ${input.replace(/\n/g, " ↵ ")}▌`),
    notice ? h(Text, { color: "yellow" }, notice) : null,
  );
};

export const startTui = async (client: FeedClient): Promise<void> => {
  const instance = render(h(App, { client }), { exitOnCtrlC: false });
  await instance.waitUntilExit();
};
