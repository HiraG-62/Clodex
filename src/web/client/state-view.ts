import type { AgentId } from "../../agents/agent-adapter.js";
import type { WebState } from "../web-feed.js";
import { isShellInput } from "./shell-input.js";
import type { ClientContext } from "./store.js";

export function createStateView(ctx: ClientContext) {
  type ProjectEntry = NonNullable<WebState["projects"]>[number];

  const fillProjectSelect = (select: HTMLSelectElement, projects: readonly ProjectEntry[]) => {
    const key = JSON.stringify(projects.map(({ projectRoot, pinned }) => [projectRoot, pinned]));
    if (select.dataset.paths !== key) {
      const option = (value: string, text: string) => {
        const node = ctx.el("option", "", text) as HTMLOptionElement;
        node.value = value;
        return node;
      };
      const pinned = projects.filter((project) => project.pinned);
      const group = ctx.el("optgroup") as HTMLOptGroupElement;
      group.label = ctx.t("web.top.pinnedProjects");
      group.append(...pinned.map((project) => option(project.projectRoot, project.projectRoot)));
      select.replaceChildren(
        ...(pinned.length ? [group] : []),
        ...projects.filter((project) => !project.pinned).map((project) => option(project.projectRoot, project.projectRoot)),
        option(ctx.EDIT_PROJECTS_VALUE, ctx.t("web.top.editProjects")),
      );
      select.dataset.paths = key;
    }
    select.value = projects.find((project) => project.current)?.projectRoot ?? "";
  };

  const renderConversationTabs = () => {
    const strip = ctx.$("#conversation-tabs");
    const tabs = ctx.store.state?.tabs ?? [];
    strip.hidden = tabs.length === 0;
    strip.replaceChildren(...tabs.map((tab) => {
      const row = ctx.el("div", `conversation-tab${tab.current ? " current" : ""}${tab.activity === "busy" ? " busy" : ""}`);
      const name = tab.projectRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? tab.projectRoot;
      const title = tab.title || ctx.t("web.conv.untitled");
      const main = ctx.el("button", "tab-main") as HTMLButtonElement;
      main.type = "button";
      main.title = `${name} · ${title}`;
      main.setAttribute("aria-label", main.title);
      main.append(ctx.el("span", "tab-project", name), ctx.el("span", "tab-title", title));
      if (tab.activity === "busy") main.append(ctx.el("span", "tab-busy"));
      main.disabled = tab.current;
      const command = `/tab ${tab.conversationId} ${tab.projectRoot}`;
      main.dataset.command = command;
      main.addEventListener("click", () => void ctx.send(command, main));
      row.append(main);
      const number = ctx.store.state?.conversations.findIndex((conversation) => conversation.id === tab.conversationId) ?? -1;
      if (tab.pinned || number >= 0) {
        const action = ctx.iconButton(tab.pinned ? "x" : "pin", ctx.t(tab.pinned ? "web.conv.unpin" : "web.conv.pin"), "tab-action");
        action.type = "button";
        action.addEventListener("click", () => void ctx.send(tab.pinned
          ? `/tab unpin ${tab.conversationId} ${tab.projectRoot}` : `/pin ${number + 1}`, action));
        row.append(action);
      }
      return row;
    }));
  };

  const renderState = () => {
    ctx.renderQuestionDock();
    if (!ctx.store.state) return;
    ctx.$("#project-name").textContent = ctx.store.state.project.split(/[\\/]/).filter(Boolean).at(-1) || ctx.t("web.top.noProject");
    ctx.$("#project-pill").title = ctx.store.state.project || ctx.t("web.top.noProject");
    // solo で送り先が固定されていればその Agent にする（DESIGN.md §11 Solo）。送り先の色より先に決める
    const solo = ctx.store.state.conversations.find((conversation) => conversation.current)?.solo;
    if (solo && solo !== "free") ctx.store.target = solo;
    document.body.dataset.to = ctx.store.target ?? ctx.store.state.primary;
    const projects = ctx.$("#projects") as HTMLSelectElement;
    const listedProjects = ctx.store.state.projects ?? [];
    fillProjectSelect(projects, listedProjects);
    projects.hidden = listedProjects.length === 0;
    renderConversationTabs();
    // スマホ: 状態の行
    ctx.$("#mobile-title").textContent = ctx.store.state.conversations.find((conversation) => conversation.current)?.title ?? ctx.t("web.conv.untitled");
    ctx.$("#mobile-project").replaceChildren(ctx.icon("folder"), ctx.el("span", "", ctx.$("#project-name").textContent ?? ""));
    ctx.$("#mobile-agents").replaceChildren(...ctx.store.state.agents.map((agent) => {
      const button = ctx.el("button", "apill") as HTMLButtonElement;
      button.type = "button";
      button.dataset.agent = agent.id;
      button.dataset.state = agent.status;
      button.setAttribute("aria-expanded", String(!ctx.sheet.hidden && ctx.store.sheetAgent === agent.id));
      const badge = ctx.subagentBadge(agent);
      button.setAttribute("aria-label", `${ctx.AGENTS[agent.id].name} · ${ctx.t(ctx.STATUS_LABEL[agent.status])}${badge ? `\n${badge.title}` : ""}`);
      button.title = button.getAttribute("aria-label")!;
      const inside = ctx.el("span", "in");
      inside.append(ctx.el("span", "dot"));
      if (agent.permission === "full") { const shield = ctx.icon("shield-alert"); shield.classList.add("shield"); inside.append(shield); }
      const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      ring.setAttribute("viewBox", "0 0 24 24");
      ring.setAttribute("class", "ring");
      ring.setAttribute("aria-hidden", "true");
      const percent = agent.usage.contextWindow ? Math.min(ctx.PERCENT, Math.max(0, (agent.usage.contextTokens ?? 0) / agent.usage.contextWindow * ctx.PERCENT)) : 0;
      for (const cls of ["bg", "fg"]) {
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        for (const [key, value] of Object.entries({ cx: "12", cy: "12", r: "9", class: cls, pathLength: "100" })) circle.setAttribute(key, value);
        if (cls === "fg") circle.setAttribute("stroke-dasharray", `${percent} 100`);
        ring.append(circle);
      }
      inside.append(ring);
      if (badge) inside.append(badge);
      button.append(inside);
      button.addEventListener("click", () => ctx.openAgentSheet(agent.id));
      return button;
    }));
    const selected = ctx.store.target ?? ctx.store.state.primary;
    ctx.$("#target-toggle").replaceChildren(isShellInput(ctx.input.value) ? ctx.icon("terminal") : ctx.mark(selected));
    ctx.$("#target-toggle").setAttribute("aria-label", isShellInput(ctx.input.value) ? ctx.t("web.shellInput") : `${ctx.t("web.to.label")}: ${ctx.AGENTS[selected].name}`);
    ctx.$("#target-toggle").title = ctx.$("#target-toggle").getAttribute("aria-label")!;
    // PC: Agent パネル
    const well = ctx.el("div", "strip-well");
    well.append(...ctx.store.state.agents.map((agent) => {
      const section = ctx.el("section", `agent ${agent.status}`);
      section.dataset.agent = agent.id;
      const who = ctx.el("div", "strip-who");
      const h2 = ctx.el("h2");
      const status = ctx.stateLabel(agent);
      const turn = ctx.store.items.findLast((item) => item.kind === "turn" && item.agent === agent.id && item.status === "working");
      if (agent.status === "busy" && turn && "at" in turn) {
        const elapsed = ctx.el("span", "elapsed", ctx.elapsedText(turn.at));
        elapsed.dataset.start = turn.at;
        status.append(elapsed);
      }
      h2.append(ctx.el("span", "", ctx.AGENTS[agent.id].name), status);
      const badge = ctx.subagentBadge(agent);
      if (badge) h2.append(badge);
      const current = ctx.displayedAgent(agent);
      const summary = ctx.el("div", "strip-summary");
      summary.title = ctx.t("web.agent.summary", { model: current.modelLabel ?? ctx.displayDefault(current.model), effort: ctx.displayDefault(current.effort), permission: current.permission });
      summary.setAttribute("aria-label", summary.title);
      summary.append(ctx.el("span", "model", current.modelLabel ?? ctx.displayDefault(current.model)),
        ctx.el("span", "", `· ${ctx.displayDefault(current.effort)} ·`), ctx.el("span", current.permission === "full" ? "permission-full" : "", current.permission));
      if (Object.keys(ctx.store.pendingSettings[agent.id] ?? {}).length) {
        summary.classList.add("pending");
        summary.title += ` · ${ctx.t("web.setting.pending")}`;
      }
      who.append(h2, summary);
      const controls = ctx.agentControls(agent);
      const miniButton = ctx.el(ctx.wideUsage.matches ? "div" : "button", "mini-gauges");
      if (miniButton instanceof HTMLButtonElement) {
        miniButton.type = "button";
        miniButton.title = ctx.t("web.usage.title");
        miniButton.setAttribute("aria-label", ctx.t("web.usage.title"));
        miniButton.setAttribute("aria-expanded", String(ctx.store.usageAgent === agent.id));
        miniButton.setAttribute("aria-controls", "usage-popover");
        miniButton.addEventListener("click", () => {
          if (ctx.wideUsage.matches) return;
          if (ctx.store.usageAgent === agent.id) ctx.closeUsage();
          else { ctx.store.usageAgent = agent.id; ctx.refreshUsage(); }
        });
      }
      miniButton.append(...controls.querySelector(".mini-gauges")!.childNodes);
      section.append(ctx.mark(agent.id), who, miniButton, controls.querySelector(".links")!);
      return section;
    }));
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

  ctx.wideUsage.addEventListener("change", () => { ctx.closeUsage(); renderState(); });
  return { renderState, fillProjectSelect };
}
