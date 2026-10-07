// 設定ファイル（DESIGN.md §13 Roles）。ユーザー全体の設定を project の設定でトップレベルのキー単位に上書きする
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AGENT_IDS, PERMISSION_LEVELS } from "../agents/agent-adapter.js";
import { LANGUAGES, type Language } from "../context/language.js";
import { writeFileAtomic } from "../project/atomic-write.js";

const USER_CONFIG_PATH = join(".clodex", "config.json");
const PROJECT_CONFIG_FILE = ".clodex.json";

const nonNegativeInt = z.number().int().nonnegative();
const role = z.string();

const configSchema = z.strictObject({
  sandbox: z.boolean().optional(),
  primary: z.enum(AGENT_IDS).optional(),
  language: z.enum(LANGUAGES).optional(),
  permission: z.enum(PERMISSION_LEVELS).optional(),
  roles: z.strictObject({ claude: role.optional(), codex: role.optional() }).optional(),
  limits: z.strictObject({
    maxMessagesPerChain: nonNegativeInt.optional(),
    maxReviewRoundsPerChain: nonNegativeInt.optional(),
    maxDelegationsPerChain: nonNegativeInt.optional(),
    maxDelegationDepth: nonNegativeInt.optional(),
  }).optional(),
  web: z.strictObject({ port: z.number().int().min(1).max(65535).optional() }).optional(),
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
    json = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`${path}: ${detail}`);
  }
  const { roles, ...config } = parsed.data;
  if (!roles) return config;
  const configuredRoles: RolesConfig = {};
  if (roles.claude) configuredRoles.claude = roles.claude;
  if (roles.codex) configuredRoles.codex = roles.codex;
  return Object.keys(configuredRoles).length ? { ...config, roles: configuredRoles } : config;
};

export interface ConfigPaths {
  homeDir: string;
  projectRoot: string;
}

export const ensureUserConfigTemplate = (homeDir: string): void => {
  const path = join(homeDir, USER_CONFIG_PATH);
  if (existsSync(path)) return;
  try {
    writeFileAtomic(path, `${JSON.stringify({ roles: { claude: "", codex: "" } }, null, 2)}\n`);
  } catch {
    // ひな形の保存に失敗しても、設定なしで起動する。
  }
};

export const loadConfig = ({ homeDir, projectRoot }: ConfigPaths): ClodexConfig => ({
  ...readConfigFile(join(homeDir, USER_CONFIG_PATH)),
  ...readConfigFile(join(projectRoot, PROJECT_CONFIG_FILE)),
});

export const saveUserLanguage = (homeDir: string, language: Language): void => {
  const next = z.enum(LANGUAGES).parse(language);
  const path = join(homeDir, USER_CONFIG_PATH);
  const config = existsSync(path) ? configSchema.parse(JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""))) : {};
  writeFileAtomic(path, `${JSON.stringify({ ...config, language: next }, null, 2)}\n`);
};
