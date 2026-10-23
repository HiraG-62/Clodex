// 設定ファイル（DESIGN.md §13 Roles）。オブジェクトはキーごとに重ね、rules は user → project の順につなぐ
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AGENT_IDS, type AgentId, PERMISSION_LEVELS } from "../agents/agent-adapter.js";
import { agentRecord } from "../agents/agent-meta.js";
import { LANGUAGES, type Language } from "../context/language.js";
import { writeFileAtomic } from "../project/atomic-write.js";

const USER_CONFIG_PATH = join(".clodex", "config.json");
const CLODEX_HOME_ENV = "CLODEX_HOME";

// Clodex 自身のデータ（.clodex/）の置き場所。実 CLI の E2E がユーザーの一覧や設定を書き換えないよう差し替えられる（DESIGN.md §28 D2a）
export const clodexHomeDir = (env: NodeJS.ProcessEnv = process.env): string => env[CLODEX_HOME_ENV] || homedir();
const PROJECT_CONFIG_FILE = ".clodex.json";

const UPDATE_CHANNELS = ["stable", "dev"] as const;

const nonNegativeInt = z.number().int().nonnegative();
const role = z.string();

const configSchema = z.strictObject({
  sandbox: z.boolean().optional(),
  primary: z.enum(AGENT_IDS).optional(),
  language: z.enum(LANGUAGES).optional(),
  permission: z.enum(PERMISSION_LEVELS).optional(),
  updateChannel: z.enum(UPDATE_CHANNELS).optional(),
  roles: z.strictObject(agentRecord(() => role.optional())).optional(),
  verify: z.strictObject({ implement: z.array(z.string().min(1)).optional(), integrate: z.array(z.string().min(1)).optional() }).optional(),
  specSections: z.strictObject({ owned: z.string().optional(), forbidden: z.string().optional() }).optional(),
  specCheck: z.string().min(1).optional(),
  rules: z.strictObject(agentRecord(() => z.string().optional())).optional(),
  freshThread: z.strictObject({ DELEGATE: z.boolean().optional(), REVIEW_REQUEST: z.boolean().optional() }).optional(),
  usageHints: z.strictObject(agentRecord(() => z.boolean().optional())).optional(),
  threadTokenWarn: z.union([z.number().int().positive(), z.strictObject(agentRecord(() => z.number().int().positive().optional()))]).optional(),
  limits: z
    .strictObject({
      maxMessagesPerChain: nonNegativeInt.optional(),
      maxReviewRoundsPerChain: nonNegativeInt.optional(),
      maxDelegationsPerChain: nonNegativeInt.optional(),
      maxDelegationDepth: nonNegativeInt.optional(),
    })
    .optional(),
  worktree: z.strictObject({ setup: z.string().optional() }).optional(),
  web: z.strictObject({ port: z.number().int().min(1).max(65535).optional() }).optional(),
  usageAlert: z
    .strictObject({
      weeklyPaceThreshold: z.number().optional(),
      fiveHourThreshold: z.number().min(0).max(100).optional(),
    })
    .optional(),
});

export type ClodexConfig = z.infer<typeof configSchema>;
export type RolesConfig = NonNullable<ClodexConfig["roles"]>;
export type ConfigSource = "user" | "project";
export interface ConfigSources {
  roles: Partial<Record<AgentId, ConfigSource>>;
  rules: Partial<Record<AgentId, Array<{ source: ConfigSource; text: string }>>>;
}
export interface ConfigLayers {
  config: ClodexConfig;
  sources: ConfigSources;
}

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
    const detail = parsed.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`${path}: ${detail}`);
  }
  const config = parsed.data;
  for (const key of ["roles", "rules"] as const) {
    const values = config[key];
    if (!values) continue;
    for (const agent of AGENT_IDS) if (!values[agent]) delete values[agent];
    if (!Object.keys(values).length) delete config[key];
  }
  return config;
};

export interface ConfigPaths {
  homeDir: string;
  projectRoot: string;
}

export const ensureUserConfigTemplate = (homeDir: string): void => {
  const path = join(homeDir, USER_CONFIG_PATH);
  if (existsSync(path)) return;
  try {
    writeFileAtomic(path, `${JSON.stringify({ roles: agentRecord(() => "") }, null, 2)}\n`);
  } catch {
    // ひな形の保存に失敗しても、設定なしで起動する。
  }
};

const OBJECT_CONFIG_KEYS = ["roles", "freshThread", "usageHints", "limits", "worktree", "web", "usageAlert", "verify", "specSections"] as const;

export const loadConfigLayers = ({ homeDir, projectRoot }: ConfigPaths): ConfigLayers => {
  const user = readConfigFile(join(homeDir, USER_CONFIG_PATH));
  const project = readConfigFile(join(projectRoot, PROJECT_CONFIG_FILE));
  const config: ClodexConfig = { ...user, ...project };
  for (const key of OBJECT_CONFIG_KEYS) {
    if (user[key] && project[key]) Object.assign(config, { [key]: { ...user[key], ...project[key] } });
  }
  if (typeof user.threadTokenWarn === "object" && typeof project.threadTokenWarn === "object") {
    config.threadTokenWarn = { ...user.threadTokenWarn, ...project.threadTokenWarn };
  }
  const sources: ConfigSources = { roles: {}, rules: {} };
  const rules: NonNullable<ClodexConfig["rules"]> = {};
  for (const agent of AGENT_IDS) {
    if (project.roles?.[agent]) sources.roles[agent] = "project";
    else if (user.roles?.[agent]) sources.roles[agent] = "user";
    const layers: NonNullable<ConfigSources["rules"][AgentId]> = [];
    if (user.rules?.[agent]) layers.push({ source: "user", text: user.rules[agent] });
    if (project.rules?.[agent]) layers.push({ source: "project", text: project.rules[agent] });
    if (!layers.length) continue;
    sources.rules[agent] = layers;
    rules[agent] = layers.map(layer => layer.text).join("\n");
  }
  if (Object.keys(rules).length) config.rules = rules;
  return { config, sources };
};

export const loadConfig = (paths: ConfigPaths): ClodexConfig => loadConfigLayers(paths).config;

export const saveUserLanguage = (homeDir: string, language: Language): void => {
  const path = join(homeDir, USER_CONFIG_PATH);
  try {
    const next = z.enum(LANGUAGES).parse(language);
    const config = existsSync(path) ? configSchema.parse(JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""))) : {};
    writeFileAtomic(path, `${JSON.stringify({ ...config, language: next }, null, 2)}\n`);
  } catch (error) {
    const detail =
      error instanceof z.ZodError
        ? error.issues.map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`${path}: ${detail}`, { cause: error });
  }
};
