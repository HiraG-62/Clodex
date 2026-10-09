import type { AgentId } from "../../agents/agent-adapter.js";
import type { ClientContext } from "./store.js";

export function createSheets(ctx: ClientContext) {
  // ---- シート（スマホの操作パネル・会話・設定） ----

  const sheet = ctx.$("#sheet");
  const focusable = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';
  const rememberFocus = () => (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const restoreFocus = (previous: HTMLElement | undefined) => {
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  };
  const trapTab = (event: KeyboardEvent, container: HTMLElement) => {
    if (event.key !== "Tab") return;
    const controls = [...container.querySelectorAll<HTMLElement>(focusable)].filter(node => node.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (!container.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  let sheetReturnFocus: HTMLElement | undefined;
  const openSheet = (title: string, content: HTMLElement[]) => {
    if (sheet.hidden) sheetReturnFocus = rememberFocus();
    sheet.classList.remove("mobile-pop", "add-pop");
    sheet.classList.toggle("settings-sheet", ctx.store.sheetKind === "settings");
    ctx.$("#sheet-title").textContent = title;
    ctx.$("#sheet-body").replaceChildren(...content);
    // ファイルの表示は PC では広く使う
    sheet.querySelector(".sheet-panel")?.classList.toggle("wide", ctx.store.sheetKind === "viewer");
    sheet.classList.toggle("drawer", ctx.store.sheetKind === "conversations" && ctx.mobile.matches);
    sheet.hidden = false;
    ctx.$("#sheet-close").focus({ preventScroll: true });
    for (const pill of document.querySelectorAll(".apill"))
      pill.setAttribute("aria-expanded", String((pill as HTMLElement).dataset.agent === ctx.store.sheetAgent));
  };
  const closeSheet = () => {
    sheet.hidden = true;
    sheet.classList.remove("drawer", "mobile-pop", "add-pop");
    restoreFocus(sheetReturnFocus);
    sheetReturnFocus = undefined;
    for (const pill of document.querySelectorAll(".apill")) pill.setAttribute("aria-expanded", "false");
    ctx.store.sheetAgent = undefined;
    ctx.store.sheetKind = undefined;
  };
  const openAgentSheet = (id: AgentId) => {
    const agent = ctx.store.state?.agents.find(a => a.id === id);
    if (!agent) return;
    ctx.store.sheetAgent = id;
    ctx.store.sheetKind = "agent";
    openSheet(ctx.AGENTS[id].name, [ctx.agentControls(agent)]);
  };
  const openConversations = () => {
    ctx.store.sheetKind = "conversations";
    ctx.store.sheetAgent = undefined;
    const fresh = ctx.el("button", "drawer-new", ctx.t("web.side.newConversation")) as HTMLButtonElement;
    fresh.type = "button";
    fresh.prepend(ctx.icon("square-pen"));
    fresh.addEventListener("click", () => {
      void ctx.send("/new", fresh).then(ok => {
        if (ok) closeSheet();
      });
    });
    const conversations = ctx.el("div", "drawer-conversations");
    conversations.append(...ctx.conversationList());
    const footer = ctx.el("div", "drawer-projects");
    const projects = ctx.el("select") as HTMLSelectElement;
    projects.setAttribute("aria-label", ctx.t("web.top.projects"));
    ctx.fillProjectSelect(projects, ctx.store.state?.projects ?? []);
    projects.addEventListener("change", () => {
      if (projects.value === ctx.EDIT_PROJECTS_VALUE) return ctx.openProjectEditor();
      projects.disabled = true;
      void ctx
        .send(`/project ${projects.value}`)
        .then(ok => {
          if (ok) closeSheet();
        })
        .finally(() => {
          projects.disabled = false;
        });
    });
    const pill = ctx.el("div", "project-pill");
    const selectedName = ctx.el("span", "", ctx.store.state?.project.split(/[\\/]/).filter(Boolean).at(-1) ?? ctx.t("web.top.noProject"));
    pill.append(ctx.icon("folder"), selectedName, ctx.icon("chevron-down"), projects);
    footer.append(pill);
    openSheet(ctx.t("web.conv.title"), [fresh, conversations, footer]);
  };
  const sheetButton = (label: string, cls: string, run: (button: HTMLButtonElement) => void) => {
    const button = ctx.el("button", cls, label) as HTMLButtonElement;
    button.type = "button";
    button.addEventListener("click", () => run(button));
    return button;
  };
  return { sheet, openAgentSheet, closeSheet, openSheet, rememberFocus, restoreFocus, trapTab, sheetButton, openConversations };
}
