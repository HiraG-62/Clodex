// 人が切り替えた Agent の設定（権限・model・effort）を project ごとに保存する（DESIGN.md §9 Agent の設定の保存）
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { type AgentId, PERMISSION_LEVELS, type PermissionLevel } from "../agents/agent-adapter.js";
import { type BudgetLimits, isLimitValue, LIMIT_KEYS } from "../coordinator/budget-manager.js";
import { writeFileAtomic } from "./atomic-write.js";

const settingsSchema = z.strictObject({
  permission: z.enum(PERMISSION_LEVELS).optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
});
const savedLimits = z.unknown().transform((value): Partial<BudgetLimits> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const limits: Partial<BudgetLimits> = {};
  for (const key of Object.values(LIMIT_KEYS)) {
    const candidate: unknown = (value as Record<string, unknown>)[key];
    if (isLimitValue(candidate)) limits[key] = candidate;
  }
  return limits;
});
const savedSchema = z.strictObject({
  sandbox: z.boolean().optional(),
  claude: settingsSchema.optional(),
  codex: settingsSchema.optional(),
  limits: savedLimits.optional(),
  limitsUnlimited: z.literal(true).optional(),
});

export type AgentSettings = z.infer<typeof settingsSchema>;
export type SavedAgentSettings = z.infer<typeof savedSchema>;

export const agentSettingsPath = (conversationStatePath: string): string => conversationStatePath.replace(/\.json$/, ".settings.json");

export class AgentSettingsStore {
  constructor(private readonly path: string) {}

  // 壊れていても起動は妨げない（保存した値が無いものとして扱う）
  load(): SavedAgentSettings {
    if (!existsSync(this.path)) return {};
    try {
      const parsed = savedSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  setSandbox(sandbox: boolean): void {
    writeFileAtomic(this.path, `${JSON.stringify({ ...this.load(), sandbox }, null, 2)}\n`);
  }

  setLimits(limits: Partial<BudgetLimits>): void {
    const saved = this.load();
    if (Object.keys(limits).length) saved.limits = limits;
    else delete saved.limits;
    writeFileAtomic(this.path, `${JSON.stringify(saved, null, 2)}\n`);
  }

  setUnlimited(unlimited: boolean): void {
    const { limitsUnlimited: _old, ...saved } = this.load();
    writeFileAtomic(this.path, `${JSON.stringify(unlimited ? { ...saved, limitsUnlimited: true } : saved, null, 2)}\n`);
  }

  update(agents: readonly AgentId[], change: AgentSettings): void {
    const saved = this.load();
    for (const id of agents) saved[id] = { ...saved[id], ...change };
    writeFileAtomic(this.path, `${JSON.stringify(saved, null, 2)}\n`);
  }
}

export interface StartSettingsSources {
  saved: SavedAgentSettings;
  configPermission?: PermissionLevel;
  // 起動オプション（--claude-model 等）
  models: Partial<Record<AgentId, string>>;
}

// 優先順位: 起動オプション > 保存した値 > 設定ファイル
export const resolveStartSettings = ({ saved, configPermission, models }: StartSettingsSources): Record<AgentId, AgentSettings> => {
  const resolve = (id: AgentId): AgentSettings => {
    const permission = saved[id]?.permission ?? configPermission;
    const model = models[id] ?? saved[id]?.model;
    const effort = saved[id]?.effort;
    return { ...(permission ? { permission } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  };
  return { claude: resolve("claude"), codex: resolve("codex") };
};
