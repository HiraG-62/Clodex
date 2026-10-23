import { AGENT_IDS, type AgentId } from "../../agents/agent-adapter.js";

export function composeInputLine(text: string, target: AgentId | undefined): string {
  if (!target) return text;
  const explicitRecipient = new RegExp(`^@(${[...AGENT_IDS, "all"].join("|")})!?(?:\\s|$)`);
  if (text.startsWith("!>")) return `@${target} ${text}`;
  if (text === "/context" || text.startsWith("/context ")) return `@${target} ${text}`;
  return text.startsWith("/") || explicitRecipient.test(text) || text.startsWith("!") ? text : `@${target} ${text}`;
}
