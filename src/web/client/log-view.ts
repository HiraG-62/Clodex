import { discardMissingOpened, sameWorkingEntry } from "./log-diff.js";
import { renderMarkdown } from "./markdown.js";
import type { ClientContext } from "./store.js";
import type { DisplayTimelineItem, TimelineItem } from "./timeline.js";
import { type WorkingEntry, withStartingTurns, withSubagentRows, withWorkingTurnsLast, workingFeed } from "./timeline.js";

export function createLogView(ctx: ClientContext) {
  const renderItem = (item: DisplayTimelineItem): HTMLElement => {
    switch (item.kind) {
      case "starting": {
        const node = ctx.el("article", "entry starting-turn");
        node.append(ctx.mark(item.agent));
        const head = ctx.el("div", "head");
        const elapsed = ctx.el("span", "elapsed mono", ctx.elapsedText(item.at));
        elapsed.dataset.start = item.at;
        head.append(ctx.el("b", `c-${item.agent}`, ctx.AGENTS[item.agent].name), ctx.el("span", "state starting", ctx.t("web.turn.starting")), elapsed);
        const body = ctx.el("div", "body");
        body.setAttribute("aria-hidden", "true");
        body.append(ctx.el("span", "sk"), ctx.el("span", "sk"));
        node.append(head, body);
        return node;
      }
      case "subagents": {
        const node = ctx.el("article", "entry subagent-turn");
        node.dataset.agent = item.agent;
        const head = ctx.el("div", "head");
        head.append(
          ctx.el("b", `c-${item.agent}`, ctx.AGENTS[item.agent].name),
          ctx.el("span", "state", `${ctx.t("web.agent.subagents")} ${item.running.length}`),
        );
        const body = ctx.el("div", "body");
        for (const subagent of item.running) {
          const description = subagent.description || subagent.id;
          const row = ctx.el("div", "subagent-description", description);
          row.title = description;
          body.append(row);
        }
        node.append(ctx.mark(item.agent), head, body);
        return node;
      }
      case "human": {
        const node = ctx.el("article", "entry you");
        const head = ctx.el("div", "head");
        head.append(
          ctx.el("b", "", ctx.t("web.you")),
          ctx.el("span", `c-${item.agent}`, `→ ${ctx.AGENTS[item.agent].name}`),
          ctx.el("time", "mono", ctx.clock(item.at)),
        );
        if (item.steer) {
          head.append(ctx.el("span", "kind steer", ctx.t("web.steer")));
          if (item.delivered) {
            const delivered = ctx.el("span", "steer-delivered");
            delivered.title = ctx.t("web.steer.delivered");
            delivered.setAttribute("aria-label", delivered.title);
            delivered.append(ctx.icon("check"));
            head.append(delivered);
          }
        }
        const body = ctx.el("div", "body md");
        body.innerHTML = renderMarkdown(item.text);
        node.append(ctx.mark("you"), head, body);
        ctx.appendImagePreviews(node, item.text, item.at);
        return node;
      }
      case "question":
        return ctx.renderQuestion(item);
      case "turn":
        return ctx.renderTurn(item);
      case "message":
        return ctx.renderMessage(item);
      case "notice":
        return ctx.el("div", "notice", item.compactAgent ? ctx.t("web.notice.compacted", { agent: ctx.AGENTS[item.compactAgent].name }) : item.text);
      case "error":
        return ctx.el("div", "error-row", `${ctx.AGENTS[item.agent].name}: ${item.text}`);
      case "output":
        return ctx.el("pre", "output", item.text);
    }
  };

  const nearBottom = () => ctx.log.scrollHeight - ctx.log.scrollTop - ctx.log.clientHeight < ctx.NEAR_BOTTOM_PX;
  const syncNewer = () => {
    const reading = !nearBottom();
    if (!reading) ctx.store.unreadWhileReading = false;
    ctx.newer.hidden = !reading;
    ctx.newer.classList.toggle("unread", reading && ctx.store.unreadWhileReading);
  };
  const scrollToBottom = () => {
    ctx.log.scrollTop = ctx.log.scrollHeight;
    syncNewer();
  };

  const workingPanel = ctx.$("#working-panel");
  const workingToggle = ctx.$("#working-toggle");
  let previousFeed: WorkingEntry[] = [];
  const renderWorking = () => {
    const active = ctx.store.items.filter((item): item is Extract<TimelineItem, { kind: "turn" }> => item.kind === "turn" && item.status === "working");
    const feed = workingFeed(ctx.store.items);
    const count = active.length ? String(active.length) : "";
    if (ctx.$("#working-count").textContent !== count) ctx.$("#working-count").textContent = count;
    const agent = active.length > 1 ? (ctx.store.state?.primary ?? "claude") : (active[0]?.agent ?? "claude");
    if (workingToggle.dataset.agent !== agent) workingToggle.dataset.agent = agent;
    if (workingToggle.hidden !== (feed.length === 0)) workingToggle.hidden = feed.length === 0;
    if (!feed.length && !workingPanel.hidden) {
      workingPanel.hidden = true;
      workingToggle.setAttribute("aria-expanded", "false");
    }
    const list = ctx.$("#working-list");
    const feedChanged =
      feed.length !== previousFeed.length || feed.some((entry, index) => !previousFeed[index] || !sameWorkingEntry(previousFeed[index], entry));
    if (!feedChanged) return;
    const following = workingPanel.scrollHeight - workingPanel.scrollTop - workingPanel.clientHeight < ctx.NEAR_BOTTOM_PX;
    feed.forEach((entry, index) => {
      if (previousFeed[index] && sameWorkingEntry(previousFeed[index], entry)) return;
      let node: HTMLElement;
      if (entry.kind === "say") {
        const say = ctx.el("div", "working-say md");
        say.innerHTML = renderMarkdown(entry.text);
        enhanceMarkdown(say);
        node = say;
      } else {
        const button = ctx.el("button", "working-head") as HTMLButtonElement;
        button.type = "button";
        button.append(ctx.el("span", `name c-${entry.agent}`, ctx.AGENTS[entry.agent].name));
        if (entry.plan) button.append(ctx.el("span", "plan", (entry.plan.split("\n", 1)[0] ?? "").replace(/`/g, "")));
        if (!entry.done) {
          const elapsed = ctx.el("span", "elapsed", ctx.elapsedText(entry.at));
          elapsed.dataset.start = entry.at;
          button.append(elapsed);
        }
        button.addEventListener("click", () => {
          workingPanel.hidden = true;
          workingToggle.setAttribute("aria-expanded", "false");
          ctx.store.rendered.get(entry.turnId)?.node.scrollIntoView({ behavior: "smooth", block: "center" });
        });
        node = button;
      }
      const old = list.children[index];
      if (old) old.replaceWith(node);
      else list.append(node);
    });
    while (list.children.length > feed.length) list.lastElementChild?.remove();
    previousFeed = feed;
    if (following) workingPanel.scrollTop = workingPanel.scrollHeight;
  };
  workingToggle.addEventListener("click", () => {
    workingPanel.hidden = !workingPanel.hidden;
    workingToggle.setAttribute("aria-expanded", String(!workingPanel.hidden));
  });
  ctx.$("#working-close").addEventListener("click", () => {
    workingPanel.hidden = true;
    workingToggle.setAttribute("aria-expanded", "false");
  });

  const enhanceMarkdown = (root: HTMLElement) => {
    for (const pre of root.querySelectorAll("pre")) {
      if (pre.parentElement?.classList.contains("code-block")) continue;
      const code = pre.querySelector("code");
      if (!code) continue;
      const text = code.textContent ?? "";
      const block = ctx.el("div", `code-block${text.trimEnd().split("\n").length > ctx.CODE_FOLD_LINES ? " long" : ""}`);
      const head = ctx.el("div", "code-head");
      const copy = ctx.iconButton("copy", ctx.t("web.code.copy"));
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(text);
          ctx.showToast(ctx.t("web.code.copied"));
        } catch {
          ctx.showToast(ctx.t("web.code.copyFailed"));
        }
      });
      head.append(copy);
      pre.before(block);
      block.append(head, pre);
      if (block.classList.contains("long")) {
        const more = ctx.iconButton("chevron-down", ctx.t("web.code.full"), "code-more");
        more.append(ctx.el("span", "", ctx.t("web.code.full")));
        more.setAttribute("aria-expanded", "false");
        more.addEventListener("click", () => {
          const expanded = block.classList.toggle("expanded");
          more.setAttribute("aria-expanded", String(expanded));
          const label = ctx.t(expanded ? "web.code.collapse" : "web.code.full");
          more.setAttribute("aria-label", label);
          more.title = label;
          more.querySelector("span")!.textContent = label;
        });
        block.append(more);
      }
    }
    for (const table of root.querySelectorAll("table")) {
      if (table.parentElement?.classList.contains("table-scroll")) continue;
      const scroll = ctx.el("div", "table-scroll");
      scroll.tabIndex = 0;
      table.before(scroll);
      scroll.append(table);
    }
  };

  // 変わった項目だけ描き直す（開閉やスクロール位置を保つ）
  const renderLog = (force = false) => {
    const stick = nearBottom();
    const visibleItems = withSubagentRows(
      withStartingTurns(withWorkingTurnsLast(ctx.store.items), ctx.store.state?.agents ?? [], new Date().toISOString(), ctx.store.state?.pendingInputs ?? []),
      ctx.store.state?.agents ?? [],
    );
    ctx.store.items = visibleItems.filter((item): item is TimelineItem => item.kind !== "starting" && item.kind !== "subagents");
    for (const item of visibleItems) {
      if (item.kind !== "starting") continue;
      if (!ctx.store.startingAt.has(item.agent)) ctx.store.startingAt.set(item.agent, item.at);
      item.at = ctx.store.startingAt.get(item.agent)!;
    }
    for (const id of ctx.AGENT_IDS) if (!visibleItems.some(item => item.kind === "starting" && item.agent === id)) ctx.store.startingAt.delete(id);
    const keep = new Set(visibleItems.map(i => i.id));
    for (const [id, entry] of ctx.store.rendered) {
      if (!keep.has(id)) {
        entry.node.remove();
        ctx.store.rendered.delete(id);
      }
    }
    discardMissingOpened(ctx.store.opened, keep);
    let previous: HTMLElement | undefined;
    const updatedMarkdown: HTMLElement[] = [];
    for (const item of visibleItems) {
      const current = ctx.store.rendered.get(item.id);
      let node = current?.node;
      const sameStarting = current?.item.kind === "starting" && item.kind === "starting" && current.item.at === item.at;
      if (!current || (current.item !== item && !sameStarting) || force) {
        const update =
          !force && current?.item.kind === "turn" && item.kind === "turn"
            ? (
                ctx as ClientContext & {
                  updateTurn: (
                    node: HTMLElement,
                    previous: Extract<TimelineItem, { kind: "turn" }>,
                    next: Extract<TimelineItem, { kind: "turn" }>,
                  ) => HTMLElement[] | undefined;
                }
              ).updateTurn(current.node, current.item, item)
            : undefined;
        if (update) {
          updatedMarkdown.push(...update);
          ctx.store.rendered.set(item.id, { item, node: current!.node });
        } else {
          node = renderItem(item);
          if (current) current.node.replaceWith(node);
          ctx.store.rendered.set(item.id, { item, node });
          updatedMarkdown.push(node);
        }
      }
      // まだ DOM に無い要素、または位置がずれた要素を、直前の要素の後ろへ置く
      if (node && (node.parentNode !== ctx.log || node.previousElementSibling !== (previous ?? null))) {
        if (previous) previous.after(node);
        else ctx.log.prepend(node);
      }
      previous = node;
    }
    ctx.$("#empty").hidden = !ctx.store.state || visibleItems.length > 0;
    ctx.$("#log-skeleton").hidden = Boolean(ctx.store.state);
    const older = ctx.$("#history-loading");
    older.hidden = !ctx.store.historyLoading;
    ctx.log.prepend(older);
    for (const clock of ctx.log.querySelectorAll(".output-clock")) clock.remove();
    for (const [id, commandStart] of Object.entries(ctx.store.commandStarts)) {
      const clockRow = ctx.el("div", "output-clock");
      const elapsed = ctx.el("span", "elapsed", ctx.elapsedText(commandStart.at));
      elapsed.dataset.start = commandStart.at;
      clockRow.dataset.commandId = id;
      clockRow.append(ctx.el("span", "spin"), ctx.el("span", "", `#${id} · ${ctx.t("web.command.running")}`), elapsed);
      ctx.store.rendered.get(commandStart.outputId)?.node.before(clockRow);
    }
    for (const node of updatedMarkdown) enhanceMarkdown(node);
    if (stick) scrollToBottom();
    else syncNewer();
    renderWorking();
  };
  return { renderLog, renderItem, nearBottom, scrollToBottom, syncNewer };
}
