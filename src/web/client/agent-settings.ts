import type { AgentId } from "../../agents/agent-adapter.js";
import type { ClientContext } from "./store.js";

export function createAgentSettings(ctx: ClientContext) {
  // Agent の設定: 役割・権限・model・effort と、この Agent だけの session のやり直し
  const openAgentSettings = (id: AgentId) => {
    const incoming = ctx.store.state?.agents.find(a => a.id === id);
    if (!incoming) return;
    const agent = ctx.displayedAgent(incoming);
    ctx.store.sheetAgent = id;
    ctx.store.sheetKind = "agentSettings";
    const roleField = ctx.el("textarea", "role-editor") as HTMLTextAreaElement;
    roleField.value = ctx.store.state?.roles[id] ?? "";
    roleField.setAttribute("aria-label", ctx.t("web.role.title", { agent: ctx.AGENTS[id].name }));
    const saveRole = ctx.sheetButton(ctx.t("web.role.save"), "primary-action", () => {
      const value = roleField.value.replace(/\s+/g, " ").trim();
      if (!value) return;
      void ctx.send(`/role ${id} ${value}`, saveRole).then(ok => {
        if (ok) ctx.closeSheet();
      });
    });
    const permission = choice(
      "permission",
      ctx.t("web.agentSettings.permission"),
      ctx.PERMISSIONS,
      agent.permission,
      v => v,
      v => void ctx.requestSetting(id, "permission", v),
    );
    const model = ctx.el("div", "setting");
    model.append(ctx.el("div", "eyebrow", ctx.t("web.agentSettings.model")));
    const form = ctx.el("form", "model-form") as HTMLFormElement;
    const select = ctx.el("select") as HTMLSelectElement;
    select.name = "model-choice";
    select.setAttribute("aria-label", ctx.t("web.agentSettings.modelLabel", { agent: ctx.AGENTS[id].name }));
    const models = agent.models;
    for (const item of models) {
      const option = ctx.el("option", "", item.label) as HTMLOptionElement;
      option.value = item.value;
      select.append(option);
    }
    const other = ctx.el("option", "", ctx.t("web.model.other")) as HTMLOptionElement;
    other.value = "__other__";
    select.append(other);
    const selectedModel =
      models.find(item => item.value === agent.model) ??
      models.find(item => item.resolved === agent.model && item.value !== "default") ??
      models.find(item => item.resolved === agent.model);
    select.value = selectedModel?.value ?? "__other__";
    const field = ctx.el("input") as HTMLInputElement;
    field.name = "model";
    field.autocomplete = "off";
    field.placeholder = agent.modelLabel ?? ctx.displayDefault(agent.model);
    field.setAttribute("aria-label", ctx.t("web.agentSettings.modelLabel", { agent: ctx.AGENTS[id].name }));
    field.hidden = select.value !== "__other__";
    select.addEventListener("change", () => {
      field.hidden = select.value !== "__other__";
      if (!field.hidden) field.focus();
    });
    const apply = ctx.el("button", "", ctx.t("web.agentSettings.apply")) as HTMLButtonElement;
    apply.type = "submit";
    form.addEventListener("submit", e => {
      e.preventDefault();
      const value = select.value === "__other__" ? field.value.trim() : select.value;
      if (!value) return;
      void ctx.requestSetting(id, "model", value, apply).then(sent => {
        if (sent && field.value.trim() === value) field.value = "";
      });
    });
    form.append(select, field, apply);
    model.append(form);
    const effort = choice(
      "effort",
      ctx.t("web.agentSettings.effort"),
      ctx.EFFORTS[id],
      agent.effort ?? "",
      v => v,
      v => void ctx.requestSetting(id, "effort", v),
    );
    const restart = ctx.sheetButton(ctx.t("web.agentSettings.restart"), "secondary-action", () => {
      void ctx.send(`/new ${id}`, restart).then(ok => {
        if (ok) ctx.closeSheet();
      });
    });
    ctx.openSheet(ctx.t("web.agentSettings.title", { agent: ctx.AGENTS[id].name }), [
      ctx.el("div", "eyebrow", ctx.t("web.role.title", { agent: ctx.AGENTS[id].name })),
      roleField,
      saveRole,
      ctx.el("p", "muted small", ctx.t("web.role.restart", { agent: id })),
      permission,
      model,
      effort,
      ctx.el("div", "setting-pending"),
      restart,
    ]);
    ctx.refreshOpenSheet();
  };

  const choice = <T extends string>(
    key: string,
    label: string,
    options: readonly T[],
    current: T,
    name: (v: T) => string,
    pick: (v: T, button: HTMLButtonElement) => void,
  ) => {
    const wrap = ctx.el("div", "setting");
    wrap.append(ctx.el("div", "eyebrow", label));
    const seg = ctx.el("div", "seg");
    seg.dataset.choice = key;
    for (const option of options) {
      const button = ctx.el("button", "", name(option)) as HTMLButtonElement;
      button.type = "button";
      button.dataset.value = option;
      button.setAttribute("aria-pressed", String(option === current));
      button.addEventListener("click", () => {
        pick(option, button);
        for (const selected of seg.querySelectorAll<HTMLButtonElement>("button")) {
          selected.setAttribute("aria-pressed", String(selected === button));
        }
      });
      seg.append(button);
    }
    wrap.append(seg);
    return wrap;
  };
  return { openAgentSettings, choice };
}
