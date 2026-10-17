import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentId } from "../agents/agent-adapter.js";

const SECOND_MS = 1000;
const HANDOFF_INSTRUCTION =
  "Write a handoff document to <path> for your next session: decisions made, open issues, the human's latest decisions, paths to evidence (commits, specs, screenshots), and requests you sent that are still waiting for a reply (message ID and taskId). Then reply with only the path.";

export const handoffInstruction = (path: string): string => HANDOFF_INSTRUCTION.replace("<path>", () => path);

export const handoffNotice = (path: string): string => `[Clodex] Handoff: your previous session wrote ${path}. Read it before continuing.`;

export const createHandoffPath = (artifactsDir: string, agent: AgentId): string => {
  mkdirSync(artifactsDir, { recursive: true });
  for (let time = Date.now(); ; time += SECOND_MS) {
    const stamp = new Date(time)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace("T", "-")
      .replace(/\.\d+Z$/, "");
    const path = join(artifactsDir, `handoff-${agent}-${stamp}.md`);
    if (!existsSync(path)) return path;
  }
};

export const hasHandoffDocument = (path: string): boolean => {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
};
