import type { LimitName } from "../../coordinator/budget-manager.js";
import { ROLE_PRESET_NAMES, type RolePresetName } from "../../config/role-presets.js";
import type { MessageKey } from "../../i18n/messages.js";
import type { WebState } from "../web-feed.js";
import { limitChanges } from "./limit-changes.js";
import type { SettingsItem, SettingsSectionId } from "./settings-sections.js";
import { settingsSections } from "./settings-sections.js";
import type { ClientContext } from "./store.js";

export function createSettingsSheet(ctx: ClientContext) {

  const settingsSwitch = (key: string, label: string, checked: boolean, pick: (checked: boolean, button: HTMLButtonElement) => void) => {
    const wrap = ctx.el("div", "setting");
    const button = ctx.el("button", "settings-switch") as HTMLButtonElement;
    button.type = "button";
    button.dataset.choice = key;
    button.setAttribute("role", "switch");
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-checked", String(checked));
    button.addEventListener("click", () => pick(button.getAttribute("aria-checked") !== "true", button));
    wrap.append(ctx.el("div", "eyebrow", label), button);
    return wrap;
  };
  const LIMIT_LABEL: Record<keyof WebState["limits"], MessageKey> = {
    messages: "web.settings.messages", reviews: "web.settings.reviews", delegations: "web.settings.delegations", depth: "web.settings.depth",
  };
  const LIMIT_MIN = 1;
  const LIMIT_MAX = 100;
  const ROLE_PRESET_LABELS: Record<RolePresetName, MessageKey> = {
    "design-review": "web.rolePreset.designReview",
    "codex-design": "web.rolePreset.codexDesign",
    "implement-review": "web.rolePreset.implementReview",
  };
  ctx.store.settingsRequests = new Set<string>();
  const limitDraft = (form: HTMLElement): Record<LimitName, string> => ({
    messages: form.querySelector<HTMLInputElement>("#limit-messages")!.value,
    reviews: form.querySelector<HTMLInputElement>("#limit-reviews")!.value,
    delegations: form.querySelector<HTMLInputElement>("#limit-delegations")!.value,
    depth: form.querySelector<HTMLInputElement>("#limit-depth")!.value,
  });
  const draftLimitChanges = (form: HTMLElement, limits: WebState["limits"]) => limitChanges(
    { messages: limits.messages.value, reviews: limits.reviews.value, delegations: limits.delegations.value, depth: limits.depth.value },
    limitDraft(form),
    { messages: limits.messages.default, reviews: limits.reviews.default, delegations: limits.delegations.default, depth: limits.depth.default },
  );
  const syncLimitActions = (form: HTMLElement) => {
    if (!ctx.store.state) return;
    const { changes, valid } = draftLimitChanges(form, ctx.store.state.limits);
    form.querySelector<HTMLButtonElement>(".limits-apply")!.disabled = ctx.store.settingsRequests.has("limits") || !valid || changes.length === 0;
  };
  const settingsChoice = <T extends string>(key: string, label: string, options: readonly T[], current: T, name: (value: T) => string) =>
    ctx.choice(key, label, options, current, name, (value, button) => {
      const segment = button.parentElement!;
      ctx.store.settingsRequests.add(key);
      for (const control of segment.querySelectorAll<HTMLButtonElement>("button")) control.disabled = true;
      void ctx.send(`/${key} ${value}`, button).then(() => {
        ctx.store.settingsRequests.delete(key);
        for (const control of document.querySelectorAll<HTMLButtonElement>(`[data-choice="${key}"] button`)) { ctx.setPending(control, false); control.disabled = false; }
        ctx.refreshOpenSheet();
      });
    });
  const openSettings = () => {
    if (!ctx.store.state) return;
    ctx.store.sheetKind = "settings";
    ctx.store.sheetAgent = undefined;
    const sandbox = settingsSwitch("sandbox", ctx.t("web.settings.sandbox"), ctx.store.state.sandbox.enabled, (checked, button) => {
      ctx.store.settingsRequests.add("sandbox");
      void ctx.send(`/sandbox ${checked ? "on" : "off"}`, button).finally(() => {
        ctx.store.settingsRequests.delete("sandbox");
        ctx.refreshOpenSheet();
      });
      ctx.refreshOpenSheet();
    });
    sandbox.querySelector(".eyebrow")!.append(ctx.el("span", "sandbox-ready"));
    const limits = ctx.el("form", "setting limits-settings") as HTMLFormElement;
    limits.append(ctx.el("div", "eyebrow", ctx.t("web.settings.limits")));
    const unlimited = settingsSwitch("unlimited", ctx.t("web.settings.unlimited"), ctx.store.state.limitsUnlimited, (checked, button) =>
      sendLimits(`/limits ${checked ? "unlimited" : "reset"}`, button));
    unlimited.classList.add("limits-unlimited");
    limits.append(unlimited);
    for (const name of Object.keys(LIMIT_LABEL) as Array<keyof WebState["limits"]>) {
      const row = ctx.el("div", "limit-row");
      row.dataset.limit = name;
      const label = ctx.el("label", "limit-label", ctx.t(LIMIT_LABEL[name])) as HTMLLabelElement;
      label.htmlFor = `limit-${name}`;
      const mark = ctx.el("span", "limit-changed", "•");
      mark.title = ctx.t("web.settings.changed");
      mark.setAttribute("aria-label", mark.title);
      label.append(mark);
      const field = ctx.el("input") as HTMLInputElement;
      field.id = label.htmlFor;
      field.name = name;
      field.type = "number";
      field.min = String(LIMIT_MIN);
      field.max = String(LIMIT_MAX);
      field.step = "1";
      row.append(label, field);
      field.addEventListener("input", () => syncLimitActions(limits));
      limits.append(row);
    }
    const sendLimits = (line: string, button: HTMLButtonElement) => {
      if (ctx.store.settingsRequests.has("limits")) return;
      ctx.store.settingsRequests.add("limits");
      ctx.refreshOpenSheet();
      void ctx.send(line, button).finally(() => {
        ctx.store.settingsRequests.delete("limits");
        for (const field of limits.querySelectorAll<HTMLInputElement>(".limit-row input")) delete field.dataset.synced;
        ctx.refreshOpenSheet();
      });
    };
    const reset = ctx.el("button", "btn limits-reset", ctx.t("web.settings.reset")) as HTMLButtonElement;
    reset.type = "button";
    reset.addEventListener("click", () => sendLimits("/limits reset", reset));
    const apply = ctx.el("button", "btn limits-apply", ctx.t("web.settings.apply")) as HTMLButtonElement;
    apply.type = "submit";
    limits.addEventListener("submit", event => {
      event.preventDefault();
      if (!ctx.store.state || ctx.store.settingsRequests.has("limits")) return;
      const { changes, valid } = draftLimitChanges(limits, ctx.store.state.limits);
      if (!valid || !changes.length) return;
      sendLimits(`/limits ${changes.map(({ name, value }) => `${name} ${value}`).join(" ")}`, apply);
    });
    const actions = ctx.el("div", "limits-actions");
    actions.append(reset, apply);
    limits.append(actions);
    const language = settingsChoice("language", ctx.t("web.settings.language"), ["ja", "en"] as const, ctx.store.state.language, value => value === "ja" ? "日本語" : "English");
    const rolePreset = ctx.el("div", "setting");
    const presetLabel = ctx.el("label", "eyebrow", ctx.t("web.settings.rolePreset")) as HTMLLabelElement;
    const presetSelect = ctx.el("select", "setting-select") as HTMLSelectElement;
    presetSelect.id = "role-preset";
    presetSelect.name = "role-preset";
    presetLabel.htmlFor = presetSelect.id;
    const customOption = ctx.el("option", "", ctx.t("web.rolePreset.custom")) as HTMLOptionElement;
    customOption.value = "custom";
    customOption.disabled = true;
    presetSelect.append(customOption);
    for (const name of ROLE_PRESET_NAMES) {
      const option = ctx.el("option", "", ctx.t(ROLE_PRESET_LABELS[name])) as HTMLOptionElement;
      option.value = name;
      presetSelect.append(option);
    }
    presetSelect.value = ctx.store.state.rolePreset ?? "custom";
    presetSelect.addEventListener("change", () => {
      const name = presetSelect.value;
      ctx.store.settingsRequests.add("rolePreset");
      presetSelect.disabled = true;
      void ctx.send(`/role preset ${name}`).finally(() => {
        ctx.store.settingsRequests.delete("rolePreset");
        ctx.refreshOpenSheet();
      });
    });
    rolePreset.append(presetLabel, presetSelect);
    // 端末ごとの設定なので Hub には送らない。スマホは常に Enter で改行するので出さない
    const sendKeyChoice = ctx.choice("sendKey", ctx.t("web.settings.sendKey"), ctx.SEND_KEYS, ctx.store.sendKey,
      value => ctx.t(value === "enter" ? "web.settings.sendEnter" : "web.settings.sendCtrlEnter"),
      value => { ctx.store.sendKey = value; ctx.storage.set(ctx.SEND_KEY_KEY, value); });
    const items: Record<SettingsItem, HTMLElement> = { rolePreset, sandbox, limits, sendKey: sendKeyChoice, push: ctx.pushSection(), language, guiUpdate: ctx.guiUpdateSection() };
    const headings: Record<SettingsSectionId, string> = { project: ctx.t("web.settings.project"), device: ctx.t("web.settings.device"), clodex: "Clodex" };
    const groups = settingsSections({ mobile: ctx.mobile.matches, pushSupported: ctx.pushSupported, guiConnected: Boolean(ctx.store.gui) }).map(section => {
      const group = ctx.el("section", `settings-group settings-${section.id}`);
      group.append(ctx.el("h3", "settings-section-heading", headings[section.id]));
      const card = ctx.el("div", "settings-card");
      card.append(...section.items.map(item => items[item]));
      group.append(card);
      return group;
    });
    ctx.openSheet(ctx.t("web.settings.title"), groups);
    ctx.refreshOpenSheet();
  };
  return { settingsSwitch, syncLimitActions, openSettings };
}
