// 起動オプション（DESIGN.md §7）
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { AGENT_IDS, isAgentId, type AgentId } from "../agents/agent-adapter.js";

export interface CliArgs {
  project?: string;
  primary?: AgentId;
  models: Partial<Record<AgentId, string>>;
  resume: boolean;
  web: boolean;
  serve: boolean;
}

export const parseCliArgs = (argv: string[]): CliArgs => {
  const serve = argv[0] === "serve";
  const { values } = parseArgs({
    args: serve ? argv.slice(1) : argv,
    options: {
      project: { type: "string" },
      primary: { type: "string" },
      "claude-model": { type: "string" },
      "codex-model": { type: "string" },
      resume: { type: "boolean" },
      web: { type: "boolean" },
    },
    strict: true,
  });

  const { primary } = values;
  if (primary !== undefined && !isAgentId(primary)) throw new Error(`--primary must be one of: ${AGENT_IDS.join(", ")}`);

  const models: Partial<Record<AgentId, string>> = {};
  if (values["claude-model"]) models.claude = values["claude-model"];
  if (values["codex-model"]) models.codex = values["codex-model"];

  return {
    ...(values.project ? { project: values.project } : {}), ...(primary ? { primary } : {}), models,
    resume: values.resume ?? false,
    web: serve || (values.web ?? false), serve,
  };
};

// Hub が動いているときは、起動オプションを Hub へのコマンドに変えて送る（DESIGN.md §7）
export const hubCommands = (args: CliArgs, cwd: string): { commands: string[]; ignored: string[] } => {
  const commands = [`/project ${args.project ? resolve(cwd, args.project) : cwd}`];
  if (args.primary) commands.push(`/primary ${args.primary}`);
  for (const id of AGENT_IDS) {
    const model = args.models[id];
    if (model) commands.push(`/model ${id} ${model}`);
  }
  const ignored = [...(args.resume ? ["--resume"] : []), ...(args.web ? ["--web"] : [])];
  return { commands, ignored };
};
