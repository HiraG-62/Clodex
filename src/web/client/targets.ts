import { AGENT_IDS, type AgentId } from "../../agents/agent-adapter.js";
import type { ClientContext } from "./store.js";

const TARGET_PREFIX = "clodex.target:";
type TargetStorage = Pick<ClientContext["storage"], "get" | "set" | "remove">;
type Solo = AgentId | "free" | undefined;

export function targetKey(projectRoot: string, conversationId: string): string {
  return `${TARGET_PREFIX}${encodeURIComponent(projectRoot)}:${encodeURIComponent(conversationId)}`;
}

export function staleTargetKeys(keys: readonly string[], projectRoot: string, conversationIds: readonly string[]): string[] {
  const prefix = `${TARGET_PREFIX}${encodeURIComponent(projectRoot)}:`;
  const current = new Set(conversationIds.map(id => targetKey(projectRoot, id)));
  return keys.filter(key => key.startsWith(prefix) && !current.has(key));
}

export function readTarget(storage: Pick<TargetStorage, "get" | "remove">, key: string, solo?: Solo): AgentId | undefined {
  const value = storage.get(key);
  const target = AGENT_IDS.find(id => id === value);
  if (value !== null && !target) storage.remove(key);
  return solo && solo !== "free" ? solo : target;
}

export function saveTarget(storage: Pick<TargetStorage, "set">, key: string, target: AgentId, solo?: Solo): void {
  if (solo && solo !== "free") return;
  storage.set(key, target);
}

export function selectTarget(ctx: Pick<ClientContext, "store" | "storage" | "renderState">, target: AgentId): void {
  const state = ctx.store.state;
  const conversation = state?.conversations.find(entry => entry.current);
  if (conversation?.solo && conversation.solo !== "free") return;
  ctx.store.target = target;
  const projectRoot = state?.projects?.find(project => project.current)?.projectRoot;
  if (projectRoot && conversation) saveTarget(ctx.storage, targetKey(projectRoot, conversation.id), target, conversation.solo);
  ctx.renderState();
}
