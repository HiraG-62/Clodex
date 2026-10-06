import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let hooks: string | undefined;
export function safeGitArgs(args: readonly string[]): string[] {
  hooks ??= mkdtempSync(join(tmpdir(), "clodex-empty-hooks-"));
  const [command, ...rest] = args;
  if (!command) throw new Error("git command が必要");
  const diffOptions = ["diff", "show", "log"].includes(command) ? ["--no-ext-diff", "--no-textconv"] : [];
  return ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${hooks}`, command, ...diffOptions, ...rest];
}
