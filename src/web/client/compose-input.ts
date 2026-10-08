// ブラウザへ関数のまま埋め込む。外部 runtime 依存を持たせない
import type { AgentId } from "../../agents/agent-adapter.js";

export function composeInputLine(text: string, target: AgentId | undefined): string {
  if (!target) return text;
  const explicitRecipient = /^@(claude|codex|all)!?(?:\s|$)/;
  if (text.startsWith("!>")) return `@${target} ${text}`;
  if (text === "/context" || text.startsWith("/context ")) return `@${target} ${text}`;
  return text.startsWith("/") || explicitRecipient.test(text) || text.startsWith("!") ? text : `@${target} ${text}`;
}
