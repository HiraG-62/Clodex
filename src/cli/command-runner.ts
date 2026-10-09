// !command: project root で shell command を実行し、出力を表示する（DESIGN.md §8、docs/spikes/shell-command.md）
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { killProcessTree } from "../process/kill-tree.js";

// pwsh が無ければ Windows PowerShell 5.1
const SHELLS = ["pwsh", "powershell"] as const;
const SHELL_ARGS = ["-NoProfile", "-NonInteractive", "-Command"];
// 既定では PowerShell の文字列が CP932 で出て文字化けする
export const UTF8_PREFIX = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; ";
// -Command は native command の失敗を終了コード 1 に丸めるので、実際の終了コードを返す
export const EXIT_CODE_SUFFIX = "\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }";
// command をそのまま埋め込むと、構文エラーが UTF-8 にする前に出て化ける。UTF-8 にした後で構文解析させる。
// 終了コードの 1 行は scriptblock の中にも入れる（外だけでは dot-source の後の $? が常に真になる）。外の 1 行は構文エラーのとき
const shellScript = (command: string): string => {
  const encoded = Buffer.from(`${command}${EXIT_CODE_SUFFIX}`, "utf8").toString("base64");
  return `${UTF8_PREFIX}. ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))))${EXIT_CODE_SUFFIX}`;
};
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[A-Za-z]/g;
const LINE_BREAK = /\r?\n/;
const MS_PER_SECOND = 1000;
// !> で Agent に渡す出力の元。終わらないコマンドでも際限なく溜めない
const KEPT_OUTPUT_LINES = 1000;

export interface CommandResult {
  code: number | null;
  stopped: boolean;
  error?: string;
  // 出力の末尾の行。KEPT_OUTPUT_LINES を超えた分は捨て、その数を droppedLines に入れる
  output: string[];
  droppedLines?: number;
}

export interface CommandProcess {
  readonly pid?: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
}

export interface CommandRunnerOptions {
  // 関数なら実行のたびに呼ぶ（今の会話の作業場所。DESIGN.md §28 D1）
  cwd: string | (() => string);
  print: (line: string, command?: CommandLifecycle) => void;
  spawnShell?: (file: string, args: string[], cwd: string) => CommandProcess;
  // 子プロセスごと止める（child.kill だけではシェルの子が残る）
  killTree?: (pid: number) => void;
  now?: () => number;
}

export interface CommandLifecycle {
  id: number;
  phase: "start" | "exit";
}

const defaultSpawnShell = (file: string, args: string[], cwd: string): CommandProcess =>
  spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

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

export interface CommandCompletion {
  code: number | null;
  stopped: boolean;
  error?: string;
}

export const createCommandExecutor = ({
  spawnShell = defaultSpawnShell,
  killTree = killProcessTree,
}: Pick<CommandRunnerOptions, "spawnShell" | "killTree">) => {
  let shellIndex = 0;
  return (command: string, cwd: string, print: (line: string) => void, complete: (result: CommandCompletion) => void) => {
    let child: CommandProcess | undefined;
    let stopped = false;
    let finished = false;
    const finish = (result: CommandCompletion) => {
      if (finished) return;
      finished = true;
      complete(result);
    };
    const start = (index: number) => {
      let failed = false;
      const onError = (error: NodeJS.ErrnoException) => {
        // 起動の失敗では error の後に close も来る。close は無視する
        failed = true;
        // 同時に実行した command が同じシェルで失敗しても、次のシェルを飛ばさない
        if (!stopped && error.code === "ENOENT" && index < SHELLS.length - 1) {
          shellIndex = Math.max(shellIndex, index + 1);
          start(index + 1);
          return;
        }
        finish({ code: null, stopped, error: error.message });
      };
      try {
        child = spawnShell(SHELLS[index]!, [...SHELL_ARGS, shellScript(command)], cwd);
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const out = lineSplitter(print);
      const err = lineSplitter(print);
      child.stdout.on("data", out.write);
      child.stderr.on("data", err.write);
      child.on("error", onError);
      child.on("close", code => {
        if (failed) return;
        out.end();
        err.end();
        finish({ code, stopped });
      });
    };
    start(shellIndex);
    return {
      get running() {
        return !finished;
      },
      stop: () => {
        if (finished || stopped) return false;
        stopped = true;
        if (child?.pid !== undefined) killTree(child.pid);
        return true;
      },
    };
  };
};

export const createCommandRunner = ({ cwd, print, now = Date.now, ...options }: CommandRunnerOptions) => {
  const execute = createCommandExecutor(options);
  const running = new Set<ReturnType<typeof execute>>();
  const pending = new Set<Promise<CommandResult>>();
  let nextId = 1;

  // 終了（または起動の失敗）で resolve する。reject しない
  const run = (command: string): Promise<CommandResult> => {
    const id = nextId++;
    print(`$ ${command}`, { id, phase: "start" });
    const startedAt = now();
    const output: string[] = [];
    let droppedLines = 0;
    const record = (line: string) => {
      output.push(line);
      if (output.length > KEPT_OUTPUT_LINES) {
        output.shift();
        droppedLines++;
      }
      print(line);
    };
    const result = new Promise<CommandResult>(resolve => {
      const handle = execute(command, typeof cwd === "function" ? cwd() : cwd, record, ({ code, stopped, error }) => {
        for (const entry of running) if (!entry.running) running.delete(entry);
        const elapsed = `${((now() - startedAt) / MS_PER_SECOND).toFixed(1)}s`;
        print(error ? `error: ${error}` : stopped ? `stopped (${elapsed})` : `exit ${code} (${elapsed})`, { id, phase: "exit" });
        resolve({ code, stopped, ...(error ? { error } : {}), output, ...(droppedLines ? { droppedLines } : {}) });
      });
      if (handle.running) running.add(handle);
    });
    pending.add(result);
    void result.then(() => pending.delete(result));
    return result;
  };

  const stopAll = (): number => {
    let stopped = 0;
    for (const entry of running) if (entry.stop()) stopped++;
    return stopped;
  };

  return {
    run,
    stopAll,
    idle: async (): Promise<void> => {
      await Promise.all(pending);
    },
    get running() {
      return running.size;
    },
  };
};
