// project の役割だけを書き換え、他の設定は保つ（DESIGN.md §28 E）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId } from "../agents/agent-adapter.js";
import { writeFileAtomic } from "./atomic-write.js";

const CONFIG_FILE = ".clodex.json";

export const saveProjectRole = (projectRoot: string, agent: AgentId, text: string): string => {
  const path = join(projectRoot, CONFIG_FILE);
  const parsed: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path}: invalid JSON object`);
  const config = parsed as Record<string, unknown>;
  const previous = config.roles;
  if (previous !== undefined && (!previous || typeof previous !== "object" || Array.isArray(previous))) {
    throw new Error(`${path}: roles must be an object`);
  }
  const roles = (previous ?? {}) as Record<string, unknown>;
  const normalized = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  if (!normalized) throw new Error("role must not be empty");
  config.roles = { ...roles, [agent]: normalized };
  writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
  return normalized;
};
