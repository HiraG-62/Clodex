// Web UI の画面の振る舞い（DESIGN.md §17 Web UI）。
// ブラウザ側にそのまま埋め込むため、外部のものを参照しない 1 つの関数として書く（型の import のみ）。
// renderMarkdown と applyFeedItem は引数で受け取る
import type { AgentId } from "../../agents/agent-adapter.js";
import type { AgentState } from "../../cli/shell.js";
import type { FeedItem, WebState } from "../web-feed.js";
import type { renderMarkdown as RenderMarkdown } from "./markdown.js";
import type { TimelineItem, applyFeedItem as ApplyFeedItem } from "./timeline.js";

export function clientMain(renderMarkdown: typeof RenderMarkdown, applyFeedItem: typeof ApplyFeedItem): void {
  const AGENTS: Record<AgentId, { name: string; mark: string }> = {
    claude: { name: "Claude", mark: "C" },
    codex: { name: "Codex", mark: "X" },
  };
  const AGENT_IDS: AgentId[] = ["claude", "codex"];
  const PERMISSIONS = ["read-only", "edit", "full"] as const;
  const EFFORTS: Record<AgentId, readonly string[]> = {
    claude: ["low", "medium", "high", "xhigh", "max"],
    codex: ["minimal", "low", "medium", "high", "xhigh"],
  };
  const THEMES = ["system", "light", "dark"] as const;
  type Theme = (typeof THEMES)[number];
  const THEME_LABEL: Record<Theme, string> = { system: "システム", light: "ライト", dark: "ダーク" };
  const STATUS_LABEL: Record<string, string> = { busy: "Working", idle: "Idle", starting: "Starting", stopped: "Stopped" };
  const TURN_LABEL: Record<string, string> = { working: "Working", interrupted: "Interrupted", failed: "Failed", completed: "" };
  const NEAR_BOTTOM_PX = 120;
  const THEME_KEY = "clodex-theme";
  const DETAIL_KEY = "clodex-detail";

  const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;
  const el = (tag: string, className?: string, text?: string) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const clock = (iso: string) => {
    const d = new Date(iso);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const shortDate = (iso: string) => {
    const d = new Date(iso);
    return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${clock(iso)}`;
  };
  const kTokens = (n: number) => `${Math.round(n / 1000)}k`;
  const storage = {
    get: (key: string) => { try { return localStorage.getItem(key); } catch { return null; } },
    set: (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* 保存できなくても動く */ } },
  };
  const mark = (agent: AgentId | "you") => {
    const node = el("span", `mark ${agent}`, agent === "you" ? "Y" : AGENTS[agent].mark);
    node.setAttribute("aria-hidden", "true");
    return node;
  };

  // ---- 状態 ----
  let items: TimelineItem[] = [];
  let state: WebState | undefined;
  let detail = storage.get(DETAIL_KEY) === "1";
  let target: AgentId | undefined; // undefined なら primary に送る
  const opened = new Map<string, boolean>(); // 人が開閉した details の状態（項目 ID ごと）
  const rendered = new Map<string, { item: TimelineItem; node: HTMLElement }>();

  const log = $("#log");
  const newer = $("#newer");
  const input = $("#input") as unknown as HTMLTextAreaElement;

  // ---- 送信 ----
  // 送れたら true。失敗したら理由をトーストで出す
  const send = async (line: string): Promise<boolean> => {
    try {
      const response = await fetch("/api/input", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ line }),
      });
      if (response.ok) return true;
      showToast(`送信できませんでした（${response.status}）`);
    } catch {
      showToast("送信できませんでした。接続を確認してください");
    }
    return false;
  };

  // ---- テーマ ----
  const applyTheme = (theme: Theme) => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  };
  let theme = (THEMES as readonly string[]).includes(storage.get(THEME_KEY) ?? "") ? storage.get(THEME_KEY) as Theme : "system";
  applyTheme(theme);

  // ---- トースト ----
  let toastTimer: number | undefined;
  const showToast = (text: string) => {
    const toast = $("#toast");
    toast.textContent = text;
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3000);
  };

  // ---- ログの描画 ----
  const details = (id: string, summary: string, body: HTMLElement, cls: string) => {
    const node = el("details", cls) as HTMLDetailsElement;
    node.open = opened.get(id) ?? detail;
    node.append(el("summary", "", summary), body);
    node.addEventListener("toggle", () => opened.set(id, node.open));
    return node;
  };

  // tool 名を短い種類にする（Claude: Read / Bash / mcp__clodex__send_message、Codex: command / clodex.send_message）
  const toolLabel = (name: string) => {
    if (name.includes("send_message")) return "send";
    if (name === "command" || name === "Bash" || name === "PowerShell") return "run";
    const short = name.replace(/^mcp__/, "").toLowerCase();
    return short.length > 8 ? `${short.slice(0, 7)}…` : short;
  };

  const renderTurn = (item: Extract<TimelineItem, { kind: "turn" }>) => {
    const node = el("article", "entry");
    node.append(mark(item.agent));
    const head = el("div", "head");
    head.append(el("b", `c-${item.agent}`, AGENTS[item.agent].name), el("time", "mono", clock(item.at)));
    const label = TURN_LABEL[item.status];
    if (label) head.append(el("span", `state ${item.status}`, label));
    node.append(head);
    if (item.steps.length) {
      const list = el("ol");
      for (const step of item.steps) {
        const li = el("li");
        if (step.kind === "say") li.append(el("span", "k", "say"), el("span", "say", step.text));
        else li.append(el("span", "k", toolLabel(step.name)), el("span", "run", step.input));
        list.append(li);
      }
      node.append(details(item.id, `作業 ${item.steps.length} 件`, list, "steps"));
    }
    const body = el("div", "body md");
    if (item.text) body.innerHTML = renderMarkdown(item.text);
    else if (item.status === "working") body.append(el("span", "muted", "作業しています"));
    else if (item.status === "completed") body.append(el("span", "muted", "完了"));
    if (body.childNodes.length) node.append(body);
    return node;
  };

  const renderMessage = (item: Extract<TimelineItem, { kind: "message" }>) => {
    const { message } = item;
    const node = el("section", "handoff");
    const route = el("div", "route");
    route.append(mark(message.from), el("span", "arrow", "→"), mark(message.to), el("span", "kind", message.type));
    if (message.status) route.append(el("span", "kind", message.status.replace(/_/g, " ").toUpperCase()));
    route.append(el("span", "task mono", `${message.taskId} · ${clock(item.at)}`));
    const text = el("div", "text md");
    text.innerHTML = renderMarkdown(message.body);
    node.append(route, text);
    if (message.files?.length) {
      const refs = el("div", "refs");
      for (const file of message.files) refs.append(el("span", "ref", file));
      node.append(refs);
    }
    for (const issue of message.issues ?? []) {
      const finding = el("div", `finding ${issue.severity}`);
      finding.append(el("span", "sev", issue.severity), el("span", "loc", issue.line ? `${issue.file}:${issue.line}` : issue.file), el("span", "desc", issue.summary));
      node.append(finding);
    }
    if (item.envelope) node.append(details(item.id, `${AGENTS[message.to].name} に送った全文`, el("pre", "", item.envelope), "envelope"));
    return node;
  };

  const renderItem = (item: TimelineItem): HTMLElement => {
    switch (item.kind) {
      case "human": {
        const node = el("article", "entry you");
        const head = el("div", "head");
        head.append(el("b", "", "あなた"), el("span", `c-${item.agent}`, `→ ${AGENTS[item.agent].name}`), el("time", "mono", clock(item.at)));
        node.append(mark("you"), head, el("div", "body plain", item.text));
        return node;
      }
      case "turn": return renderTurn(item);
      case "message": return renderMessage(item);
      case "notice": return el("div", "notice", item.text);
      case "error": return el("div", "error-row", `${AGENTS[item.agent].name}: ${item.text}`);
      case "output": return el("pre", "output", item.text);
    }
  };

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < NEAR_BOTTOM_PX;
  const scrollToBottom = () => {
    log.scrollTop = log.scrollHeight;
    newer.hidden = true;
  };

  // 変わった項目だけ描き直す（開閉やスクロール位置を保つ）
  const renderLog = (force = false) => {
    const stick = nearBottom();
    const keep = new Set(items.map((i) => i.id));
    for (const [id, entry] of rendered) {
      if (!keep.has(id)) {
        entry.node.remove();
        rendered.delete(id);
      }
    }
    let previous: HTMLElement | undefined;
    for (const item of items) {
      const current = rendered.get(item.id);
      let node = current?.node;
      if (!current || current.item !== item || force) {
        node = renderItem(item);
        if (current) current.node.replaceWith(node);
        rendered.set(item.id, { item, node });
      }
      // まだ DOM に無い要素、または位置がずれた要素を、直前の要素の後ろへ置く
      if (node && (node.parentNode !== log || node.previousElementSibling !== (previous ?? null))) {
        if (previous) previous.after(node); else log.prepend(node);
      }
      previous = node;
    }
    $("#empty").hidden = items.length > 0;
    if (stick) scrollToBottom(); else newer.hidden = false;
  };

  // ---- 状態の描画 ----
  const gauge = (label: string, value: string, percent: number | undefined, agent: AgentId, over = false, tick?: number) => {
    const node = el("div", "gauge");
    node.append(el("span", "k", label), el("span", `v mono${over ? " over" : ""}`, value));
    const track = el("span", `track ${agent}`);
    const fill = el("i");
    fill.style.width = `${Math.max(0, Math.min(100, percent ?? 0))}%`;
    track.append(fill);
    if (tick !== undefined) {
      const t = el("span", "tick");
      t.style.left = `${Math.max(0, Math.min(100, tick))}%`;
      t.title = "今の時点での目安";
      track.append(t);
    }
    node.append(track);
    return node;
  };

  const agentControls = (agent: AgentState) => {
    const wrap = el("div", "controls");
    const { usage } = agent;
    wrap.append(el("div", "setting", `Model: ${agent.model ?? "default"} · Effort: ${agent.effort ?? "default"}`));
    const pace = usage.weeklyPace;
    wrap.append(
      gauge("5 時間", usage.fiveHourPercent === undefined ? "—" : `${usage.fiveHourPercent}%`, usage.fiveHourPercent, agent.id),
      gauge(pace === undefined ? "週" : `週（ペース ${pace > 0 ? "+" : ""}${pace}）`, usage.weeklyPercent === undefined ? "—" : `${usage.weeklyPercent}%`,
        usage.weeklyPercent, agent.id, (pace ?? 0) > 0, pace === undefined || usage.weeklyPercent === undefined ? undefined : usage.weeklyPercent - pace),
      gauge("コンテキスト", usage.contextTokens === undefined ? "—" : `${kTokens(usage.contextTokens)}${usage.contextWindow ? ` / ${kTokens(usage.contextWindow)}` : ""}`,
        usage.contextTokens && usage.contextWindow ? (usage.contextTokens / usage.contextWindow) * 100 : 0, agent.id),
    );
    wrap.append(el("div", "eyebrow", "権限"));
    const seg = el("div", "seg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", `${AGENTS[agent.id].name} の権限`);
    for (const level of PERMISSIONS) {
      const button = el("button", "", level) as HTMLButtonElement;
      button.type = "button";
      button.setAttribute("aria-pressed", String(agent.permission === level));
      button.addEventListener("click", () => void send(`/permission ${agent.id} ${level}`));
      seg.append(button);
    }
    wrap.append(seg);
    wrap.append(el("div", "eyebrow", "Effort"));
    const effort = el("div", "seg");
    effort.setAttribute("role", "group");
    effort.setAttribute("aria-label", `${AGENTS[agent.id].name} の effort`);
    for (const level of EFFORTS[agent.id]) {
      const button = el("button", "", level) as HTMLButtonElement;
      button.type = "button";
      button.setAttribute("aria-pressed", String(agent.effort === level));
      button.addEventListener("click", () => void send(`/effort ${agent.id} ${level}`));
      effort.append(button);
    }
    wrap.append(effort);
    const links = el("div", "links");
    const action = (label: string, command: string, cls = "", disabled = false) => {
      const button = el("button", cls, label) as HTMLButtonElement;
      button.type = "button";
      button.disabled = disabled;
      button.addEventListener("click", () => void send(command));
      links.append(button);
    };
    action("Interrupt", `/interrupt ${agent.id}`, "danger", agent.status !== "busy");
    action("Compact", `/compact ${agent.id}`, "", agent.status === "stopped");
    action("New", `/new ${agent.id}`);
    wrap.append(links);
    return wrap;
  };

  const stateLabel = (agent: AgentState) => {
    const node = el("span", `state ${agent.status === "busy" ? "working" : ""}`, STATUS_LABEL[agent.status] ?? agent.status);
    return node;
  };

  const renderState = () => {
    if (!state) return;
    $("#path").textContent = state.project;
    // スマホ: 状態の行
    const rows = $("#status");
    rows.replaceChildren(...state.agents.map((agent) => {
      const row = el("button", "status-row") as HTMLButtonElement;
      row.type = "button";
      row.setAttribute("aria-label", `${AGENTS[agent.id].name} の操作を開く`);
      const figs = el("span", "figs");
      const fig = (k: string, v: string) => {
        const span = el("span", "", `${k} `);
        span.append(el("b", "mono", v));
        return span;
      };
      figs.append(el("span", `name c-${agent.id}`, AGENTS[agent.id].name));
      if (agent.usage.contextTokens !== undefined) figs.append(fig("ctx", kTokens(agent.usage.contextTokens)));
      if (agent.usage.fiveHourPercent !== undefined) figs.append(fig("5h", `${agent.usage.fiveHourPercent}%`));
      if (agent.usage.weeklyPace !== undefined) figs.append(fig("週", `${agent.usage.weeklyPace > 0 ? "+" : ""}${agent.usage.weeklyPace}`));
      figs.append(fig("権限", agent.permission));
      figs.append(fig("model", agent.model ?? "default"), fig("effort", agent.effort ?? "default"));
      row.append(mark(agent.id), figs, stateLabel(agent));
      row.addEventListener("click", () => openAgentSheet(agent.id));
      return row;
    }));
    // PC: Agent パネル
    $("#agents").replaceChildren(...state.agents.map((agent) => {
      const section = el("section", "agent");
      const h2 = el("h2");
      h2.append(mark(agent.id), el("span", "", AGENTS[agent.id].name), stateLabel(agent));
      section.append(h2);
      const role = state?.roles[agent.id];
      if (role) section.append(el("div", "role", role));
      section.append(agentControls(agent));
      return section;
    }));
    $("#conversations").replaceChildren(...conversationList());
    // 送り先: 人が選んでいなければ primary に合わせる
    for (const button of document.querySelectorAll<HTMLButtonElement>(".to button")) {
      const id = button.dataset.agent as AgentId;
      button.setAttribute("aria-pressed", String((target ?? state.primary) === id));
    }
    if (sheetAgent) openAgentSheet(sheetAgent);
  };

  const conversationList = () => {
    if (!state) return [];
    const nodes: HTMLElement[] = state.conversations.map((conversation, index) => {
      const button = el("button", `conv${conversation.current ? " current" : ""}`) as HTMLButtonElement;
      button.type = "button";
      button.append(el("span", "t", conversation.title ?? "（入力なし）"),
        el("span", "m mono", `${shortDate(conversation.updatedAt)} · ${Object.keys(conversation.sessions).join(", ") || "—"}${conversation.current ? " · 現在" : ""}`));
      button.disabled = conversation.current;
      button.addEventListener("click", () => {
        void send(`/resume ${index + 1}`);
        closeSheet();
      });
      return button;
    });
    if (!nodes.length) nodes.push(el("p", "muted small", "まだ会話がありません"));
    return nodes;
  };

  // ---- シート（スマホの操作パネル・会話・設定） ----
  let sheetAgent: AgentId | undefined;
  const sheet = $("#sheet");
  const openSheet = (title: string, content: HTMLElement[]) => {
    $("#sheet-title").textContent = title;
    $("#sheet-body").replaceChildren(...content);
    sheet.hidden = false;
  };
  const closeSheet = () => {
    sheet.hidden = true;
    sheetAgent = undefined;
  };
  const openAgentSheet = (id: AgentId) => {
    const agent = state?.agents.find((a) => a.id === id);
    if (!agent) return;
    sheetAgent = id;
    const role = state?.roles[id];
    openSheet(AGENTS[id].name, [...(role ? [el("div", "role", role)] : []), agentControls(agent)]);
  };
  const openConversations = () => {
    const fresh = el("button", "primary-action", "新しい会話を始める") as HTMLButtonElement;
    fresh.type = "button";
    fresh.addEventListener("click", () => {
      void send("/new");
      closeSheet();
    });
    openSheet("会話", [fresh, ...conversationList()]);
  };
  const choice = <T extends string>(label: string, options: readonly T[], current: T, name: (v: T) => string, pick: (v: T) => void) => {
    const wrap = el("div", "setting");
    wrap.append(el("div", "eyebrow", label));
    const seg = el("div", "seg");
    for (const option of options) {
      const button = el("button", "", name(option)) as HTMLButtonElement;
      button.type = "button";
      button.setAttribute("aria-pressed", String(option === current));
      button.addEventListener("click", () => {
        pick(option);
        openSettings();
      });
      seg.append(button);
    }
    wrap.append(seg);
    return wrap;
  };
  const openSettings = () => openSheet("設定", [
    choice("テーマ", THEMES, theme, (t) => THEME_LABEL[t], (t) => {
      theme = t;
      storage.set(THEME_KEY, t);
      applyTheme(t);
    }),
    choice("テキストの送り先", AGENT_IDS, state?.primary ?? "claude", (a) => AGENTS[a].name, (a) => {
      target = undefined;
      void send(`/primary ${a}`);
    }),
    choice("作業と全文", ["closed", "open"] as const, detail ? "open" : "closed", (v) => (v === "open" ? "開いて表示" : "畳んで表示"), (v) => setDetail(v === "open")),
  ]);

  $("#sheet-close").addEventListener("click", closeSheet);
  $("#sheet-backdrop").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) closeSheet(); });
  $("#open-conversations").addEventListener("click", openConversations);
  $("#open-settings").addEventListener("click", openSettings);

  // ---- 詳細表示 ----
  const detailButton = $("#detail");
  const setDetail = (value: boolean) => {
    detail = value;
    storage.set(DETAIL_KEY, value ? "1" : "0");
    opened.clear();
    detailButton.setAttribute("aria-pressed", String(value));
    renderLog(true);
  };
  detailButton.setAttribute("aria-pressed", String(detail));
  detailButton.addEventListener("click", () => setDetail(!detail));

  // ---- 入力 ----
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const resize = () => {
    input.style.height = "";
    input.style.height = `${input.scrollHeight}px`;
    input.style.overflowY = input.scrollHeight > input.clientHeight ? "auto" : "hidden";
  };
  // 送信に成功してから入力欄を空にする（失敗しても書いた内容を失わない）
  const sendButton = $("#composer .send") as HTMLButtonElement;
  const submit = async () => {
    const text = input.value.trim();
    if (!text || sendButton.disabled) return;
    const to = target ?? state?.primary;
    sendButton.disabled = true;
    const sent = await send(text.startsWith("/") || text.startsWith("@") || !to ? text : `@${to} ${text}`);
    sendButton.disabled = false;
    if (!sent) return;
    if (input.value.trim() === text) input.value = "";
    resize();
    scrollToBottom();
  };
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    void submit();
  });
  input.addEventListener("input", resize);
  // PC は Enter で送信。スマホは Enter で改行し、送信はボタン（日本語入力の誤送信を防ぐ）
  input.addEventListener("keydown", (e) => {
    if (coarse || e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    void submit();
  });
  input.placeholder = coarse ? "メッセージ、または /status などのコマンド" : "メッセージ、または /status などのコマンド（Enter で送信）";
  for (const button of document.querySelectorAll<HTMLButtonElement>(".to button")) {
    button.addEventListener("click", () => {
      target = button.dataset.agent as AgentId;
      renderState();
    });
  }

  newer.addEventListener("click", scrollToBottom);
  log.addEventListener("scroll", () => { if (nearBottom()) newer.hidden = true; });

  // ---- 接続 ----
  const conn = $("#conn");
  const connect = () => {
    const events = new EventSource("/events");
    events.onopen = () => {
      // 接続（再接続を含む）のたびに履歴が送り直されるので作り直す
      items = [];
      opened.clear();
      conn.hidden = true;
      renderLog();
    };
    events.onmessage = (e: MessageEvent<string>) => {
      const item = JSON.parse(e.data) as FeedItem;
      if (item.type === "state") {
        state = item.state;
        renderState();
        return;
      }
      if (item.type === "reset") opened.clear();
      items = applyFeedItem(items, item);
      renderLog();
    };
    events.onerror = () => { conn.hidden = false; };
  };
  connect();
}
