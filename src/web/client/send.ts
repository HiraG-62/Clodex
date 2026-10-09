import type { AgentId } from "../../agents/agent-adapter.js";
import type { AgentState } from "../../cli/shell.js";
import { isNavigationCommand, resolvePendingSettings } from "./pending.js";
import type { ClientContext } from "./store.js";

export function createSend(ctx: ClientContext) {
  // ---- 送信 ----
  // 送れたら true。失敗したら理由をトーストで出す
  const setPending = (button: HTMLButtonElement, pending: boolean) => {
    if (pending && !button.classList.contains("is-loading")) button.dataset.wasDisabled = String(button.disabled);
    if (!pending && button.classList.contains("is-loading")) button.disabled = button.dataset.wasDisabled === "true";
    if (pending) button.disabled = true;
    button.classList.toggle("is-loading", pending);
    button.setAttribute("aria-busy", String(pending));
  };
  const syncPendingButtons = () => {
    for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-command]")) {
      const line = button.dataset.command ?? "";
      const agent = line.split(" ")[1] as AgentId;
      setPending(button, ctx.store.pendingRequests.has(line) || (line.startsWith("/interrupt ") && ctx.store.interrupting.has(agent)));
      if (line.startsWith("/interrupt ") && ctx.store.state?.agents.find(entry => entry.id === agent)?.status !== "busy") button.disabled = true;
    }
    ctx.$(".app").classList.toggle("navigation-pending", [...ctx.store.pendingRequests].some(isNavigationCommand));
  };
  const withPending = async <T>(button: HTMLButtonElement | undefined, operation: () => Promise<T>): Promise<T> => {
    if (button) setPending(button, true);
    try {
      return await operation();
    } finally {
      if (button) setPending(button, false);
    }
  };
  const send = async (line: string, button?: HTMLButtonElement): Promise<boolean> => {
    if (ctx.store.pendingRequests.has(line)) return false;
    ctx.store.pendingRequests.add(line);
    if (button) button.dataset.command = line;
    const stoppedAgent = line.startsWith("/interrupt ") ? (line.split(" ")[1] as AgentId) : undefined;
    const interruptAttempt = Symbol();
    if (stoppedAgent) {
      ctx.store.interrupting.add(stoppedAgent);
      ctx.store.interruptAttempts.set(stoppedAgent, interruptAttempt);
    }
    syncPendingButtons();
    try {
      return await withPending(button, async () => {
        try {
          const response = await fetch("/api/input", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ line }),
          });
          if (response.ok) return true;
          ctx.showToast(ctx.t("web.send.failedStatus", { status: response.status }));
        } catch {
          ctx.showToast(ctx.t("web.send.failed"));
        }
        if (stoppedAgent) ctx.store.interrupting.delete(stoppedAgent);
        return false;
      });
    } finally {
      if (stoppedAgent && ctx.store.interrupting.has(stoppedAgent)) {
        const generation = ctx.store.liveGeneration;
        window.setTimeout(() => {
          if (
            generation !== ctx.store.liveGeneration ||
            ctx.store.pendingRequests.has(line) ||
            ctx.store.interruptAttempts.get(stoppedAgent) !== interruptAttempt
          )
            return;
          ctx.store.interrupting.delete(stoppedAgent);
          syncPendingButtons();
        }, ctx.INTERRUPT_RETRY_MS);
      }
      ctx.store.pendingRequests.delete(line);
      syncPendingButtons();
    }
  };
  const requestSetting = async (id: AgentId, key: "model" | "effort" | "permission", value: string, button?: HTMLButtonElement) => {
    if (ctx.store.pendingSettings[id]?.[key] !== undefined) return false;
    const generation = ctx.store.liveGeneration;
    const requestKey = `${id}:${key}`;
    const request = Symbol();
    ctx.store.settingRequests.set(requestKey, request);
    ctx.store.pendingSettings[id] = { ...ctx.store.pendingSettings[id], [key]: value };
    delete ctx.store.pendingDeadlines[id]?.[key];
    ctx.renderState();
    const sent = await send(`/${key} ${id} ${value}`, button);
    if (generation !== ctx.store.liveGeneration || ctx.store.settingRequests.get(requestKey) !== request) return false;
    if (!sent) {
      delete ctx.store.pendingSettings[id]?.[key];
      ctx.renderState();
    } else if (ctx.store.pendingSettings[id]?.[key] === value) {
      const deadline = Date.now() + ctx.SETTING_TIMEOUT_MS;
      ctx.store.pendingDeadlines[id] = { ...ctx.store.pendingDeadlines[id], [key]: deadline };
      window.setTimeout(() => {
        if (generation !== ctx.store.liveGeneration || ctx.store.pendingDeadlines[id]?.[key] !== deadline) return;
        ctx.store.pendingSettings = resolvePendingSettings(ctx.store.pendingSettings, ctx.store.state?.agents ?? [], ctx.store.pendingDeadlines);
        ctx.renderState();
      }, ctx.SETTING_TIMEOUT_MS);
    }
    ctx.refreshOpenSheet();
    return sent;
  };
  const displayedAgent = (agent: AgentState): AgentState => ({
    ...agent,
    ...ctx.store.pendingSettings[agent.id],
    ...(ctx.store.pendingSettings[agent.id]?.model ? { modelLabel: ctx.store.pendingSettings[agent.id]!.model } : {}),
  });
  return { send, displayedAgent, syncPendingButtons, requestSetting, setPending, withPending };
}
