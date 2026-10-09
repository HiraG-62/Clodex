import type { AgentId, PermissionLevel } from "../../agents/agent-adapter.js";
import type { CommandLifecycle } from "../../cli/command-runner.js";
import type { AgentState } from "../../cli/shell.js";

export type PendingSettings = Partial<Record<AgentId, { model?: string; effort?: string; permission?: PermissionLevel }>>;
export type PendingDeadlines = Partial<Record<AgentId, Partial<Record<"model" | "effort" | "permission", number>>>>;

export function resolvePendingSettings(
  pending: PendingSettings,
  agents: readonly AgentState[],
  deadlines: PendingDeadlines = {},
  now = Date.now(),
): PendingSettings {
  const result: PendingSettings = {};
  for (const id of ["claude", "codex"] as const) {
    const requested = pending[id];
    if (!requested) continue;
    const agent = agents.find(entry => entry.id === id);
    const remaining = { ...requested };
    for (const key of ["model", "effort", "permission"] as const) {
      const deadline = deadlines[id]?.[key];
      if (deadline !== undefined && deadline <= now) delete remaining[key];
    }
    if (agent) {
      const resolved = agent.models.find(model => model.value === requested.model)?.resolved;
      if (requested.model === agent.model || (resolved !== undefined && resolved === agent.model)) delete remaining.model;
      if (requested.effort === agent.effort) delete remaining.effort;
      if (requested.permission === agent.permission) delete remaining.permission;
    }
    if (Object.keys(remaining).length) result[id] = remaining;
  }
  return result;
}

export function isNavigationCommand(line: string): boolean {
  return /^\/(?:new|resume|project|tab|sandbox)(?:\s|$)/.test(line.trim());
}

export type CommandStarts = Record<number, { at: string; outputId: string }>;

export function nextCommandStarts(previous: Readonly<CommandStarts>, command: CommandLifecycle | undefined, now: string, outputId?: string): CommandStarts {
  if (!command) return previous;
  const result = { ...previous };
  if (command.phase === "start" && outputId !== undefined) result[command.id] ??= { at: now, outputId };
  else if (command.phase === "exit") delete result[command.id];
  return result;
}
