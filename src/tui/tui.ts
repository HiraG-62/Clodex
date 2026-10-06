import React, { useEffect, useMemo, useRef, useState } from "react";
import { spawn } from "node:child_process";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { slashCommands } from "../cli/commands.js";
import { t } from "../i18n/i18n.js";
import { createInputAssist } from "../web/client/input-assist.js";
import type { WebState } from "../web/web-feed.js";
import type { FeedClient } from "./feed-client.js";
import { advanceTerminalFeed, CardLineCache, cursorSlices, editInput, parseSgrMouse, TERMINAL_COLORS,
  scrollAfterGrowth, scrollBy, scrollToBottom, textWidth, visibleRange, WHEEL_LINES, wrapText,
  type InputBuffer, type ScrollState, type TerminalFeed, type TerminalLabels } from "./terminal-layout.js";

const h = React.createElement;
const MAX_SUGGESTIONS = 5;
const SPINNER_INTERVAL_MS = 250;
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x200;
const POWERSHELL_VT_SCRIPT = `
Add-Type -Namespace W -Name K -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr h, uint m);
'@
$h = [W.K]::GetStdHandle(-10)
$m = 0
if (-not [W.K]::GetConsoleMode($h, [ref]$m)) { exit 1 }
if (-not [W.K]::SetConsoleMode($h, $m -bor 0x${ENABLE_VIRTUAL_TERMINAL_INPUT.toString(16)})) { exit 1 }
`;
export const ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1006h";
export const DISABLE_MOUSE_TRACKING = "\x1b[?1006l\x1b[?1000l";
export const TUI_RENDER_OPTIONS = { exitOnCtrlC: false, alternateScreen: true } as const;
const { line: LINE_COLOR, muted: MUTED_COLOR, warn: WARN_COLOR,
  claude: CLAUDE_COLOR, codex: CODEX_COLOR } = TERMINAL_COLORS;
const EMPTY_STATE: WebState = { project: "", primary: "claude", roles: {}, agents: [], conversations: [], pendingInputs: [] };
const EMPTY_FEED: TerminalFeed = { timeline: [], completed: [] };

const runWindowsConsoleMode = (): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_VT_SCRIPT],
    { stdio: ["inherit", "ignore", "ignore"], windowsHide: true });
  child.once("error", reject);
  child.once("close", (code) => { if (code === 0) resolve(); else reject(new Error(`SetConsoleMode: ${code}`)); });
});

export const enableVirtualTerminalInput = async (platform: string = process.platform,
  run: () => Promise<void> = runWindowsConsoleMode): Promise<void> => {
  if (platform !== "win32") return;
  await run();
};

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

export const TuiApp = ({ client, onExit, startMouse }: {
  client: FeedClient; onExit?: () => void; startMouse?: () => Promise<void>;
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const terminal = stdout as NodeJS.WriteStream;
  const [size, setSize] = useState({ columns: terminal.columns ?? 80, rows: terminal.rows ?? 24 });
  const [feed, setFeed] = useState<TerminalFeed>(EMPTY_FEED);
  const [state, setState] = useState<WebState>(EMPTY_STATE);
  const [files, setFiles] = useState<string[]>([]);
  const [buffer, setBuffer] = useState<InputBuffer>({ text: "", cursor: 0 });
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [scroll, setScroll] = useState<ScrollState>(scrollToBottom);
  const cache = useRef(new CardLineCache());
  const previousLineCount = useRef(0);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
  const assist = useMemo(makeAssist, []);
  const cardLabels = useMemo(labels, []);

  useEffect(() => () => onExit?.(), [onExit]);

  useEffect(() => {
    const resize = () => setSize({ columns: terminal.columns ?? 80, rows: terminal.rows ?? 24 });
    stdout.on("resize", resize);
    return () => { stdout.off("resize", resize); };
  }, [terminal]);

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
      else setFeed((old) => advanceTerminalFeed(old, item, false));
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
  const nowSeconds = (at: string) => Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  const logLines = [...feed.completed.flatMap(({ item, elapsedSeconds }) =>
    cache.current.lines(item, cardLabels, expanded, size.columns,
      elapsedSeconds === undefined ? undefined : t("tui.elapsed", { seconds: elapsedSeconds }))),
    ...feed.timeline.filter((item) => item.kind === "turn").flatMap((item) =>
      cache.current.lines(item, cardLabels, expanded, size.columns, t("tui.elapsed", { seconds: nowSeconds(item.at) })))];
  const agentRows = state.agents.reduce((count, agent) => count + 1 + (feed.timeline.some((item) => item.kind === "turn" && item.agent === agent.id && item.status === "working") ? 1 : 0), 0);
  const inputRows = Math.max(1, buffer.text.split("\n").reduce((count, line) => count + wrapText(line, size.columns - 4).length, 0)) + 2;
  const fixedRows = agentRows + inputRows + (choices.length ? choices.length + 2 : 0) + (notice ? 1 : 0) + 1;
  const logHeight = Math.max(0, size.rows - fixedRows);
  useEffect(() => {
    const previous = previousLineCount.current;
    previousLineCount.current = logLines.length;
    setScroll((old) => scrollAfterGrowth(old, previous, logLines.length, logHeight));
  }, [logLines.length, logHeight]);
  const range = visibleRange(logLines.length, logHeight, scroll.offset);
  const shown = logLines.slice(range.start, range.end);
  if (scroll.unseen && shown.length) {
    const marker = t("tui.newItems");
    const last = shown.at(-1);
    const prefix = wrapText(last?.text ?? "", Math.max(1, size.columns - textWidth(marker) - 1))[0] ?? "";
    shown[shown.length - 1] = { text: `${prefix}${" ".repeat(Math.max(1, size.columns - textWidth(prefix) - textWidth(marker)))}${marker}`, color: WARN_COLOR };
  }
  const send = (line: string) => void client.send(line).catch((error: unknown) => setNotice(String(error)));
  const edit = (action: Parameters<typeof editInput>[1]) => setBuffer((old) => editInput(old, action));

  useInput((keyText, key) => {
    const mouse = parseSgrMouse(keyText);
    if (mouse) {
      if (mouse !== "other") setScroll((old) => scrollBy(old, mouse === "up" ? WHEEL_LINES : -WHEEL_LINES, logLines.length, logHeight));
      return;
    }
    if (key.ctrl && keyText === "d") { exit(); return; }
    if (key.ctrl && keyText === "o") { setExpanded((old) => !old); return; }
    if (key.pageUp || key.pageDown) { setScroll((old) => scrollBy(old, (key.pageUp ? 1 : -1) * Math.max(1, logHeight - 1), logLines.length, logHeight)); return; }
    if (key.ctrl && key.end) { setScroll(scrollToBottom()); return; }
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
      setBuffer({ text: "", cursor: 0 }); setSelected(0); setScroll(scrollToBottom()); return;
    }
    if (key.backspace) { edit({ kind: "backspace" }); setSelected(0); return; }
    if (key.delete) { edit({ kind: "delete" }); setSelected(0); return; }
    if (!key.ctrl && !key.meta && keyText) { edit({ kind: "insert", text: keyText }); setSelected(0); }
  });

  useEffect(() => {
    let active = true;
    void startMouse?.().catch(() => { if (active) setNotice(t("tui.mouseUnavailable")); });
    return () => { active = false; };
  }, [startMouse]);

  const cursor = cursorSlices(buffer);
  const branch = state.conversations.find((conversation) => conversation.current)?.branch;
  const project = `${state.project || "Clodex"}${branch ? ` · ${t("tui.branch", { branch })}` : ""}`;
  return h(Box, { flexDirection: "column" },
    h(Box, { height: logHeight, flexDirection: "column", overflow: "hidden" },
      ...shown.map((line, i) => h(Text, { key: i, wrap: "truncate-end", color: line.color,
        backgroundColor: line.backgroundColor, bold: line.bold, underline: line.underline },
        ...(line.parts ?? [{ text: line.text }]).map((part, j) => h(Text, { key: j, color: part.color, bold: part.bold, underline: part.underline }, part.text)))),
    ),
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

export interface MouseTracking { start: () => void; stop: () => void; }

/** マウスの報告は start で有効にする。Windows の ConPTY は VT 入力モードの後に出した設定しか端末へ渡さないため、起動直後には出さない */
export const withMouseTracking = async (write: (value: string) => void, run: (mouse: MouseTracking) => Promise<void>): Promise<void> => {
  let state: "off" | "on" | "stopped" = "off";
  const start = () => { if (state === "off") { state = "on"; write(ENABLE_MOUSE_TRACKING); } };
  const stop = () => { if (state === "on") write(DISABLE_MOUSE_TRACKING); state = "stopped"; };
  try { await run({ start, stop }); } finally { stop(); }
};

export const startTui = async (client: FeedClient): Promise<void> => {
  const write = (value: string) => { if (process.stdout.isTTY) process.stdout.write(value); };
  await withMouseTracking(write, async (mouse) => {
    const startMouse = async () => { await enableVirtualTerminalInput(); mouse.start(); };
    const instance = render(h(TuiApp, { client, onExit: mouse.stop, startMouse }), TUI_RENDER_OPTIONS);
    const onSignal = () => { mouse.stop(); instance.unmount(); };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try { await instance.waitUntilExit(); }
    finally { process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); }
  });
};
