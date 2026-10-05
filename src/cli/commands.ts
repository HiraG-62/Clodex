// スラッシュコマンドの一覧（DESIGN.md §8）。/help・サジェスト・Tab 補完で共有する
import { t } from "../i18n/i18n.js";
import type { MessageKey } from "../i18n/messages.js";

// 画面に出す形（説明は今の言語の文言）
export interface SlashCommand {
  name: string;
  args: string;
  description: string;
}

interface SlashCommandSpec {
  name: string;
  args: string;
  description: MessageKey;
}

const SPECS: readonly SlashCommandSpec[] = [
  { name: "interrupt", args: "[agent]", description: "cmd.interrupt" },
  { name: "cancel", args: "[id]", description: "cmd.cancel" },
  { name: "status", args: "", description: "cmd.status" },
  { name: "primary", args: "<agent>", description: "cmd.primary" },
  { name: "resume", args: "[number]", description: "cmd.resume" },
  { name: "rename", args: "<title>", description: "cmd.rename" },
  { name: "delete", args: "<number>", description: "cmd.delete" },
  { name: "pin", args: "<number>", description: "cmd.pin" },
  { name: "new", args: "[worktree|agent]", description: "cmd.new" },
  { name: "compact", args: "[agent]", description: "cmd.compact" },
  { name: "permission", args: "[agent] <read-only|edit|full>", description: "cmd.permission" },
  { name: "model", args: "<agent> <model>", description: "cmd.model" },
  { name: "effort", args: "[agent] <level>", description: "cmd.effort" },
  { name: "verbose", args: "", description: "cmd.verbose" },
  { name: "help", args: "", description: "cmd.help" },
  { name: "exit", args: "", description: "cmd.exit" },
];

// 言語は起動時に決まるので、呼ぶたびに文言を引く
export const slashCommands = (): SlashCommand[] => SPECS.map((spec) => ({ ...spec, description: t(spec.description) }));
export const SLASH_COMMAND_NAMES: readonly string[] = SPECS.map(({ name }) => name);

export const commandUsage = ({ name, args }: Pick<SlashCommand, "name" | "args">): string => `/${name}${args ? ` ${args}` : ""}`;

// readline の completer。コマンド名の入力中だけ補完する
export const completeCommand = (line: string): [string[], string] => {
  if (!/^\/\S*$/.test(line)) return [[], line];
  const hits = SLASH_COMMAND_NAMES.map((name) => `/${name} `).filter((candidate) => candidate.startsWith(line));
  return [hits, line];
};
