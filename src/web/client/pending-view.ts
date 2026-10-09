import { pendingRows } from "./pending-rows.js";
import type { ClientContext } from "./store.js";

export function createPendingView(ctx: ClientContext) {
  // ---- 送信待ちの入力（取り消し・編集。DESIGN.md §28 v0.3 A） ----
  const renderPending = () => {
    const list = ctx.$("#pending");
    const rows = pendingRows(
      ctx.store.state?.pendingInputs ?? [],
      ctx.store.state?.pendingMessages ?? [],
      ctx.store.state?.agents ?? [],
      ctx.REFERENCES_SEPARATOR,
    );
    list.hidden = !rows.length;
    list.replaceChildren(
      ...rows.map(queued => {
        const row = ctx.el("li");
        const action = (label: string, run: (button: HTMLButtonElement) => void) => {
          const button = ctx.el("button", "", label) as HTMLButtonElement;
          button.type = "button";
          button.addEventListener("click", () => run(button));
          button.dataset.command = `/cancel ${queued.id}`;
          return button;
        };
        row.append(
          ctx.el(
            "span",
            "who",
            queued.kind === "message"
              ? ctx.t("web.pending.route", { from: ctx.AGENTS[queued.from!].name, to: ctx.AGENTS[queued.agent].name })
              : ctx.t("web.pending.to", { agent: ctx.AGENTS[queued.agent].name }),
          ),
        );
        if (queued.type) row.append(ctx.el("span", "pending-type", queued.type));
        row.append(ctx.el("span", "text", queued.text));
        if (queued.holdTime) {
          const hold = ctx.el("span", "pending-hold", queued.holdTime);
          hold.prepend(ctx.icon("pause"));
          hold.title = ctx.t("web.pending.resume", { time: queued.holdTime });
          row.append(hold);
        }
        if (queued.kind === "input")
          row.append(
            action(
              ctx.t("web.pending.edit"),
              button =>
                void ctx.send(`/cancel ${queued.id}`, button).then(sent => {
                  if (!sent) return;
                  ctx.store.target = queued.agent;
                  ctx.input.value = queued.text;
                  ctx.input.focus();
                  ctx.onInputChanged();
                  ctx.renderState();
                }),
            ),
          );
        row.append(action(ctx.t("web.pending.cancel"), button => void ctx.send(`/cancel ${queued.id}`, button)));
        return row;
      }),
    );
  };

  const conversationList = () => {
    if (!ctx.store.state) return [];
    const nodes: HTMLElement[] = ctx.store.state.conversations.map((conversation, index) => {
      const row = ctx.el("div", `conv-row${conversation.current ? " current" : ""}${conversation.activity === "busy" ? " busy" : ""}`);
      if (conversation.current) {
        const active = ctx.store.state!.agents.filter(agent => agent.status === "busy");
        const color = active.length > 1 ? ctx.store.state!.primary : active[0]?.id;
        if (color) row.dataset.agent = color;
      }
      const button = ctx.el("button", `conv${conversation.current ? " current" : ""}`) as HTMLButtonElement;
      button.type = "button";
      const activity = conversation.activity ? `${ctx.t(ctx.STATUS_LABEL[conversation.activity])} · ` : "";
      const branch = conversation.branch ? ` · ⎇ ${conversation.branch}` : "";
      const meta = `${activity}${ctx.shortDate(conversation.updatedAt)} · ${Object.keys(conversation.sessions).join(", ") || "—"}${branch}`;
      const title = ctx.el("span", "t", conversation.title ?? ctx.t("web.conv.untitled"));
      if (conversation.pinned) {
        const pin = ctx.el("span", "conv-pinned");
        pin.append(ctx.icon("pin"));
        pin.setAttribute("aria-label", ctx.t("web.conv.pinnedLabel"));
        pin.title = ctx.t("web.conv.pinnedLabel");
        title.append(pin);
      }
      button.append(title, ctx.el("span", "m", meta));
      button.disabled = conversation.current;
      button.dataset.command = `/resume ${index + 1}`;
      button.addEventListener("click", () => {
        void ctx.send(`/resume ${index + 1}`, button).then(ok => {
          if (ok) ctx.closeSheet();
        });
      });
      const menu = ctx.iconButton("ellipsis", ctx.t("web.conv.menu"), "conv-menu");
      menu.type = "button";
      menu.setAttribute("aria-label", ctx.t("web.conv.menu"));
      menu.addEventListener("click", () => ctx.openConversationMenu(conversation, index + 1));
      row.append(button, menu);
      return row;
    });
    if (!nodes.length) nodes.push(ctx.el("p", "muted small", ctx.t("web.conv.empty")));
    return nodes;
  };
  return { conversationList, renderPending };
}
