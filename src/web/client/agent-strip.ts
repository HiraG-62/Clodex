import type { AgentId, AgentStatus } from "../../agents/agent-adapter.js";
import type { AgentState } from "../../cli/shell.js";
import type { ClientContext } from "./store.js";

const RING_RADIUS = "9";
const RING_PATH_LENGTH = 100;
const FIVE_HOUR_ALERT_PERCENT = 90;
const WEEKLY_PACE_ALERT = 15;

export const usageRingAlert = (kind: "fiveHour" | "weekly", value: number | undefined) =>
  value !== undefined && value >= (kind === "fiveHour" ? FIVE_HOUR_ALERT_PERCENT : WEEKLY_PACE_ALERT);

export const isCollapsedAgent = (status: AgentStatus, selected: boolean, expanded: boolean) => status === "stopped" && !selected && !expanded;

export const nextExpandedAgent = (current: AgentId | undefined, clicked: AgentId): AgentId | undefined => (current === clicked ? undefined : clicked);

export const usageRingLabel = (label: string, percent: number | undefined, reset: string) =>
  `${label} ${percent === undefined ? "—" : `${Math.round(percent)}%`}${reset ? ` · reset ${reset}` : ""}`;

const svgCircle = (className: string) => {
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  for (const [key, value] of Object.entries({ cx: "12", cy: "12", r: RING_RADIUS, class: className, pathLength: String(RING_PATH_LENGTH) })) {
    circle.setAttribute(key, value);
  }
  return circle;
};

const ring = (percent: number | undefined, className: string) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const background = svgCircle("bg");
  const foreground = svgCircle("fg");
  foreground.setAttribute("stroke-dasharray", `${Math.min(RING_PATH_LENGTH, Math.max(0, percent ?? 0))} ${RING_PATH_LENGTH}`);
  svg.append(background, foreground);
  return svg;
};

export const contextParts = (ctx: ClientContext, agent: AgentState) => {
  const dot = ctx.el("span", "dot");
  const shield = agent.permission === "full" ? ctx.icon("shield-alert") : undefined;
  shield?.classList.add("shield");
  const percent = agent.usage.contextWindow ? ((agent.usage.contextTokens ?? 0) / agent.usage.contextWindow) * ctx.PERCENT : 0;
  return [dot, ...(shield ? [shield] : []), ring(percent, `ring${agent.usage.contextWarning ? " over" : ""}`)];
};

export const usageRing = (ctx: ClientContext, label: string, percent: number | undefined, reset: string, icon: string, over: boolean) => {
  const node = ctx.el("span", `usage-ring${percent === undefined ? " blank" : ""}${over ? " over" : ""}`);
  const title = usageRingLabel(label, percent, reset);
  node.title = title;
  node.setAttribute("aria-label", title);
  node.append(ring(percent, "ring"), ctx.icon(icon));
  return node;
};

export function createAgentStrip(ctx: ClientContext) {
  // ---- 状態の描画 ----
  const gauge = (
    label: string,
    shortLabel: string,
    labelId: string,
    value: string,
    percent: number | undefined,
    agent: AgentId,
    over = false,
    tick?: number,
    reset = "",
  ) => {
    const node = ctx.el("div", "gauge");
    node.append(ctx.el("span", "k", label), ctx.el("span", `v mono${over ? " over" : ""}`, value));
    node.querySelector<HTMLElement>(".v")!.prepend(ctx.el("span", "gauge-reset", reset));
    node.querySelector<HTMLElement>(".v")!.dataset.compact = percent === undefined ? "—" : `${Math.round(percent)}%`;
    const track = ctx.el("span", `track ${agent}${over && labelId === "ctx" ? " over" : ""}`);
    const fill = ctx.el("i");
    fill.style.width = `${Math.max(0, Math.min(100, percent ?? 0))}%`;
    track.append(fill);
    if (tick !== undefined) {
      const marker = ctx.el("span", "tick");
      marker.style.left = `${Math.max(0, Math.min(100, tick))}%`;
      marker.title = ctx.t("web.gauge.tick");
      track.append(marker);
    }
    node.append(track);
    node.title = `${label}: ${value}`;
    node.dataset.label = labelId;
    node.dataset.shortLabel = shortLabel;
    node.querySelector<HTMLElement>(".k")!.textContent = shortLabel;
    return node;
  };

  const syncGauge = (
    node: HTMLElement,
    label: string,
    shortLabel: string,
    labelId: string,
    value: string,
    percent: number | undefined,
    over = false,
    tick?: number,
    reset = "",
  ) => {
    node.title = `${label}: ${value}`;
    node.dataset.label = labelId;
    node.dataset.shortLabel = shortLabel;
    const key = node.querySelector<HTMLElement>(".k")!;
    const val = node.querySelector<HTMLElement>(".v")!;
    const track = node.querySelector<HTMLElement>(".track")!;
    key.textContent = shortLabel;
    val.replaceChildren(ctx.el("span", "gauge-reset", reset), document.createTextNode(value));
    val.dataset.compact = percent === undefined ? "—" : `${Math.round(percent)}%`;
    val.classList.toggle("over", over);
    track.classList.toggle("over", over && labelId === "ctx");
    track.querySelector<HTMLElement>("i")!.style.width = `${Math.max(0, Math.min(100, percent ?? 0))}%`;
    let marker = track.querySelector<HTMLElement>(".tick");
    if (tick === undefined) {
      marker?.remove();
      return;
    }
    if (!marker) {
      marker = ctx.el("span", "tick");
      marker.title = ctx.t("web.gauge.tick");
      track.append(marker);
    }
    marker.style.left = `${Math.max(0, Math.min(100, tick))}%`;
  };

  const resetLabel = (epochSeconds: number | undefined, withDate: boolean) => {
    if (epochSeconds === undefined) return "";
    const iso = new Date(epochSeconds * ctx.MS_PER_SECOND).toISOString();
    return ctx.t("web.gauge.reset", { time: withDate ? ctx.shortDate(iso) : ctx.clock(iso) });
  };

  // 利用枠とコンテキストのゲージの表示内容。作るときと更新するときで共有する
  const gaugeValues = (usage: AgentState["usage"]) => {
    const pace = usage.weeklyPace;
    const contextValue =
      usage.contextTokens === undefined ? "—" : `${ctx.kTokens(usage.contextTokens)}${usage.contextWindow ? ` / ${ctx.kTokens(usage.contextWindow)}` : ""}`;
    return [
      {
        shortLabel: ctx.t("web.gauge.fiveHour"),
        labelId: "fiveHour",
        label: `${ctx.t("web.gauge.fiveHour")}${resetLabel(usage.fiveHourResetsAt, false)}`,
        value: usage.fiveHourPercent === undefined ? "—" : `${usage.fiveHourPercent}%`,
        percent: usage.fiveHourPercent,
        over: false,
        tick: undefined,
        reset: usage.fiveHourResetsAt === undefined ? "" : ctx.clock(new Date(usage.fiveHourResetsAt * ctx.MS_PER_SECOND).toISOString()),
      },
      {
        shortLabel: ctx.t("web.gauge.weekly"),
        labelId: "weekly",
        label: `${ctx.t("web.gauge.weekly")}${pace === undefined ? "" : ctx.t("web.gauge.pace", { pace: `${pace > 0 ? "+" : ""}${pace}` })}${resetLabel(usage.weeklyResetsAt, true)}`,
        value: usage.weeklyPercent === undefined ? "—" : `${usage.weeklyPercent}%`,
        percent: usage.weeklyPercent,
        over: (pace ?? 0) > 0,
        reset: usage.weeklyResetsAt === undefined ? "" : ctx.shortDate(new Date(usage.weeklyResetsAt * ctx.MS_PER_SECOND).toISOString()),
        tick: pace === undefined || usage.weeklyPercent === undefined ? undefined : usage.weeklyPercent - pace,
      },
      {
        shortLabel: ctx.t("web.gauge.context"),
        labelId: "ctx",
        label: ctx.t("web.gauge.context"),
        value: contextValue,
        percent: usage.contextTokens && usage.contextWindow ? (usage.contextTokens / usage.contextWindow) * ctx.PERCENT : 0,
        over: usage.contextWarning === true,
        tick: undefined,
        reset: "",
      },
    ];
  };

  const detailValues = (usage: AgentState["usage"]) => [
    ...gaugeValues(usage),
    {
      shortLabel: ctx.t("web.gauge.inputTotal"),
      labelId: "inputTotal",
      label: ctx.t("web.gauge.inputTotal"),
      value: usage.inputTotal === undefined ? "—" : ctx.kTokens(usage.inputTotal),
      percent: undefined,
      over: false,
      tick: undefined,
      reset: "",
    },
  ];

  // Agent パネル: 設定の要約、利用枠、操作。権限・model・effort はペンアイコンかチップから開くポップアップで変える
  const agentControls = (agent: AgentState) => {
    const wrap = ctx.el("div", "controls");
    wrap.dataset.agent = agent.id;
    const currentStatus = stateLabel(agent);
    currentStatus.classList.add("mobile-only");
    wrap.append(currentStatus);
    const subagentDetails = ctx.el("div", "subagent-details mobile-only");
    const updateSubagentDetails = (current: AgentState) => {
      subagentDetails.replaceChildren();
      for (const [label, running] of [
        [ctx.t("web.agent.subagents"), current.subagents],
        [ctx.t("web.agent.backgroundTasks"), current.backgroundTasks ?? []],
      ] as const) {
        if (!running.length) continue;
        subagentDetails.append(ctx.el("b", "", `${label} ${running.length}`));
        const list = ctx.el("ul");
        list.append(...running.map(task => ctx.el("li", "", task.description || task.id)));
        subagentDetails.append(list);
      }
    };
    updateSubagentDetails(agent);
    wrap.append(subagentDetails);
    const chips = ctx.el("div", "setting-chips");
    const chip = (label: string) => {
      const button = ctx.el("span", "setting-chip mono", label);
      chips.append(button);
      return button;
    };
    const modelChip = chip(agent.modelLabel ?? ctx.displayDefault(agent.model));
    const effortChip = ctx.EFFORTS[agent.id].length ? chip(ctx.displayDefault(agent.effort)) : undefined;
    const permissionChip = chip(agent.permission);
    const updateChips = (incoming: AgentState) => {
      const current = ctx.displayedAgent(incoming);
      modelChip.textContent = current.modelLabel ?? ctx.displayDefault(current.model);
      if (effortChip) effortChip.textContent = ctx.displayDefault(current.effort);
      permissionChip.replaceChildren(
        ctx.icon(current.permission === "full" ? "shield-alert" : "shield"),
        document.createTextNode(current.permission === "full" ? "" : current.permission),
      );
      modelChip.prepend(ctx.icon("cpu"));
      effortChip?.prepend(ctx.icon("gauge"));
      for (const button of [modelChip, effortChip, permissionChip].filter(button => button !== undefined)) {
        button.title = `${button === permissionChip ? current.permission : button.textContent}`;
        button.setAttribute("aria-label", button.title);
      }
      permissionChip.classList.toggle("warning", current.permission === "full");
      const pending = ctx.store.pendingSettings[agent.id];
      for (const [button, key] of [[modelChip, "model"], ...(effortChip ? [[effortChip, "effort"] as const] : []), [permissionChip, "permission"]] as const) {
        button.classList.toggle("pending", pending?.[key] !== undefined);
        if (pending?.[key] !== undefined) button.title += ` · ${ctx.t("web.setting.pending")}`;
      }
    };
    updateChips(agent);
    const gauges = gaugeValues(agent.usage).map(g => gauge(g.label, g.shortLabel, g.labelId, g.value, g.percent, agent.id, g.over, g.tick, g.reset));
    const minis = ctx.el("div", "mini-gauges");
    minis.append(...gauges);
    const inputTotal = ctx.el("div", "input-total mobile-only");
    const updateInputTotal = (current: AgentState) => {
      inputTotal.textContent = `${ctx.t("web.gauge.inputTotal")} ${current.usage.inputTotal === undefined ? "—" : ctx.kTokens(current.usage.inputTotal)}`;
    };
    updateInputTotal(agent);
    wrap.append(chips, minis, inputTotal);
    const links = ctx.el("div", "links");
    const action = (name: string, label: string, run: () => void, cls = "", disabled = false) => {
      const button = ctx.iconButton(name, label, cls);
      button.type = "button";
      button.disabled = disabled;
      button.addEventListener("click", run);
      button.append(ctx.el("span", "mobile-action-label", label));
      links.append(button);
      return button;
    };
    const interrupt = action(
      "square",
      ctx.t("web.agent.interrupt"),
      () => void ctx.send(`/interrupt ${agent.id}`, interrupt),
      "danger",
      agent.status !== "busy",
    );
    const compact = action("fold", ctx.t("web.agent.compact"), () => void ctx.send(`/compact ${agent.id}`, compact), "", agent.status === "stopped");
    interrupt.dataset.command = `/interrupt ${agent.id}`;
    compact.dataset.command = `/compact ${agent.id}`;
    const settingsButton = roleButton(agent.id);
    settingsButton.append(ctx.el("span", "mobile-action-label", ctx.t("web.top.settings")));
    links.append(settingsButton);
    wrap.append(links);
    ctx.store.controlUpdaters.set(wrap, current => {
      updateChips(current);
      updateSubagentDetails(current);
      updateInputTotal(current);
      currentStatus.className = `state mobile-only ${current.status === "busy" ? "working" : current.status}`;
      currentStatus.textContent = ctx.t(ctx.STATUS_LABEL[current.status]);
      gaugeValues(current.usage).forEach((g, index) => {
        const node = gauges[index];
        if (node) syncGauge(node, g.label, g.shortLabel, g.labelId, g.value, g.percent, g.over, g.tick, g.reset);
      });
      interrupt.disabled = current.status !== "busy";
      compact.disabled = current.status === "stopped";
    });
    return wrap;
  };

  const stateLabel = (agent: AgentState) => {
    const node = ctx.el("span", `state ${agent.status === "busy" ? "working" : agent.status}`, ctx.t(ctx.STATUS_LABEL[agent.status]));
    return node;
  };
  const subagentBadge = (agent: AgentState) => {
    const badges = ctx.el("span", "task-badges");
    for (const [label, icon, running] of [
      [ctx.t("web.agent.subagents"), "list-tree", agent.subagents],
      [ctx.t("web.agent.backgroundTasks"), "terminal", agent.backgroundTasks ?? []],
    ] as const) {
      if (!running.length) continue;
      const badge = ctx.el("span", "subagent-badge");
      badge.title = `${label} ${running.length}\n${running.map(task => task.description || task.id).join("\n")}`;
      badge.setAttribute("aria-label", badge.title);
      badge.append(ctx.icon(icon), ctx.el("span", "", String(running.length)));
      badges.append(badge);
    }
    if (!badges.childElementCount) return undefined;
    badges.title = [...badges.children].map(child => (child as HTMLElement).title).join("\n");
    return badges;
  };
  const roleButton = (id: AgentId) => {
    const button = ctx.iconButton("sliders", ctx.t("web.role.open", { agent: ctx.AGENTS[id].name }), "role-button");
    button.type = "button";
    button.setAttribute("aria-label", ctx.t("web.role.open", { agent: ctx.AGENTS[id].name }));
    button.title = ctx.t("web.role.open", { agent: ctx.AGENTS[id].name });
    button.addEventListener("click", () => ctx.openAgentSettings(id));
    return button;
  };

  const usagePopover = ctx.$("#usage-popover");
  const toggleUsage = (agent: AgentId) => {
    if (ctx.wideUsage.matches) return;
    if (ctx.store.usageAgent === agent) ctx.closeUsage();
    else {
      ctx.store.usageAgent = agent;
      ctx.refreshUsage();
    }
  };
  const closeUsage = () => {
    ctx.store.usageAgent = undefined;
    usagePopover.hidden = true;
    for (const button of document.querySelectorAll("#agents button.usage-trigger")) button.setAttribute("aria-expanded", "false");
  };
  const positionUsage = () => {
    if (!ctx.store.usageAgent || usagePopover.hidden) return;
    const card = document.querySelector<HTMLElement>(`#agents [data-agent="${ctx.store.usageAgent}"]`);
    if (!card || ctx.mobile.matches || ctx.wideUsage.matches) return closeUsage();
    const rect = card.getBoundingClientRect();
    usagePopover.style.left = `${rect.left}px`;
    usagePopover.style.top = `${rect.bottom + ctx.USAGE_POPOVER_GAP_PX}px`;
    usagePopover.style.width = `${rect.width}px`;
  };
  const syncUsageDetails = (container: HTMLElement, agent: AgentState) => {
    if (container.dataset.agent !== agent.id) {
      container.replaceChildren(
        ...detailValues(agent.usage).map(g => gauge(g.label, g.shortLabel, g.labelId, g.value, g.percent, agent.id, g.over, g.tick, g.reset)),
      );
      container.dataset.agent = agent.id;
    }
    detailValues(agent.usage).forEach((g, index) => {
      const node = container.children[index] as HTMLElement;
      const value =
        g.labelId === "ctx" && agent.usage.contextWindow && agent.usage.contextTokens !== undefined ? `${g.value} · ${Math.round(g.percent ?? 0)}%` : g.value;
      syncGauge(node, g.label, g.shortLabel, g.labelId, value, g.percent, g.over, g.tick, g.reset);
      node.querySelector<HTMLElement>(".k")!.textContent = g.shortLabel;
      node.querySelector<HTMLElement>(".track")!.hidden = g.value === "—" || g.labelId === "inputTotal";
      node.querySelector<HTMLElement>(".gauge-reset")!.hidden = g.value === "—";
    });
  };
  const refreshUsageSide = () => {
    const side = ctx.$("#usage-side");
    if (!ctx.wideUsage.matches) return;
    for (const id of ctx.AGENT_IDS) {
      const agent = ctx.store.state?.agents.find(entry => entry.id === id);
      let section = side.querySelector<HTMLElement>(`section[data-agent="${id}"]`);
      if (!agent) {
        section?.remove();
        continue;
      }
      if (!section) {
        section = ctx.el("section");
        section.dataset.agent = id;
        const heading = ctx.el("h2");
        heading.append(ctx.mark(id), ctx.el("span", "", ctx.AGENTS[id].name));
        section.append(heading, ctx.el("div", "usage-details"));
        side.append(section);
      }
      syncUsageDetails(section.querySelector<HTMLElement>(".usage-details")!, agent);
    }
  };
  const refreshUsage = () => {
    refreshUsageSide();
    if (ctx.wideUsage.matches) return closeUsage();
    if (!ctx.store.usageAgent) return;
    const agent = ctx.store.state?.agents.find(entry => entry.id === ctx.store.usageAgent);
    if (!agent || ctx.mobile.matches) return closeUsage();
    syncUsageDetails(usagePopover, agent);
    usagePopover.hidden = false;
    for (const button of document.querySelectorAll("#agents button.usage-trigger"))
      button.setAttribute("aria-expanded", String(button.closest<HTMLElement>(".agent")?.dataset.agent === agent.id));
    positionUsage();
  };
  document.addEventListener("click", event => {
    const target = event.target;
    if (target instanceof Element && !target.closest("#usage-popover, #agents button.usage-trigger")) closeUsage();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeUsage();
  });
  window.addEventListener("resize", positionUsage);
  ctx.mobile.addEventListener("change", positionUsage);

  // project のセレクト: ピン止めを optgroup にまとめ、最後に一覧の編集を置く（DESIGN.md §28 D2a 一覧の整理）

  const EDIT_PROJECTS_VALUE = "clodex:edit-projects";
  return { EDIT_PROJECTS_VALUE, subagentBadge, stateLabel, agentControls, closeUsage, refreshUsage, toggleUsage };
}
