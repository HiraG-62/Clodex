// スラッシュコマンドの一覧（DESIGN.md §8）。/help・サジェスト・Tab 補完で共有する
export interface SlashCommand {
  name: string;
  args: string;
  description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "interrupt", args: "[agent]", description: "interrupt the running turn (all agents, !commands and agent-to-agent exchanges if omitted)" },
  { name: "cancel", args: "[id]", description: "cancel a queued input that has not been delivered (the latest if id is omitted)" },
  { name: "status", args: "", description: "show agent status and usage" },
  { name: "primary", args: "<agent>", description: "change where plain text goes" },
  { name: "resume", args: "[number]", description: "list past conversations, or switch to one" },
  { name: "new", args: "[agent]", description: "start fresh sessions (a new conversation if agent is omitted)" },
  { name: "compact", args: "[agent]", description: "summarize the conversation to reduce context (running agents if omitted)" },
  { name: "permission", args: "[agent] <read-only|edit|full>", description: "change what agents may do without asking" },
  { name: "model", args: "<agent> <model>", description: "change an agent's model" },
  { name: "effort", args: "[agent] <level>", description: "change reasoning effort" },
  { name: "verbose", args: "", description: "toggle detailed output (tools, usage, intermediate text)" },
  { name: "help", args: "", description: "show this help" },
  { name: "exit", args: "", description: "stop all agents and quit" },
];

export const commandUsage = ({ name, args }: SlashCommand): string => `/${name}${args ? ` ${args}` : ""}`;

// readline の completer。コマンド名の入力中だけ補完する
export const completeCommand = (line: string): [string[], string] => {
  if (!/^\/\S*$/.test(line)) return [[], line];
  const hits = SLASH_COMMANDS.map(({ name }) => `/${name} `).filter((candidate) => candidate.startsWith(line));
  return [hits, line];
};
