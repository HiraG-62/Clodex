import type { AgentId } from "./agent-adapter.js";

export interface ModelOption { value: string; label: string; resolved?: string }
export type ModelCatalog = Record<AgentId, ModelOption[]>;
export const EMPTY_MODEL_CATALOG = (): ModelCatalog => ({ claude: [], codex: [] });

export const modelLabel = (value: string | undefined, models: readonly ModelOption[]): string => {
  if (!value) return "default";
  const direct = models.find((item) => item.value === value);
  if (direct) return direct.label;
  const resolved = models.find((item) => item.resolved === value && item.value !== "default")
    ?? models.find((item) => item.resolved === value);
  return resolved?.label ?? value;
};
