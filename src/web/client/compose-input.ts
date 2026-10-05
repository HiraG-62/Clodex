// ブラウザへ関数のまま埋め込む。外部 runtime 依存を持たせない
import type { AgentId } from "../../agents/agent-adapter.js";

export function composeInputLine(text: string, target: AgentId | undefined): string {
  return text.startsWith("/") || text.startsWith("@") || text.startsWith("!") || !target
    ? text : `@${target} ${text}`;
}
