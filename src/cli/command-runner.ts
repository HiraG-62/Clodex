// !command: project root で shell command を実行し、出力を表示する（DESIGN.md §8、docs/spikes/shell-command.md）
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

// pwsh が無ければ Windows PowerShell 5.1
const SHELLS = ["pwsh", "powershell"] as const;
const SHELL_ARGS = ["-NoProfile", "-NonInteractive", "-Command"];
// 既定では PowerShell の文字列が CP932 で出て文字化けする
export const UTF8_PREFIX = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; ";
// -Command は native command の失敗を終了コード 1 に丸めるので、実際の終了コードを返す
export const EXIT_CODE_SUFFIX = "\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }";
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[A-Za-z]/g;
const LINE_BREAK = /\r?\n/;
const MS_PER_SECOND = 1000;

export interface CommandProcess {
  readonly pid?: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
}

export interface CommandRunnerOptions {
  cwd: string;
  print: (line: string) => void;
  spawnShell?: (file: string, args: string[], cwd: string) => CommandProcess;
  // 子プロセスごと止める（child.kill だけではシェルの子が残る）
  killTree?: (pid: number) => void;
  now?: () => number;
}

const defaultSpawnShell = (file: string, args: string[], cwd: string): CommandProcess =>
  spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

const defaultKillTree = (pid: number) => {
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
};

// chunk の途中で切れた文字・行は次の chunk とつなげ、終了時に残りを出す
const lineSplitter = (print: (line: string) => void) => {
  const decoder = new StringDecoder("utf8");
  let rest = "";
  const emit = (line: string) => print(line.replace(ANSI_ESCAPE, ""));
  return {
    write: (chunk: Buffer) => {
      const lines = (rest + decoder.write(chunk)).split(LINE_BREAK);
      rest = lines.pop() ?? "";
      lines.forEach(emit);
    },
    end: () => {
      const last = rest + decoder.end();
      if (last) emit(last);
      rest = "";
    },
  };
};

export const createCommandRunner = ({
  cwd, print, spawnShell = defaultSpawnShell, killTree = defaultKillTree, now = Date.now,
}: CommandRunnerOptions) => {
  let shellIndex = 0;
  const running = new Map<CommandProcess, { stopped: boolean; failed: boolean }>();

  const elapsed = (startedAt: number) => `${((now() - startedAt) / MS_PER_SECOND).toFixed(1)}s`;

  const start = (command: string, startedAt: number, resolve: () => void, index = shellIndex) => {
    const child = spawnShell(SHELLS[index]!, [...SHELL_ARGS, `${UTF8_PREFIX}${command}${EXIT_CODE_SUFFIX}`], cwd);
    const entry = { stopped: false, failed: false };
    running.set(child, entry);
    const out = lineSplitter(print);
    const err = lineSplitter(print);
    child.stdout.on("data", out.write);
    child.stderr.on("data", err.write);
    child.on("error", (error) => {
      // 起動の失敗では error の後に close も来る。close は無視する
      entry.failed = true;
      running.delete(child);
      // 同時に実行した command が同じシェルで失敗しても、次のシェルを飛ばさない
      if (error.code === "ENOENT" && index < SHELLS.length - 1) {
        shellIndex = Math.max(shellIndex, index + 1);
        return start(command, startedAt, resolve, index + 1);
      }
      print(`error: ${error.message}`);
      resolve();
    });
    child.on("close", (code) => {
      if (entry.failed) return;
      running.delete(child);
      out.end();
      err.end();
      print(entry.stopped ? `stopped (${elapsed(startedAt)})` : `exit ${code} (${elapsed(startedAt)})`);
      resolve();
    });
  };

  // 終了（または起動の失敗）で resolve する。reject しない
  const run = (command: string): Promise<void> => {
    print(`$ ${command}`);
    return new Promise((resolve) => start(command, now(), resolve));
  };

  const stopAll = (): number => {
    let stopped = 0;
    for (const [child, entry] of running) {
      if (entry.stopped || child.pid === undefined) continue;
      entry.stopped = true;
      killTree(child.pid);
      stopped++;
    }
    return stopped;
  };

  return {
    run,
    stopAll,
    get running() {
      return running.size;
    },
  };
};
