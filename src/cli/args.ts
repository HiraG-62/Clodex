// 起動オプション（DESIGN.md §7）
import { parseArgs } from "node:util";
import { AGENT_IDS, type AgentId } from "../agents/agent-adapter.js";

export interface CliArgs {
  project?: string;
  primary: AgentId;
  models: Partial<Record<AgentId, string>>;
}

const DEFAULT_PRIMARY: AgentId = "claude";

const isAgentId = (value: string): value is AgentId => (AGENT_IDS as readonly string[]).includes(value);

export const parseCliArgs = (argv: string[]): CliArgs => {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      primary: { type: "string" },
      "claude-model": { type: "string" },
      "codex-model": { type: "string" },
    },
    strict: true,
  });

  const primary = values.primary ?? DEFAULT_PRIMARY;
  if (!isAgentId(primary)) throw new Error(`--primary must be one of: ${AGENT_IDS.join(", ")}`);

  const models: Partial<Record<AgentId, string>> = {};
  if (values["claude-model"]) models.claude = values["claude-model"];
  if (values["codex-model"]) models.codex = values["codex-model"];

  return { ...(values.project ? { project: values.project } : {}), primary, models };
};
