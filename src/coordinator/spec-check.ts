import { createCommandExecutor } from "../cli/command-runner.js";
import type { SpecCheckResult } from "../protocol/messages.js";

export const SPEC_CHECK_TIMEOUT_MS = 60_000;
const OUTPUT_LINES = 20;
const OUTPUT_CHARACTERS = 2_000;

export const runSpecCheck = (template: string, spec: string, root: string, execute = createCommandExecutor({})): Promise<SpecCheckResult> => {
  const command = template.replaceAll("{spec}", `'${spec.replaceAll("'", "''")}'`);
  return new Promise(resolve => {
    const lines: string[] = [];
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const print = (line: string) => {
      lines.push(line.slice(-OUTPUT_CHARACTERS));
      if (lines.length > OUTPUT_LINES) lines.shift();
    };
    const finish = (result: Omit<SpecCheckResult, "command" | "output">) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ command, ...result, output: lines.join("\n").slice(-OUTPUT_CHARACTERS) });
    };
    const process = execute(command, root, print, result => {
      if (result.error) print(result.error);
      finish({ ...(result.code !== null ? { exitCode: result.code } : {}) });
    });
    if (!finished)
      timer = setTimeout(() => {
        finish({ timedOut: true });
        process.stop();
      }, SPEC_CHECK_TIMEOUT_MS);
  });
};
