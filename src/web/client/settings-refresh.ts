import type { WebState } from "../web-feed.js";
import type { ClientContext } from "./store.js";

export function createSettingsRefresh(ctx: ClientContext) {


  const refreshOpenSheet = () => {
    if (ctx.sheet.hidden) return;
    if (ctx.store.sheetKind === "projects") {
      const list = ctx.$("#sheet-body").querySelector<HTMLElement>(".project-list");
      if (list && list.dataset.key !== JSON.stringify(ctx.store.state?.projects ?? [])) list.replaceWith(ctx.projectEditorList());
    }
    if (ctx.store.sheetKind === "agent" && ctx.store.sheetAgent) {
      const agent = ctx.store.state?.agents.find((candidate) => candidate.id === ctx.store.sheetAgent);
      const controls = ctx.$("#sheet-body").querySelector<HTMLElement>(".controls");
      if (agent && controls) ctx.store.controlUpdaters.get(controls)?.(agent);
    }
    if (ctx.store.sheetKind === "agentSettings" && ctx.store.sheetAgent) {
      const incoming = ctx.store.state?.agents.find((candidate) => candidate.id === ctx.store.sheetAgent);
      if (!incoming) return;
      const agent = ctx.displayedAgent(incoming);
      const waiting = ctx.store.pendingSettings[ctx.store.sheetAgent];
      const body = ctx.$("#sheet-body");
      const press = (key: string, value: string | undefined) => {
        for (const button of body.querySelectorAll<HTMLButtonElement>(`[data-choice="${key}"] button`)) {
          button.setAttribute("aria-pressed", String(button.dataset.value === value));
          const pending = waiting?.[key as "permission" | "effort"] !== undefined;
          button.disabled = pending;
          ctx.setPending(button, pending && button.dataset.value === value);
          if (!pending) button.disabled = false;
        }
      };
      press("permission", agent.permission);
      press("effort", agent.effort);
      const select = body.querySelector<HTMLSelectElement>('select[name="model-choice"]');
      const field = body.querySelector<HTMLInputElement>('input[name="model"]');
      if (select) {
        const listed = [...select.options].filter((option) => option.value !== "__other__").map((option) => option.value);
        const incoming = agent.models.map((item) => item.value);
        if (listed.join("\u0000") !== incoming.join("\u0000")) {
          const previous = select.value;
          select.replaceChildren();
          for (const item of agent.models) {
            const option = ctx.el("option", "", item.label) as HTMLOptionElement;
            option.value = item.value;
            select.append(option);
          }
          const other = ctx.el("option", "", ctx.t("web.model.other")) as HTMLOptionElement;
          other.value = "__other__";
          select.append(other);
          const resolved = agent.models.find((item) => item.value === agent.model)
            ?? agent.models.find((item) => item.resolved === agent.model && item.value !== "default")
            ?? agent.models.find((item) => item.resolved === agent.model);
          select.value = previous === "__other__" && field?.value ? "__other__" : resolved?.value ?? "__other__";
          if (field) field.hidden = select.value !== "__other__";
        }
      }
      if (field) field.placeholder = agent.modelLabel ?? ctx.displayDefault(agent.model);
      const apply = body.querySelector<HTMLButtonElement>(".model-form button");
      if (apply) { ctx.setPending(apply, waiting?.model !== undefined); apply.disabled = waiting?.model !== undefined; }
      if (select) select.disabled = waiting?.model !== undefined;
      if (field) field.disabled = waiting?.model !== undefined;
      const pendingLabel = body.querySelector<HTMLElement>(".setting-pending");
      if (pendingLabel) {
        pendingLabel.hidden = !waiting || !Object.keys(waiting).length;
        pendingLabel.replaceChildren(ctx.el("span", "spin"), ctx.el("span", "", ctx.t("web.setting.pending")));
      }
    }
    if (ctx.store.sheetKind === "settings" && ctx.store.state) {
      const body = ctx.$("#sheet-body");
      const rolePresetSelect = body.querySelector<HTMLSelectElement>('select[name="role-preset"]');
      const presetPending = [...ctx.store.pendingRequests].some(line => line.startsWith("/role preset "));
      if (rolePresetSelect && !presetPending && !ctx.store.settingsRequests.has("rolePreset")) rolePresetSelect.value = ctx.store.state.rolePreset ?? "custom";
      if (rolePresetSelect) rolePresetSelect.disabled = presetPending || ctx.store.settingsRequests.has("rolePreset");
      const sandboxPending = [...ctx.store.pendingRequests].find(line => line.startsWith("/sandbox "));
      const sandboxSwitch = body.querySelector<HTMLButtonElement>('[data-choice="sandbox"][role="switch"]');
      if (sandboxSwitch) {
        sandboxSwitch.setAttribute("aria-checked", String((sandboxPending?.split(" ")[1] ?? (ctx.store.state.sandbox.enabled ? "on" : "off")) === "on"));
        ctx.setPending(sandboxSwitch, Boolean(sandboxPending));
        sandboxSwitch.disabled = Boolean(sandboxPending) || ctx.store.settingsRequests.has("sandbox");
      }
      for (const [key, value] of [["language", ctx.store.state.language]]) {
        const pendingLine = [...ctx.store.pendingRequests].find(line => line.startsWith(`/${key} `));
        for (const button of body.querySelectorAll<HTMLButtonElement>(`[data-choice="${key}"] button`)) {
          button.setAttribute("aria-pressed", String(button.dataset.value === (pendingLine?.split(" ")[1] ?? value)));
          ctx.setPending(button, Boolean(pendingLine) && button.dataset.value === pendingLine?.split(" ")[1]);
          button.disabled = Boolean(pendingLine);
        }
      }
      const ready = body.querySelector<HTMLElement>(".sandbox-ready");
      if (ready) {
        const label = ctx.t(ctx.store.state.sandbox.ready ? "web.settings.ready" : "web.settings.notReady");
        ready.replaceChildren(ctx.icon(ctx.store.state.sandbox.ready ? "check-circle" : "alert"));
        ready.setAttribute("aria-label", label);
        ready.title = label;
      }
      ctx.refreshGuiUpdate(body);
      ctx.refreshPush(body);
      body.querySelector(".limits-settings")?.classList.toggle("unlimited", ctx.store.state.limitsUnlimited);
      const limitsBusy = ctx.store.settingsRequests.has("limits");
      const unlimitedSwitch = body.querySelector<HTMLButtonElement>('[data-choice="unlimited"][role="switch"]');
      if (unlimitedSwitch) {
        unlimitedSwitch.setAttribute("aria-checked", String(ctx.store.state.limitsUnlimited));
        ctx.setPending(unlimitedSwitch, limitsBusy);
        unlimitedSwitch.disabled = limitsBusy;
      }
      for (const row of body.querySelectorAll<HTMLElement>("[data-limit]")) {
        const name = row.dataset.limit as keyof WebState["limits"];
        const limit = ctx.store.state.limits[name];
        const field = row.querySelector<HTMLInputElement>("input")!;
        field.disabled = limitsBusy;
        // 既定値はプレースホルダに出し、既定値のままなら空欄にする（DESIGN.md §17 設定）
        field.placeholder = String(limit.default);
        if (field.dataset.synced !== String(limit.value)) {
          field.value = limit.value === limit.default ? "" : String(limit.value);
          field.dataset.synced = String(limit.value);
        }
        row.querySelector<HTMLElement>(".limit-changed")!.hidden = limit.value === limit.default;
      }
      const limits = body.querySelector<HTMLElement>(".limits-settings");
      if (limits) {
        for (const button of limits.querySelectorAll<HTMLButtonElement>(".limits-actions button")) button.disabled = limitsBusy;
        ctx.syncLimitActions(limits);
      }
    }
  };
  return { refreshOpenSheet };
}
