// !> の結果を Agent に渡す本文にする（DESIGN.md §8 `!> command`）
import { t } from "../i18n/i18n.js";
import type { CommandResult } from "./command-runner.js";

export const RESULT_MAX_LINES = 200;
export const RESULT_MAX_CHARS = 20_000;

export const commandResultMessage = (command: string, result: CommandResult): string => {
  const omittedLines = (result.droppedLines ?? 0) + Math.max(0, result.output.length - RESULT_MAX_LINES);
  const tail = result.output.slice(-RESULT_MAX_LINES).join("\n");
  const truncated = tail.length > RESULT_MAX_CHARS;
  const status = result.error ? `error: ${result.error}` : `exit ${result.code}`;
  return [
    t("command.result.header", { command, status }),
    ...(omittedLines ? [t("command.result.omitted", { count: omittedLines })] : []),
    ...(truncated ? [t("command.result.truncated", { count: RESULT_MAX_CHARS })] : []),
    "```",
    truncated ? tail.slice(-RESULT_MAX_CHARS) : tail,
    "```",
    t("command.result.instruction"),
  ].join("\n");
};
