// ブラウザへ関数のまま埋め込む。外部 runtime 依存を持たせない
import type { AgentId } from "../../agents/agent-adapter.js";

export function composeInputLine(text: string, target: AgentId | undefined): string {
  if (!target) return text;
  if (text.startsWith("!>")) return `@${target} ${text}`;
  return text.startsWith("/") || text.startsWith("@") || text.startsWith("!") ? text : `@${target} ${text}`;
}
