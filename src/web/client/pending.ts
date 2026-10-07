import type { AgentId, PermissionLevel } from "../../agents/agent-adapter.js";
import type { AgentState } from "../../cli/shell.js";

export type PendingSettings = Partial<Record<AgentId, { model?: string; effort?: string; permission?: PermissionLevel }>>;

export function resolvePendingSettings(pending: PendingSettings, agents: readonly AgentState[]): PendingSettings {
  const result: PendingSettings = {};
  for (const id of ["claude", "codex"] as const) {
    const requested = pending[id];
    if (!requested) continue;
    const agent = agents.find((entry) => entry.id === id);
    const remaining = { ...requested };
    if (agent) {
      const resolved = agent.models.find((model) => model.value === requested.model)?.resolved;
      if (requested.model === agent.model || (resolved !== undefined && resolved === agent.model)) delete remaining.model;
      if (requested.effort === agent.effort) delete remaining.effort;
      if (requested.permission === agent.permission) delete remaining.permission;
    }
    if (Object.keys(remaining).length) result[id] = remaining;
  }
  return result;
}

export function isNavigationCommand(line: string): boolean {
  return /^\/(?:new|resume|project|sandbox)(?:\s|$)/.test(line.trim());
}

export function nextCommandStart(previous: string | undefined, text: string, now: string): string | undefined {
  let start = previous;
  for (const line of text.split("\n")) {
    if (line.startsWith("$ ")) start = now;
    else if (/^(?:exit -?\d+ \(|stopped \(|error: )/.test(line)) start = undefined;
  }
  return start;
}
