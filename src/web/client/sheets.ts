import type { AgentId } from "../../agents/agent-adapter.js";
import { DEFAULT_BRAINSTORM_ROUNDS } from "../../coordinator/brainstorm.js";
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
    const brainstorm = ctx.el("button", "drawer-new", ctx.t("web.brainstorm")) as HTMLButtonElement;
    brainstorm.type = "button";
    brainstorm.prepend(ctx.icon("lightbulb"));
    brainstorm.addEventListener("click", openBrainstorm);
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
    openSheet(ctx.t("web.conv.title"), [fresh, brainstorm, conversations, footer]);
  };
  const openBrainstorm = () => {
    ctx.store.sheetKind = "brainstorm";
    const form = ctx.el("form", "brainstorm-form") as HTMLFormElement;
    const topic = ctx.el("textarea") as HTMLTextAreaElement;
    topic.required = true;
    topic.rows = 5;
    topic.placeholder = ctx.t("web.brainstorm.topic");
    const topicLabel = ctx.el("label", "", ctx.t("web.brainstorm.topic"));
    topicLabel.append(topic);
    const rounds = ctx.el("input") as HTMLInputElement;
    rounds.type = "number";
    rounds.min = "1";
    rounds.step = "1";
    rounds.required = true;
    rounds.setAttribute("aria-label", ctx.t("web.brainstorm.rounds"));
    const roundsLabel = ctx.el("label", "", ctx.t("web.brainstorm.rounds"));
    roundsLabel.append(rounds);
    rounds.value = String(DEFAULT_BRAINSTORM_ROUNDS);
    let join = false;
    const participation = ctx.settingsSwitch("brainstorm-join", ctx.t("web.brainstorm.join"), join, (checked, button) => {
      join = checked;
      button.setAttribute("aria-checked", String(join));
    });
    const submit = ctx.el("button", "btn", ctx.t("web.brainstorm")) as HTMLButtonElement;
    submit.type = "submit";
    form.append(topicLabel, roundsLabel, participation, submit);
    form.addEventListener("submit", event => {
      event.preventDefault();
      const value = topic.value.trim();
      if (!value) return;
      if (!Number.isInteger(Number(rounds.value)) || Number(rounds.value) < 1) return;
      void ctx.send(`/brainstorm ${rounds.value} ${join ? "--join " : ""}${value.replace(/\r?\n/g, " ")}`, submit).then(ok => {
        if (ok) closeSheet();
      });
    });
    openSheet(ctx.t("web.brainstorm"), [form]);
    topic.focus();
  };
  const openDevelop = () => {
    ctx.store.sheetKind = "develop";
    const form = ctx.el("form", "brainstorm-form") as HTMLFormElement;
    const instruction = ctx.el("textarea") as HTMLTextAreaElement;
    instruction.placeholder = ctx.t("web.brainstorm.instruction");
    instruction.setAttribute("aria-label", instruction.placeholder);
    const submit = ctx.el("button", "btn", ctx.t("web.brainstorm.develop")) as HTMLButtonElement;
    submit.type = "submit";
    form.append(instruction, submit);
    form.addEventListener("submit", event => {
      event.preventDefault();
      const text = instruction.value.trim().replace(/\r?\n/g, " ");
      void ctx.send(`/develop${text ? ` ${text}` : ""}`, submit).then(ok => {
        if (ok) closeSheet();
      });
    });
    openSheet(ctx.t("web.brainstorm.develop"), [form]);
    instruction.focus();
  };
  const sheetButton = (label: string, cls: string, run: (button: HTMLButtonElement) => void) => {
    const button = ctx.el("button", cls, label) as HTMLButtonElement;
    button.type = "button";
    button.addEventListener("click", () => run(button));
    return button;
  };
  return { sheet, openAgentSheet, closeSheet, openSheet, rememberFocus, restoreFocus, trapTab, sheetButton, openConversations, openBrainstorm, openDevelop };
}
