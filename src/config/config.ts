// 設定ファイル（DESIGN.md §13 Roles）。ユーザー全体の設定を project の設定でトップレベルのキー単位に上書きする
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AGENT_IDS } from "../agents/agent-adapter.js";

const USER_CONFIG_PATH = join(".clodex", "config.json");
const PROJECT_CONFIG_FILE = ".clodex.json";

const nonNegativeInt = z.number().int().nonnegative();
const role = z.string().min(1);

const configSchema = z.strictObject({
  primary: z.enum(AGENT_IDS).optional(),
  roles: z.strictObject({ claude: role.optional(), codex: role.optional() }).optional(),
  limits: z.strictObject({
    maxMessagesPerChain: nonNegativeInt.optional(),
    maxReviewRoundsPerChain: nonNegativeInt.optional(),
    maxDelegationsPerChain: nonNegativeInt.optional(),
    maxDelegationDepth: nonNegativeInt.optional(),
  }).optional(),
  usageAlert: z.strictObject({
    weeklyPaceThreshold: z.number().optional(),
    fiveHourThreshold: z.number().min(0).max(100).optional(),
  }).optional(),
});

export type ClodexConfig = z.infer<typeof configSchema>;
export type RolesConfig = NonNullable<ClodexConfig["roles"]>;

const readConfigFile = (path: string): ClodexConfig => {
  if (!existsSync(path)) return {};
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`${path}: ${detail}`);
  }
  return parsed.data;
};

export interface ConfigPaths {
  homeDir: string;
  projectRoot: string;
}

export const loadConfig = ({ homeDir, projectRoot }: ConfigPaths): ClodexConfig => ({
  ...readConfigFile(join(homeDir, USER_CONFIG_PATH)),
  ...readConfigFile(join(projectRoot, PROJECT_CONFIG_FILE)),
});
