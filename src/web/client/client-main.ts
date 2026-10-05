// Web UI の画面の振る舞い（DESIGN.md §17 Web UI）。
// ブラウザ側にそのまま埋め込むため、外部のものを参照しない 1 つの関数として書く（型の import のみ）。
// 純関数（renderMarkdown 等）とコマンドの一覧は引数で受け取る
import type { AgentId, AgentStatus, TurnResult } from "../../agents/agent-adapter.js";
import type { AgentState } from "../../cli/shell.js";
import type { FeedItem, WebState } from "../web-feed.js";
import type { renderMarkdown as RenderMarkdown } from "./markdown.js";
import type { TimelineItem, applyFeedItem as ApplyFeedItem } from "./timeline.js";
import type { composeInputLine as ComposeInputLine } from "./compose-input.js";
import type { SlashCommand } from "../../cli/commands.js";
import type { Suggestion, createInputAssist as CreateInputAssist } from "./input-assist.js";

export interface ClientDeps {
  renderMarkdown: typeof RenderMarkdown;
  applyFeedItem: typeof ApplyFeedItem;
  composeInputLine: typeof ComposeInputLine;
  createInputAssist: typeof CreateInputAssist;
  commands: readonly SlashCommand[];
  version: string;
}

export function clientMain({ renderMarkdown, applyFeedItem, composeInputLine, createInputAssist, commands, version }: ClientDeps): void {
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
  const STATUS_LABEL: Record<AgentStatus, string> = { busy: "Working", idle: "Idle", starting: "Starting", stopped: "Stopped" };
  const TURN_LABEL: Record<"working" | TurnResult["status"], string> = { working: "Working", interrupted: "Interrupted", failed: "Failed", completed: "" };
  const NEAR_BOTTOM_PX = 120;
  const TOAST_DURATION_MS = 3000;
  const TOKENS_PER_K = 1000;
  const MS_PER_SECOND = 1000;
  const SECONDS_PER_MINUTE = 60;
  const PERCENT = 100;
  // model の入力候補（自由入力もできる）
  const MODEL_SUGGESTIONS: Record<AgentId, readonly string[]> = { claude: ["opus", "sonnet", "haiku"], codex: [] };
  // @path の候補を取り直す間隔（入力欄に入るたびに取ると重い）
  const FILES_REFRESH_MS = 30_000;
  // @path の参照として本文の末尾に足された部分（cli/file-references.ts）。編集で入力欄に戻すときは外す
  const REFERENCES_SEPARATOR = "\n\nReferenced files:\n";
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
  const kTokens = (n: number) => `${Math.round(n / TOKENS_PER_K)}k`;
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
  const controlUpdaters = new WeakMap<HTMLElement, (agent: AgentState) => void>();

  const log = $("#log");
  const newer = $("#newer");
  const input = document.querySelector<HTMLTextAreaElement>("#input")!;

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
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, TOAST_DURATION_MS);
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

  // 作業中のターンの経過時間（1 秒ごとに書き換える）
  const elapsedText = (startIso: string) => {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(startIso).getTime()) / MS_PER_SECOND));
    const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
    return minutes ? `${minutes}分${seconds % SECONDS_PER_MINUTE}秒` : `${seconds}秒`;
  };
  // 今の作業: 直近の発言か tool を 1 行で（DESIGN.md §17 ログ）
  const nowLine = (item: Extract<TimelineItem, { kind: "turn" }>) => {
    const node = el("div", "now");
    const last = item.steps[item.steps.length - 1];
    if (!last) node.append(el("span", "what muted", "作業しています"));
    else if (last.kind === "say") node.append(el("span", "what", last.text.split("\n", 1)[0] ?? ""));
    else node.append(el("span", "k", toolLabel(last.name)), el("span", "what mono", last.input));
    return node;
  };

  const renderTurn = (item: Extract<TimelineItem, { kind: "turn" }>) => {
    const node = el("article", "entry");
    node.append(mark(item.agent));
    const head = el("div", "head");
    head.append(el("b", `c-${item.agent}`, AGENTS[item.agent].name), el("time", "mono", clock(item.at)));
    const label = TURN_LABEL[item.status];
    if (label) head.append(el("span", `state ${item.status}`, label));
    if (item.status === "working") {
      const elapsed = el("span", "elapsed mono", elapsedText(item.at));
      elapsed.dataset.start = item.at;
      head.append(elapsed);
    }
    node.append(head);
    if (item.plan) {
      const plan = el("div", "plan md");
      plan.innerHTML = renderMarkdown(item.plan);
      node.append(plan);
    }
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
    if (item.status === "working") node.append(nowLine(item));
    const body = el("div", "body md");
    if (item.text) body.innerHTML = renderMarkdown(item.text);
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
        const body = el("div", "body md");
        body.innerHTML = renderMarkdown(item.text);
        node.append(mark("you"), head, body);
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

  const syncGauge = (node: HTMLElement, label: string, value: string, percent: number | undefined, over = false, tick?: number) => {
    const key = node.querySelector<HTMLElement>(".k")!;
    const val = node.querySelector<HTMLElement>(".v")!;
    const track = node.querySelector<HTMLElement>(".track")!;
    key.textContent = label;
    val.textContent = value;
    val.classList.toggle("over", over);
    track.querySelector<HTMLElement>("i")!.style.width = `${Math.max(0, Math.min(100, percent ?? 0))}%`;
    let marker = track.querySelector<HTMLElement>(".tick");
    if (tick === undefined) { marker?.remove(); return; }
    if (!marker) {
      marker = el("span", "tick");
      marker.title = "今の時点での目安";
      track.append(marker);
    }
    marker.style.left = `${Math.max(0, Math.min(100, tick))}%`;
  };

  const resetLabel = (epochSeconds: number | undefined, withDate: boolean) => {
    if (epochSeconds === undefined) return "";
    const iso = new Date(epochSeconds * MS_PER_SECOND).toISOString();
    return ` · ${withDate ? shortDate(iso) : clock(iso)} にリセット`;
  };

  // 利用枠とコンテキストのゲージの表示内容。作るときと更新するときで共有する
  const gaugeValues = (usage: AgentState["usage"]) => {
    const pace = usage.weeklyPace;
    const contextValue = usage.contextTokens === undefined
      ? "—" : `${kTokens(usage.contextTokens)}${usage.contextWindow ? ` / ${kTokens(usage.contextWindow)}` : ""}`;
    return [
      {
        label: `5 時間${resetLabel(usage.fiveHourResetsAt, false)}`,
        value: usage.fiveHourPercent === undefined ? "—" : `${usage.fiveHourPercent}%`,
        percent: usage.fiveHourPercent, over: false, tick: undefined,
      },
      {
        label: `週${pace === undefined ? "" : `（ペース ${pace > 0 ? "+" : ""}${pace}）`}${resetLabel(usage.weeklyResetsAt, true)}`,
        value: usage.weeklyPercent === undefined ? "—" : `${usage.weeklyPercent}%`,
        percent: usage.weeklyPercent, over: (pace ?? 0) > 0,
        tick: pace === undefined || usage.weeklyPercent === undefined ? undefined : usage.weeklyPercent - pace,
      },
      {
        label: "コンテキスト", value: contextValue,
        percent: usage.contextTokens && usage.contextWindow ? (usage.contextTokens / usage.contextWindow) * PERCENT : 0,
        over: false, tick: undefined,
      },
    ];
  };

  const describeSettings = (agent: AgentState) =>
    `${agent.model ?? "default"} · effort ${agent.effort ?? "default"} · 権限 ${agent.permission}`;

  // Agent パネル: 設定の要約、利用枠、操作。権限・model・effort は「設定」から開くポップアップで変える
  const agentControls = (agent: AgentState) => {
    const wrap = el("div", "controls");
    const summary = el("div", "setting mono small", describeSettings(agent));
    const gauges = gaugeValues(agent.usage).map((g) => gauge(g.label, g.value, g.percent, agent.id, g.over, g.tick));
    wrap.append(summary, ...gauges);
    const links = el("div", "links");
    const action = (label: string, run: () => void, cls = "", disabled = false) => {
      const button = el("button", cls, label) as HTMLButtonElement;
      button.type = "button";
      button.disabled = disabled;
      button.addEventListener("click", run);
      links.append(button);
      return button;
    };
    const interrupt = action("Interrupt", () => void send(`/interrupt ${agent.id}`), "danger", agent.status !== "busy");
    const compact = action("Compact", () => void send(`/compact ${agent.id}`), "", agent.status === "stopped");
    action("設定", () => openAgentSettings(agent.id));
    wrap.append(links);
    controlUpdaters.set(wrap, (current) => {
      summary.textContent = describeSettings(current);
      gaugeValues(current.usage).forEach((g, index) => {
        const node = gauges[index];
        if (node) syncGauge(node, g.label, g.value, g.percent, g.over, g.tick);
      });
      interrupt.disabled = current.status !== "busy";
      compact.disabled = current.status === "stopped";
    });
    return wrap;
  };

  const stateLabel = (agent: AgentState) => {
    const node = el("span", `state ${agent.status === "busy" ? "working" : ""}`, STATUS_LABEL[agent.status]);
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
      if (agent.permission === "full") figs.append(el("span", "badge", "full"));
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
    renderPending();
    refreshOpenSheet();
  };

  // ---- 送信待ちの入力（取り消し・編集。DESIGN.md §28 v0.3 A） ----
  const renderPending = () => {
    const list = $("#pending");
    const pending = state?.pendingInputs ?? [];
    list.hidden = !pending.length;
    list.replaceChildren(...pending.map((queued) => {
      const original = queued.text.split(REFERENCES_SEPARATOR)[0] ?? queued.text;
      const row = el("li");
      const action = (label: string, run: () => void) => {
        const button = el("button", "", label) as HTMLButtonElement;
        button.type = "button";
        button.addEventListener("click", run);
        return button;
      };
      row.append(
        el("span", "who", `→ ${AGENTS[queued.agent].name} · 送信待ち`),
        el("span", "text", original),
        action("編集", () => void send(`/cancel ${queued.id}`).then((sent) => {
          if (!sent) return;
          target = queued.agent;
          input.value = original;
          input.focus();
          onInputChanged();
          renderState();
        })),
        action("取り消し", () => void send(`/cancel ${queued.id}`)),
      );
      return row;
    }));
  };

  const conversationList = () => {
    if (!state) return [];
    const nodes: HTMLElement[] = state.conversations.map((conversation, index) => {
      const row = el("div", `conv-row${conversation.current ? " current" : ""}`);
      const button = el("button", `conv${conversation.current ? " current" : ""}`) as HTMLButtonElement;
      button.type = "button";
      const meta = `${conversation.pinned ? "固定 · " : ""}${shortDate(conversation.updatedAt)} · ${Object.keys(conversation.sessions).join(", ") || "—"}${conversation.current ? " · 現在" : ""}`;
      button.append(el("span", "t", conversation.title ?? "（入力なし）"), el("span", "m mono", meta));
      button.disabled = conversation.current;
      button.addEventListener("click", () => {
        void send(`/resume ${index + 1}`);
        closeSheet();
      });
      const menu = el("button", "conv-menu", "⋯") as HTMLButtonElement;
      menu.type = "button";
      menu.setAttribute("aria-label", "会話の操作");
      menu.addEventListener("click", () => openConversationMenu(conversation, index + 1));
      row.append(button, menu);
      return row;
    });
    if (!nodes.length) nodes.push(el("p", "muted small", "まだ会話がありません"));
    return nodes;
  };

  // ---- シート（スマホの操作パネル・会話・設定） ----
  let sheetAgent: AgentId | undefined;
  let sheetKind: "agent" | "agentSettings" | "settings" | "conversations" | "conversationMenu" | undefined;
  let pendingPrimary: AgentId | undefined;
  const sheet = $("#sheet");
  const openSheet = (title: string, content: HTMLElement[]) => {
    $("#sheet-title").textContent = title;
    $("#sheet-body").replaceChildren(...content);
    sheet.hidden = false;
  };
  const closeSheet = () => {
    sheet.hidden = true;
    sheetAgent = undefined;
    sheetKind = undefined;
  };
  const openAgentSheet = (id: AgentId) => {
    const agent = state?.agents.find((a) => a.id === id);
    if (!agent) return;
    sheetAgent = id;
    sheetKind = "agent";
    const role = state?.roles[id];
    openSheet(AGENTS[id].name, [...(role ? [el("div", "role", role)] : []), agentControls(agent)]);
  };
  const openConversations = () => {
    sheetKind = "conversations";
    sheetAgent = undefined;
    const fresh = el("button", "primary-action", "新しい会話を始める") as HTMLButtonElement;
    fresh.type = "button";
    fresh.addEventListener("click", () => {
      void send("/new");
      closeSheet();
    });
    openSheet("会話", [fresh, ...conversationList()]);
  };
  const sheetButton = (label: string, cls: string, run: () => void) => {
    const button = el("button", cls, label) as HTMLButtonElement;
    button.type = "button";
    button.addEventListener("click", run);
    return button;
  };
  // 会話の操作: 名前の変更は今の会話だけ（/rename）。今の会話は削除できない
  const openConversationMenu = (conversation: WebState["conversations"][number], number: number) => {
    sheetKind = "conversationMenu";
    sheetAgent = undefined;
    const title = conversation.title ?? "（入力なし）";
    const actions: HTMLElement[] = [];
    if (conversation.current) {
      actions.push(sheetButton("名前を変更", "secondary-action", () => {
        const name = window.prompt("会話の名前", conversation.title ?? "")?.trim();
        if (name) void send(`/rename ${name}`);
        closeSheet();
      }));
    }
    actions.push(sheetButton(conversation.pinned ? "ピン止めを外す" : "ピン止め", "secondary-action", () => {
      void send(`/pin ${number}`);
      closeSheet();
    }));
    if (!conversation.current) {
      actions.push(sheetButton("削除", "secondary-action danger", () => {
        if (window.confirm(`「${title}」を削除しますか？`)) void send(`/delete ${number}`);
        closeSheet();
      }));
    }
    openSheet(title, actions);
  };

  // Agent の設定: 権限・model・effort と、この Agent だけの session のやり直し
  const openAgentSettings = (id: AgentId) => {
    const agent = state?.agents.find((a) => a.id === id);
    if (!agent) return;
    sheetAgent = id;
    sheetKind = "agentSettings";
    const permission = choice("permission", "権限", PERMISSIONS, agent.permission, (v) => v, (v) => void send(`/permission ${id} ${v}`));
    const model = el("div", "setting");
    model.append(el("div", "eyebrow", "Model"));
    const form = el("form", "model-form") as HTMLFormElement;
    const field = el("input") as HTMLInputElement;
    field.name = "model";
    field.autocomplete = "off";
    field.placeholder = agent.model ?? "default";
    field.setAttribute("list", `models-${id}`);
    field.setAttribute("aria-label", `${AGENTS[id].name} の model`);
    const options = el("datalist");
    options.id = `models-${id}`;
    for (const name of MODEL_SUGGESTIONS[id]) {
      const option = el("option") as HTMLOptionElement;
      option.value = name;
      options.append(option);
    }
    const apply = el("button", "", "変更") as HTMLButtonElement;
    apply.type = "submit";
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const value = field.value.trim();
      if (!value) return;
      void send(`/model ${id} ${value}`);
      field.value = "";
    });
    form.append(field, options, apply);
    model.append(form);
    const effort = choice("effort", "Effort", EFFORTS[id], agent.effort ?? "", (v) => v, (v) => void send(`/effort ${id} ${v}`));
    const restart = sheetButton("この Agent だけ session を始め直す", "secondary-action", () => {
      void send(`/new ${id}`);
      closeSheet();
    });
    openSheet(`${AGENTS[id].name} の設定`, [
      permission, model, effort, restart, el("p", "muted small", "会話はそのままで、この Agent の文脈だけを新しくします"),
    ]);
  };

  const choice = <T extends string>(key: string, label: string, options: readonly T[], current: T, name: (v: T) => string, pick: (v: T) => void) => {
    const wrap = el("div", "setting");
    wrap.append(el("div", "eyebrow", label));
    const seg = el("div", "seg");
    seg.dataset.choice = key;
    for (const option of options) {
      const button = el("button", "", name(option)) as HTMLButtonElement;
      button.type = "button";
      button.dataset.value = option;
      button.setAttribute("aria-pressed", String(option === current));
      button.addEventListener("click", () => {
        pick(option);
        for (const selected of seg.querySelectorAll<HTMLButtonElement>("button")) {
          selected.setAttribute("aria-pressed", String(selected === button));
        }
      });
      seg.append(button);
    }
    wrap.append(seg);
    return wrap;
  };
  const openSettings = () => {
    sheetKind = "settings";
    sheetAgent = undefined;
    openSheet("設定", [
      choice("theme", "テーマ", THEMES, theme, (t) => THEME_LABEL[t], (t) => {
        theme = t;
        storage.set(THEME_KEY, t);
        applyTheme(t);
      }),
      choice("primary", "テキストの送り先", AGENT_IDS, target ?? state?.primary ?? "claude", (a) => AGENTS[a].name, (a) => {
        target = a;
        pendingPrimary = a;
        void send(`/primary ${a}`);
        renderState();
      }),
      choice("detail", "作業と全文", ["closed", "open"] as const, detail ? "open" : "closed", (v) => (v === "open" ? "開いて表示" : "畳んで表示"), (v) => setDetail(v === "open")),
    ]);
  };

  const refreshOpenSheet = () => {
    if (sheet.hidden) return;
    if (sheetKind === "agent" && sheetAgent) {
      const agent = state?.agents.find((candidate) => candidate.id === sheetAgent);
      const controls = $("#sheet-body").querySelector<HTMLElement>(".controls");
      if (agent && controls) controlUpdaters.get(controls)?.(agent);
    }
    if (sheetKind === "agentSettings" && sheetAgent) {
      const agent = state?.agents.find((candidate) => candidate.id === sheetAgent);
      if (!agent) return;
      const body = $("#sheet-body");
      const press = (key: string, value: string | undefined) => {
        for (const button of body.querySelectorAll<HTMLButtonElement>(`[data-choice="${key}"] button`)) {
          button.setAttribute("aria-pressed", String(button.dataset.value === value));
        }
      };
      press("permission", agent.permission);
      press("effort", agent.effort);
      const field = body.querySelector<HTMLInputElement>('input[name="model"]');
      if (field) field.placeholder = agent.model ?? "default";
    }
    if (sheetKind === "settings") {
      const selected = target ?? state?.primary;
      const buttons = $("#sheet-body").querySelectorAll<HTMLButtonElement>('[data-choice="primary"] button');
      for (const button of buttons) {
        button.setAttribute("aria-pressed", String(button.dataset.value === selected));
      }
    }
  };

  $("#sheet-close").addEventListener("click", closeSheet);
  $("#sheet-backdrop").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) closeSheet(); });
  $("#open-conversations").addEventListener("click", openConversations);
  $("#open-settings").addEventListener("click", openSettings);
  $("#new-conversation").addEventListener("click", () => void send("/new"));

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
    const sent = await send(composeInputLine(text, to));
    sendButton.disabled = false;
    if (!sent) return;
    if (input.value.trim() === text) input.value = "";
    onInputChanged();
    scrollToBottom();
  };
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    void submit();
  });
  // ---- 入力の補助（候補と強調表示。DESIGN.md §28 v0.3 A） ----
  const assist = createInputAssist(commands, AGENT_IDS);
  const highlightLayer = $("#input-highlight");
  const suggestList = $("#suggest");
  let files: string[] = [];
  let fileSet = new Set<string>();
  let filesLoadedAt = 0;
  let suggestion: Suggestion | undefined;
  let selected = 0;

  const renderHighlight = () => {
    const nodes: Node[] = assist.highlight(input.value, fileSet).map((segment) => {
      if (!segment.kind) return document.createTextNode(segment.text);
      return el("mark", segment.kind === "agent" ? `hl-${segment.text.slice(1)}` : `hl-${segment.kind}`, segment.text);
    });
    // 末尾の改行も高さに反映されるよう、幅の無い文字を足す
    highlightLayer.replaceChildren(...nodes, document.createTextNode("\u200b"));
    highlightLayer.scrollTop = input.scrollTop;
  };
  const closeSuggest = () => {
    suggestion = undefined;
    suggestList.hidden = true;
    input.setAttribute("aria-expanded", "false");
  };
  const accept = (index: number) => {
    const item = suggestion?.items[index];
    if (!suggestion || !item) return;
    const { from, to } = suggestion;
    input.value = input.value.slice(0, from) + item.insert + input.value.slice(to).replace(/^ /, "");
    const caret = from + item.insert.length;
    input.focus();
    input.setSelectionRange(caret, caret);
    onInputChanged();
  };
  const renderSuggest = () => {
    if (!suggestion) return closeSuggest();
    suggestList.replaceChildren(...suggestion.items.map((item, index) => {
      const option = el("li");
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === selected));
      option.append(el("span", "l", item.label), el("span", "d", item.detail));
      // 入力欄のフォーカスを外さずに選ぶ
      option.addEventListener("pointerdown", (e) => e.preventDefault());
      option.addEventListener("click", () => accept(index));
      return option;
    }));
    suggestList.hidden = false;
    input.setAttribute("aria-expanded", "true");
    suggestList.children[selected]?.scrollIntoView({ block: "nearest" });
  };
  const updateSuggest = () => {
    const caret = input.selectionStart;
    suggestion = caret === input.selectionEnd ? assist.suggest(input.value, caret, files) : undefined;
    selected = 0;
    renderSuggest();
  };
  const loadFiles = async () => {
    if (Date.now() - filesLoadedAt < FILES_REFRESH_MS) return;
    filesLoadedAt = Date.now();
    try {
      const response = await fetch("/api/files");
      if (!response.ok) return;
      files = (await response.json()) as string[];
      fileSet = new Set(files);
      renderHighlight();
    } catch { /* 候補が出ないだけで入力はできる */ }
  };
  function onInputChanged() {
    resize();
    renderHighlight();
    updateSuggest();
  }

  input.addEventListener("input", onInputChanged);
  input.addEventListener("focus", () => void loadFiles());
  input.addEventListener("blur", closeSuggest);
  input.addEventListener("scroll", () => { highlightLayer.scrollTop = input.scrollTop; });
  input.addEventListener("click", updateSuggest);
  input.addEventListener("keyup", (e) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) updateSuggest();
  });
  // PC は Enter で送信。スマホは Enter で改行し、送信はボタン（日本語入力の誤送信を防ぐ）
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (suggestion) {
      const count = suggestion.items.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        selected = (selected + (e.key === "ArrowDown" ? 1 : count - 1)) % count;
        return renderSuggest();
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !coarse)) {
        e.preventDefault();
        return accept(selected);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        return closeSuggest();
      }
    }
    if (coarse || e.key !== "Enter" || e.shiftKey) return;
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
  setInterval(() => {
    for (const node of log.querySelectorAll<HTMLElement>(".elapsed[data-start]")) node.textContent = elapsedText(node.dataset.start ?? "");
  }, MS_PER_SECOND);
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
      // Clodex が更新されて起動し直したら、古い画面のまま使わない
      if (item.type === "version") {
        if (item.version !== version) location.reload();
        return;
      }
      if (item.type === "state") {
        state = item.state;
        if (pendingPrimary && state.primary === pendingPrimary) {
          if (target === pendingPrimary) target = undefined;
          pendingPrimary = undefined;
        }
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
