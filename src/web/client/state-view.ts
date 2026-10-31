import type { AgentId } from "../../agents/agent-adapter.js";
import type { WebState } from "../web-feed.js";
import { contextParts, isCollapsedAgent, nextExpandedAgent, usageRing, usageRingAlert } from "./agent-strip.js";
import { isShellInput } from "./shell-input.js";
import type { ClientContext } from "./store.js";

export function createStateView(ctx: ClientContext) {
  type ProjectEntry = NonNullable<WebState["projects"]>[number];
  const humanTurn = ctx.el("div", "brainstorm-human");
  humanTurn.hidden = true;
  humanTurn.append(ctx.el("span", "", ctx.t("web.brainstorm.human")));
  for (const [command, label] of [
    ["/pass", "web.brainstorm.pass"],
    ["/conclude", "web.brainstorm.conclude"],
  ] as const) {
    const button = ctx.el("button", "btn", ctx.t(label)) as HTMLButtonElement;
    button.type = "button";
    button.addEventListener("click", () => void ctx.send(command, button));
    humanTurn.append(button);
  }
  ctx.$("#composer").prepend(humanTurn);

  const fillProjectSelect = (select: HTMLSelectElement, projects: readonly ProjectEntry[]) => {
    const key = JSON.stringify(projects.map(({ projectRoot, pinned }) => [projectRoot, pinned]));
    if (select.dataset.paths !== key) {
      const option = (value: string, text: string) => {
        const node = ctx.el("option", "", text) as HTMLOptionElement;
        node.value = value;
        return node;
      };
      const pinned = projects.filter(project => project.pinned);
      const group = ctx.el("optgroup") as HTMLOptGroupElement;
      group.label = ctx.t("web.top.pinnedProjects");
      group.append(...pinned.map(project => option(project.projectRoot, project.projectRoot)));
      select.replaceChildren(
        ...(pinned.length ? [group] : []),
        ...projects.filter(project => !project.pinned).map(project => option(project.projectRoot, project.projectRoot)),
        option(ctx.EDIT_PROJECTS_VALUE, ctx.t("web.top.editProjects")),
      );
      select.dataset.paths = key;
    }
    select.value = projects.find(project => project.current)?.projectRoot ?? "";
  };

  const renderConversationTabs = () => {
    const strip = ctx.$("#conversation-tabs");
    const tabs = ctx.store.state?.tabs ?? [];
    strip.hidden = tabs.length === 0;
    strip.replaceChildren(
      ...tabs.map(tab => {
        const row = ctx.el("div", `conversation-tab${tab.current ? " current" : ""}${tab.activity === "busy" ? " busy" : ""}`);
        const name = tab.projectRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? tab.projectRoot;
        const title = tab.title || ctx.t("web.conv.untitled");
        const main = ctx.el("button", "tab-main") as HTMLButtonElement;
        main.type = "button";
        main.title = `${name} · ${title}`;
        if (tab.parentTitle !== undefined) main.title += ` · ${ctx.t("web.conv.parallelParent", { title: tab.parentTitle })}`;
        main.setAttribute("aria-label", main.title);
        main.append(ctx.el("span", "tab-project", name), ctx.el("span", "tab-title", title));
        if (tab.mode === "brainstorm") main.append(ctx.el("span", "tab-parallel", ctx.t("web.brainstorm")));
        if (tab.parentTitle !== undefined) main.append(ctx.el("span", "tab-parallel", ctx.t("web.conv.parallel")));
        if (tab.activity === "busy") main.append(ctx.el("span", "tab-busy"));
        main.disabled = tab.current;
        const command = `/tab ${tab.conversationId} ${tab.projectRoot}`;
        main.dataset.command = command;
        main.addEventListener("click", () => void ctx.send(command, main));
        row.append(main);
        if (tab.from) {
          const source = ctx.iconButton("lightbulb", ctx.t("web.brainstorm.source"), "tab-action");
          source.type = "button";
          source.addEventListener("click", () => void ctx.send(`/tab ${tab.from!.brainstorm} ${tab.projectRoot}`, source));
          row.append(source);
        }
        const number = ctx.store.state?.conversations.findIndex(conversation => conversation.id === tab.conversationId && !conversation.parent) ?? -1;
        if (tab.tabbed || number >= 0) {
          const action = ctx.iconButton(tab.tabbed ? "x" : "pin", ctx.t(tab.tabbed ? "web.conv.closeTab" : "web.conv.keepTab"), "tab-action");
          action.type = "button";
          action.addEventListener("click", () => void ctx.send(`/tab ${tab.tabbed ? "close" : "keep"} ${tab.conversationId} ${tab.projectRoot}`, action));
          row.append(action);
        }
        return row;
      }),
    );
  };

  const renderState = () => {
    humanTurn.hidden = ctx.store.state?.brainstorm?.phase !== "human";
    ctx.renderQuestionDock();
    if (!ctx.store.state) return;
    const viewKey = `${ctx.store.state.project}\n${ctx.store.state.conversations.find(conversation => conversation.current)?.id ?? ""}`;
    if (ctx.store.stripViewKey !== viewKey) {
      ctx.store.stripViewKey = viewKey;
      ctx.store.expandedStripAgent = undefined;
    }
    ctx.$("#project-name").textContent = ctx.store.state.project.split(/[\\/]/).filter(Boolean).at(-1) || ctx.t("web.top.noProject");
    ctx.$("#project-pill").title = ctx.store.state.project || ctx.t("web.top.noProject");
    // solo で送り先が固定されていればその Agent にする（DESIGN.md §11 Solo）。送り先の色より先に決める
    const solo = ctx.store.state.conversations.find(conversation => conversation.current)?.solo;
    if (solo && solo !== "free") ctx.store.target = solo;
    document.body.dataset.to = ctx.store.target ?? ctx.store.state.primary;
    document.body.style.setProperty("--accent", `var(--${document.body.dataset.to})`);
    const projects = ctx.$("#projects") as HTMLSelectElement;
    const listedProjects = ctx.store.state.projects ?? [];
    fillProjectSelect(projects, listedProjects);
    projects.hidden = listedProjects.length === 0;
    renderConversationTabs();
    // スマホ: 状態の行
    ctx.$("#mobile-title").textContent = ctx.store.state.conversations.find(conversation => conversation.current)?.title ?? ctx.t("web.conv.untitled");
    ctx.$("#mobile-project").replaceChildren(ctx.icon("folder"), ctx.el("span", "", ctx.$("#project-name").textContent ?? ""));
    ctx.$("#mobile-agents").replaceChildren(
      ...ctx.store.state.agents.map(agent => {
        const button = ctx.el("button", "apill") as HTMLButtonElement;
        button.type = "button";
        button.dataset.agent = agent.id;
        button.dataset.state = agent.status;
        button.setAttribute("aria-expanded", String(!ctx.sheet.hidden && ctx.store.sheetAgent === agent.id));
        const badge = ctx.subagentBadge(agent);
        button.setAttribute("aria-label", `${ctx.AGENTS[agent.id].name} · ${ctx.t(ctx.STATUS_LABEL[agent.status])}${badge ? `\n${badge.title}` : ""}`);
        button.title = button.getAttribute("aria-label")!;
        const inside = ctx.el("span", "in");
        inside.append(...contextParts(ctx, agent));
        if (badge) inside.append(badge);
        button.append(inside);
        button.addEventListener("click", () => ctx.openAgentSheet(agent.id));
        return button;
      }),
    );
    const selected = ctx.store.target ?? ctx.store.state.primary;
    ctx.$("#target-toggle").replaceChildren(isShellInput(ctx.input.value) ? ctx.icon("terminal") : ctx.mark(selected));
    ctx
      .$("#target-toggle")
      .setAttribute("aria-label", isShellInput(ctx.input.value) ? ctx.t("web.shellInput") : `${ctx.t("web.to.label")}: ${ctx.AGENTS[selected].name}`);
    ctx.$("#target-toggle").title = ctx.$("#target-toggle").getAttribute("aria-label")!;
    // PC: Agent パネル
    const well = ctx.el("div", "strip-well");
    well.setAttribute(
      "style",
      `grid-template-columns: ${ctx.store.state.agents
        .map(agent => (isCollapsedAgent(agent.status, agent.id === selected, ctx.store.expandedStripAgent === agent.id) ? "44px" : "minmax(0, 1fr)"))
        .join(" ")}`,
    );
    well.append(
      ...ctx.store.state.agents.map(agent => {
        const collapsed = isCollapsedAgent(agent.status, agent.id === selected, ctx.store.expandedStripAgent === agent.id);
        const section = ctx.el("section", `agent ${agent.status}${collapsed ? " collapsed" : ""}`);
        section.dataset.agent = agent.id;
        section.dataset.state = agent.status;
        const markButton = ctx.el("button", "context-button usage-trigger") as HTMLButtonElement;
        markButton.type = "button";
        markButton.setAttribute("aria-label", `${ctx.AGENTS[agent.id].name} · ${ctx.t(ctx.STATUS_LABEL[agent.status])}`);
        markButton.title = markButton.getAttribute("aria-label")!;
        markButton.append(ctx.mark(agent.id), ...contextParts(ctx, agent));
        if (collapsed) {
          markButton.classList.remove("usage-trigger");
          markButton.setAttribute("aria-expanded", "false");
          const badge = ctx.subagentBadge(agent);
          if (badge) {
            markButton.append(badge);
            markButton.title += `\n${badge.title}`;
          }
          if (Object.keys(ctx.store.pendingSettings[agent.id] ?? {}).length) {
            markButton.classList.add("pending");
            markButton.title += ` · ${ctx.t("web.setting.pending")}`;
          }
          markButton.setAttribute("aria-label", markButton.title);
          markButton.addEventListener("click", () => {
            ctx.store.expandedStripAgent = nextExpandedAgent(ctx.store.expandedStripAgent, agent.id);
            ctx.renderState();
          });
          section.append(markButton);
          return section;
        }
        markButton.setAttribute("aria-expanded", String(ctx.store.usageAgent === agent.id));
        markButton.setAttribute("aria-controls", "usage-popover");
        markButton.addEventListener("click", () => ctx.toggleUsage(agent.id));
        const who = ctx.el("div", "strip-who");
        const h2 = ctx.el("h2");
        const status = ctx.stateLabel(agent);
        const turn = ctx.store.items.findLast(item => item.kind === "turn" && item.agent === agent.id && item.status === "working");
        if (agent.status === "busy" && turn && "at" in turn) {
          const elapsed = ctx.el("span", "elapsed", ctx.elapsedText(turn.at));
          elapsed.dataset.start = turn.at;
          status.append(elapsed);
        }
        if (agent.status === "stopped" && ctx.store.expandedStripAgent === agent.id && agent.id !== selected) {
          const collapse = ctx.el("button", "strip-collapse", ctx.AGENTS[agent.id].name) as HTMLButtonElement;
          collapse.type = "button";
          collapse.setAttribute("aria-label", `${ctx.AGENTS[agent.id].name} · ${ctx.t(ctx.STATUS_LABEL[agent.status])}`);
          collapse.title = collapse.getAttribute("aria-label")!;
          collapse.addEventListener("click", () => {
            ctx.store.expandedStripAgent = nextExpandedAgent(ctx.store.expandedStripAgent, agent.id);
            ctx.closeUsage();
            ctx.renderState();
          });
          h2.append(collapse);
        } else h2.append(ctx.el("span", "", ctx.AGENTS[agent.id].name));
        h2.append(status);
        const badge = ctx.subagentBadge(agent);
        if (badge) h2.append(badge);
        const current = ctx.displayedAgent(agent);
        const summary = ctx.el("div", "strip-summary");
        summary.title = ctx.t(ctx.EFFORTS[agent.id].length ? "web.agent.summary" : "web.agent.summaryNoEffort", {
          model: current.modelLabel ?? ctx.displayDefault(current.model),
          effort: ctx.displayDefault(current.effort),
          permission: current.permission,
        });
        summary.setAttribute("aria-label", summary.title);
        summary.append(
          ctx.el("span", "model", current.modelLabel ?? ctx.displayDefault(current.model)),
          ...(ctx.EFFORTS[agent.id].length ? [ctx.el("span", "", `· ${ctx.displayDefault(current.effort)} ·`)] : [ctx.el("span", "", " · ")]),
          ctx.el("span", current.permission === "full" ? "permission-full" : "", current.permission),
        );
        if (Object.keys(ctx.store.pendingSettings[agent.id] ?? {}).length) {
          summary.classList.add("pending");
          summary.title += ` · ${ctx.t("web.setting.pending")}`;
        }
        who.append(h2, summary);
        const controls = ctx.agentControls(agent);
        const limits = ctx.el("div", "usage-rings");
        for (const [label, percent, reset, icon, over] of [
          [
            ctx.t("web.gauge.fiveHour"),
            agent.usage.fiveHourPercent,
            agent.usage.fiveHourResetsAt,
            "clock",
            usageRingAlert("fiveHour", agent.usage.fiveHourPercent),
          ],
          [ctx.t("web.gauge.weekly"), agent.usage.weeklyPercent, agent.usage.weeklyResetsAt, "calendar", usageRingAlert("weekly", agent.usage.weeklyPace)],
        ] as const) {
          const time =
            reset === undefined
              ? ""
              : icon === "clock"
                ? ctx.clock(new Date(reset * ctx.MS_PER_SECOND).toISOString())
                : ctx.shortDate(new Date(reset * ctx.MS_PER_SECOND).toISOString());
          const button = ctx.el("button", "usage-trigger limit-trigger") as HTMLButtonElement;
          button.type = "button";
          const circle = usageRing(ctx, label, percent, time, icon, over);
          button.title = circle.title;
          button.setAttribute("aria-label", circle.title);
          button.setAttribute("aria-expanded", String(ctx.store.usageAgent === agent.id));
          button.setAttribute("aria-controls", "usage-popover");
          button.append(circle);
          button.addEventListener("click", () => ctx.toggleUsage(agent.id));
          limits.append(button);
        }
        section.append(markButton, who, limits, controls.querySelector(".links")!);
        return section;
      }),
    );
    ctx.$("#agents").replaceChildren(well);
    ctx.refreshUsage();
    ctx.$("#conversations").replaceChildren(...ctx.conversationList());
    // 送り先: 人が選んでいなければ primary に合わせる
    for (const button of document.querySelectorAll<HTMLButtonElement>(".to button")) {
      const id = button.dataset.agent as AgentId;
      button.setAttribute("aria-pressed", String((ctx.store.target ?? ctx.store.state.primary) === id));
    }
    const soloBadge = ctx.$("#solo-badge");
    soloBadge.hidden = !solo;
    soloBadge.textContent = !solo || solo === "free" ? ctx.t("shell.solo") : ctx.t("shell.soloAgent", { agent: ctx.AGENTS[solo].name });
    ctx.syncTargetButtons();
    ctx.renderPending();
    ctx.refreshOpenSheet();
    ctx.syncPendingButtons();
  };

  ctx.wideUsage.addEventListener("change", () => {
    ctx.closeUsage();
    renderState();
  });
  return { renderState, fillProjectSelect };
}
